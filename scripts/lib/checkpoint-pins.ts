/**
 * Checkpoint object versions across a backup and a restore (94S-282).
 *
 * A checkpoint names every object by S3 version (94S-229), and a version id
 * is the store's to assign: no PUT can ask for one, so a restored bucket
 * holds the same bytes under new ids. Replication would keep them, but only
 * between two live buckets; a backup is a directory. The restore therefore
 * re-pins: it finds the version each byte-identical object got in the new
 * bucket, rewrites each committed manifest with those versions under the
 * key it always had, and holds everything. See docs/backup-restore.md.
 *
 * Two passes live here, both refusing rather than guessing:
 *
 * - `captureCheckpointObjects` (backup) reads what every checkpoint row pins
 *   — at its version, not whatever the key holds now — and makes the backup
 *   directory carry those bytes. A key overwritten or delete-marked after
 *   its checkpoint committed would otherwise be backed up as the damage.
 * - `planRepin` + `applyRepin` (restore) verify every row against the
 *   restored bucket before writing anything, then write the manifests, read
 *   them back and hold every version. The caller commits the DB rows.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type {
  CheckpointCodec,
  CheckpointManifest,
  CheckpointObjectStore,
  ObjectRef,
  TranscriptRevision,
} from "@agent-platform/runtime-core";

/** One `checkpoints` row, as far as its objects are concerned. */
export type CheckpointRow = {
  readonly manifestRef: string;
  readonly manifestSha256: string;
  readonly manifestVersion: string | null;
  readonly revision: number;
  readonly sessionId: string;
};

export type Codecs = Readonly<Record<string, CheckpointCodec>>;

export class CheckpointPinError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `${problems.length} checkpoint object problem(s):\n  ${problems.join("\n  ")}`,
    );
    this.name = "CheckpointPinError";
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every object a manifest pins besides itself, in restore-plan order. */
export function refsOf(manifest: CheckpointManifest): ObjectRef[] {
  return [
    ...manifest.transcripts.root.parts,
    ...Object.keys(manifest.transcripts.subagents)
      .sort()
      .flatMap(
        (subpath) => manifest.transcripts.subagents[subpath]?.parts ?? [],
      ),
    // Bases live in the directories of the checkpoints that wrote them, and
    // this one restores only if every one of them does (94S-227).
    ...(manifest.workspace.baseBundles ?? []),
    manifest.workspace.bundle,
    ...manifest.workspace.untracked,
  ];
}

/**
 * Where a key lives under the backup's objects/ directory. Only keys that
 * map to exactly one plain path inside it are accepted: `normalize` leaves
 * a leading `..` in place, so those are refused by segment. Checkpoint keys
 * are `sessions/<id>/...` and never need more.
 */
export function backupPath(objectsDir: string, key: string): string {
  if (
    key === "" ||
    key.startsWith("/") ||
    normalize(key) !== key ||
    key.split("/").includes("..")
  ) {
    throw new CheckpointPinError([
      `object key ${JSON.stringify(key)} has no single path in a backup`,
    ]);
  }
  return join(objectsDir, key);
}

function decode(
  codecs: Codecs,
  row: CheckpointRow,
  bytes: Uint8Array,
): CheckpointManifest {
  let engine: unknown;
  try {
    engine = (
      JSON.parse(new TextDecoder().decode(bytes)) as { engine?: unknown }
    ).engine;
  } catch {
    engine = undefined;
  }
  const codec =
    typeof engine === "string" && Object.hasOwn(codecs, engine)
      ? codecs[engine]
      : undefined;
  if (codec === undefined) {
    throw new Error(`no codec for engine ${JSON.stringify(engine)}`);
  }
  const manifest = codec.decode(bytes);
  if (
    manifest.sessionId !== row.sessionId ||
    manifest.revision !== row.revision
  ) {
    throw new Error(
      `manifest is sealed for ${manifest.sessionId}@${manifest.revision}`,
    );
  }
  return manifest;
}

const label = (row: CheckpointRow) => `${row.sessionId}@${row.revision}`;

/**
 * One key must mean one byte string across every row: the backup keeps a
 * single file per key and the restored bucket a single current version.
 */
class Inventory {
  readonly #byKey = new Map<string, { bytes: number; sha256: string }>();

  constructor(private readonly problems: string[]) {}

  /** False when the key was already claimed with other bytes. */
  claim(owner: string, key: string, sha256: string, bytes: number): boolean {
    const seen = this.#byKey.get(key);
    if (seen === undefined) {
      this.#byKey.set(key, { bytes, sha256 });
      return true;
    }
    if (seen.sha256 === sha256 && seen.bytes === bytes) return true;
    this.problems.push(
      `${owner}: ${key} is pinned as ${sha256} here and as ${seen.sha256} by another checkpoint`,
    );
    return false;
  }
}

/**
 * A manifest key excluded from the restore sync must not also be an object
 * some checkpoint pins: validation lets a manifest name any key in its
 * session, including another checkpoint's manifest.
 */
function checkManifestKeysArePrivate(
  manifests: ReadonlyMap<string, string>,
  refs: Iterable<readonly [owner: string, key: string]>,
  problems: string[],
) {
  for (const [owner, key] of refs) {
    const manifestOf = manifests.get(key);
    if (manifestOf !== undefined) {
      problems.push(
        `${owner}: pins ${key}, which is the manifest of ${manifestOf}; a backup cannot re-pin a manifest another checkpoint depends on`,
      );
    }
  }
}

async function readIfPresent(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeAtomically(path: string, bytes: Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  const staged = `${path}.pinned-${process.pid}`;
  await writeFile(staged, bytes, { mode: 0o600 });
  await rename(staged, path);
}

/**
 * Backup side: makes `objectsDir` (already filled by a current-version sync)
 * carry, for every key a checkpoint row pins, exactly the pinned bytes.
 * Returns the keys whose file was replaced or added; the caller warns.
 *
 * Reads each manifest at the row's `manifest_version` and each ref at its
 * `version` (by key where either is absent: a row committed `unversioned`).
 * Throws `CheckpointPinError` listing every row that cannot be backed up
 * whole — missing version, bytes that do not hash, one key pinned with two
 * contents, or a manifest key another checkpoint pins — since a backup that
 * silently lost a checkpoint only fails at restore.
 */
export async function captureCheckpointObjects(input: {
  codecs: Codecs;
  objects: CheckpointObjectStore;
  objectsDir: string;
  rows: readonly CheckpointRow[];
}): Promise<{ replaced: string[] }> {
  const { codecs, objects, objectsDir, rows } = input;
  const problems: string[] = [];
  const inventory = new Inventory(problems);
  const manifests = new Map<string, string>();
  const pinnedRefs: Array<readonly [string, string]> = [];
  const replaced: string[] = [];
  const fetched = new Set<string>();

  async function keep(key: string, bytes: Uint8Array) {
    const path = backupPath(objectsDir, key);
    const onDisk = await readIfPresent(path);
    if (onDisk !== undefined && sha256Hex(onDisk) === sha256Hex(bytes)) return;
    await writeAtomically(path, bytes);
    replaced.push(key);
  }

  for (const row of rows) {
    const owner = label(row);
    try {
      const bytes = await objects.get(
        row.manifestRef,
        row.manifestVersion ?? undefined,
      );
      if (bytes === undefined) {
        problems.push(
          `${owner}: manifest ${row.manifestRef}${versionSuffix(row.manifestVersion)} is missing`,
        );
        continue;
      }
      if (sha256Hex(bytes) !== row.manifestSha256) {
        problems.push(
          `${owner}: manifest ${row.manifestRef} hashes to ${sha256Hex(bytes)}, the row says ${row.manifestSha256}`,
        );
        continue;
      }
      const manifest = decode(codecs, row, bytes);
      manifests.set(row.manifestRef, owner);
      if (
        !inventory.claim(
          owner,
          row.manifestRef,
          row.manifestSha256,
          bytes.byteLength,
        )
      ) {
        continue;
      }
      await keep(row.manifestRef, bytes);
      for (const ref of refsOf(manifest)) {
        pinnedRefs.push([owner, ref.key]);
        if (!inventory.claim(owner, ref.key, ref.sha256, ref.bytes)) continue;
        const token = `${ref.key}\u0000${ref.version ?? ""}`;
        if (fetched.has(token)) continue;
        fetched.add(token);
        const content = await objects.get(ref.key, ref.version);
        if (content === undefined) {
          problems.push(
            `${owner}: ${ref.key}${versionSuffix(ref.version)} is missing`,
          );
          continue;
        }
        const found = sha256Hex(content);
        if (found !== ref.sha256 || content.byteLength !== ref.bytes) {
          problems.push(
            `${owner}: ${ref.key}${versionSuffix(ref.version)} is ${content.byteLength} bytes hashing to ${found}; the manifest says ${ref.bytes} bytes, ${ref.sha256}`,
          );
          continue;
        }
        await keep(ref.key, content);
      }
    } catch (error) {
      if (error instanceof CheckpointPinError) {
        problems.push(
          ...error.problems.map((problem) => `${owner}: ${problem}`),
        );
      } else {
        problems.push(`${owner}: ${(error as Error).message}`);
      }
    }
  }
  checkManifestKeysArePrivate(manifests, pinnedRefs, problems);
  if (problems.length > 0) throw new CheckpointPinError(problems);
  return { replaced: [...new Set(replaced)].sort() };
}

function versionSuffix(version: string | null | undefined) {
  return version == null ? "" : ` (version ${version})`;
}

/** One row's manifest, re-pinned to the restored bucket, not yet written. */
export type RepinnedCheckpoint = {
  readonly manifest: CheckpointManifest;
  readonly manifestBytes: Uint8Array;
  readonly manifestSha256: string;
  readonly row: CheckpointRow;
};

/**
 * Restore side, read-only: for every row, the backup's manifest (it must
 * hash to the row) with each ref's `version` replaced by the version the
 * restored bucket holds those exact bytes under. Nothing is written, so a
 * refusal leaves the bucket as the sync left it.
 *
 * The manifest keys themselves must be absent from the bucket — the restore
 * leaves them out of the sync so each can be created once, re-pinned, at the
 * key `manifestRefFor` gives it.
 */
export async function planRepin(input: {
  codecs: Codecs;
  objects: CheckpointObjectStore;
  objectsDir: string;
  rows: readonly CheckpointRow[];
}): Promise<RepinnedCheckpoint[]> {
  const { codecs, objects, objectsDir, rows } = input;
  const problems: string[] = [];
  const inventory = new Inventory(problems);
  const manifests = new Map<string, string>();
  const pinnedRefs: Array<readonly [string, string]> = [];
  // A key read once is the same current version for every row that pins it.
  const versions = new Map<string, string | undefined>();
  const planned: RepinnedCheckpoint[] = [];

  async function restoredVersion(
    owner: string,
    ref: ObjectRef,
  ): Promise<string | undefined> {
    if (versions.has(ref.key)) return versions.get(ref.key);
    let version: string | undefined;
    const head = await objects.head(ref.key);
    if (head === undefined) {
      problems.push(`${owner}: ${ref.key} is not in the restored bucket`);
    } else if (head.version === undefined) {
      problems.push(
        `${owner}: ${ref.key} has no version in the restored bucket; it needs versioning and Object Lock`,
      );
    } else {
      const bytes = await objects.get(ref.key, head.version);
      const found = bytes === undefined ? undefined : sha256Hex(bytes);
      if (
        bytes === undefined ||
        found !== ref.sha256 ||
        bytes.byteLength !== ref.bytes
      ) {
        problems.push(
          `${owner}: ${ref.key} (version ${head.version}) does not match the manifest (${ref.bytes} bytes, ${ref.sha256})`,
        );
      } else {
        version = head.version;
      }
    }
    versions.set(ref.key, version);
    return version;
  }

  for (const row of rows) {
    const owner = label(row);
    try {
      const bytes = await readIfPresent(
        backupPath(objectsDir, row.manifestRef),
      );
      if (bytes === undefined) {
        problems.push(`${owner}: backup has no manifest ${row.manifestRef}`);
        continue;
      }
      if (sha256Hex(bytes) !== row.manifestSha256) {
        problems.push(
          `${owner}: backup manifest ${row.manifestRef} hashes to ${sha256Hex(bytes)}, the row says ${row.manifestSha256}`,
        );
        continue;
      }
      const manifest = decode(codecs, row, bytes);
      manifests.set(row.manifestRef, owner);
      if (await objects.head(row.manifestRef)) {
        problems.push(
          `${owner}: ${row.manifestRef} already exists in the restored bucket; the re-pinned manifest must be its first write`,
        );
        continue;
      }
      let complete = true;
      const pin = async <T extends ObjectRef>(ref: T): Promise<T> => {
        pinnedRefs.push([owner, ref.key]);
        if (!inventory.claim(owner, ref.key, ref.sha256, ref.bytes)) {
          complete = false;
          return ref;
        }
        const version = await restoredVersion(owner, ref);
        if (version === undefined) {
          complete = false;
          return ref;
        }
        return { ...ref, version };
      };
      const pinRevision = async (
        revision: TranscriptRevision,
      ): Promise<TranscriptRevision> => ({
        ...revision,
        parts: await sequential(revision.parts, pin),
      });
      const subagents: Record<string, TranscriptRevision> = {};
      for (const subpath of Object.keys(
        manifest.transcripts.subagents,
      ).sort()) {
        const revision = manifest.transcripts.subagents[subpath];
        if (revision !== undefined)
          subagents[subpath] = await pinRevision(revision);
      }
      const repinned: CheckpointManifest = {
        ...manifest,
        transcripts: {
          root: await pinRevision(manifest.transcripts.root),
          subagents,
        },
        workspace: {
          ...manifest.workspace,
          ...(manifest.workspace.baseBundles === undefined
            ? {}
            : {
                baseBundles: await sequential(
                  manifest.workspace.baseBundles,
                  pin,
                ),
              }),
          bundle: await pin(manifest.workspace.bundle),
          untracked: await sequential(manifest.workspace.untracked, pin),
        },
      };
      if (!complete) continue;
      const codec = codecs[manifest.engine];
      if (codec === undefined)
        throw new Error(`no codec for ${manifest.engine}`);
      const sealed = codec.encode(repinned);
      // The codec must read its own output back as the same checkpoint, or
      // the restored API would refuse what this wrote.
      decode(codecs, row, sealed.bytes);
      planned.push({
        manifest: repinned,
        manifestBytes: sealed.bytes,
        manifestSha256: sealed.sha256,
        row,
      });
    } catch (error) {
      if (error instanceof CheckpointPinError) {
        problems.push(
          ...error.problems.map((problem) => `${owner}: ${problem}`),
        );
      } else {
        problems.push(`${owner}: ${(error as Error).message}`);
      }
    }
  }
  checkManifestKeysArePrivate(manifests, pinnedRefs, problems);
  if (problems.length > 0) throw new CheckpointPinError(problems);
  return planned;
}

async function sequential<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await map(item));
  return out;
}

/** What the caller writes to the row once every checkpoint is applied. */
export type RepinnedRow = {
  readonly manifestSha256: string;
  readonly manifestVersion: string;
  readonly previousSha256: string;
  readonly revision: number;
  readonly sessionId: string;
};

/**
 * Restore side, writing: creates each re-pinned manifest at its key, reads it
 * back by the version the store answered, and holds every version the
 * checkpoint names. Only after all of that may the row say
 * `versions_held` — the same claim a locked finalize makes, backed by the
 * same work. Throws on the first failure; the caller must then abandon the
 * target, since neither uploads nor holds can be undone.
 */
export async function applyRepin(input: {
  objects: CheckpointObjectStore;
  planned: readonly RepinnedCheckpoint[];
}): Promise<RepinnedRow[]> {
  const { objects, planned } = input;
  const hold = objects.hold?.bind(objects);
  if (hold === undefined) {
    throw new Error("the restored object store cannot hold versions");
  }
  const held = new Set<string>();
  const holdOnce = async (key: string, version: string) => {
    const token = `${key}\u0000${version}`;
    if (held.has(token)) return;
    await hold(key, version);
    held.add(token);
  };
  const rows: RepinnedRow[] = [];
  for (const checkpoint of planned) {
    const { row } = checkpoint;
    const put = await objects.putImmutable(
      row.manifestRef,
      checkpoint.manifestBytes,
    );
    if (put.outcome !== "created" || put.version === undefined) {
      throw new Error(
        `${label(row)}: writing ${row.manifestRef} answered ${put.outcome}${put.outcome === "conflict" ? "" : put.version === undefined ? " without a version" : ""}`,
      );
    }
    const readBack = await objects.get(row.manifestRef, put.version);
    if (
      readBack === undefined ||
      sha256Hex(readBack) !== checkpoint.manifestSha256
    ) {
      throw new Error(
        `${label(row)}: ${row.manifestRef} (version ${put.version}) does not read back as written`,
      );
    }
    for (const ref of refsOf(checkpoint.manifest)) {
      if (ref.version === undefined) {
        throw new Error(`${label(row)}: ${ref.key} was left without a version`);
      }
      await holdOnce(ref.key, ref.version);
    }
    await holdOnce(row.manifestRef, put.version);
    rows.push({
      manifestSha256: checkpoint.manifestSha256,
      manifestVersion: put.version,
      previousSha256: row.manifestSha256,
      revision: row.revision,
      sessionId: row.sessionId,
    });
  }
  return rows;
}
