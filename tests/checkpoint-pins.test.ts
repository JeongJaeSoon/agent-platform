import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  type CheckpointPointer,
  createCheckpointService,
  manifestRefFor,
} from "@agent-platform/platform";
import {
  CLAUDE_RUNTIME_FINGERPRINT,
  ClaudeSessionStore,
  claudeCheckpointCodec,
} from "@agent-platform/runtime-claude";
import type {
  CheckpointManifest,
  ObjectRef,
  TranscriptRevision,
} from "@agent-platform/runtime-core";
import { createGitWorkspaceBundleVerifier } from "@agent-platform/storage";
import {
  createMemoryCheckpointObjectStore,
  type MemoryCheckpointObjectStore,
} from "@agent-platform/testkit/checkpoint-objects";
import {
  createGitBundle,
  createGitBundleChain,
  type GitBundleFixture,
} from "@agent-platform/testkit/git-bundle";
import {
  applyRepin,
  CheckpointPinError,
  type CheckpointRow,
  captureCheckpointObjects,
  describeMismatches,
  parseImageRuntime,
  planRepin,
  planRuntime,
  refsOf,
  sha256Hex,
} from "../scripts/lib/checkpoint-pins.ts";

/**
 * The checkpoint half of scripts/backup.sh → restore.sh (94S-282), against
 * in-memory versioned stores standing in for the source and the restored
 * bucket, and a directory standing in for the backup's objects/. The compose
 * round trip itself is the E2E recorded on the PR.
 */

const codecs = { [claudeCheckpointCodec.engine]: claudeCheckpointCodec };

const publishId = () => randomUUID().replaceAll("-", "");

type Seeded = { manifest: CheckpointManifest; row: CheckpointRow };

/** One committed checkpoint as a locked finalize leaves it (seed-checkpoint.ts). */
async function seed(
  objects: MemoryCheckpointObjectStore,
  untracked: readonly { path: string; text: string }[] = [],
  workspaceBundle?: GitBundleFixture,
): Promise<Seeded> {
  const sessionId = randomUUID();
  const attemptId = `attempt-${randomUUID().slice(0, 8)}`;
  const engineSession = `sdk-${sessionId.slice(0, 8)}`;
  const mirror = new ClaudeSessionStore({
    generation: 1,
    objects,
    prefix: `sessions/${sessionId}/mirror`,
  });
  const root = { projectKey: "-workspace", sessionId: engineSession };
  await mirror.append(root, [
    { type: "user", uuid: randomUUID(), message: { content: "hi" } },
  ]);
  await mirror.append({ ...root, subpath: "agents/a" }, [
    { type: "user", uuid: randomUUID(), message: { content: "sub" } },
  ]);
  const captured = await mirror.captureTranscripts(engineSession);
  if (captured === null) throw new Error("not captured");
  const withVersion = async <T extends ObjectRef>(ref: T): Promise<T> => ({
    ...ref,
    version: (await objects.head(ref.key))?.version,
  });
  const pin = async (revision: TranscriptRevision) => ({
    ...revision,
    parts: await Promise.all(revision.parts.map(withVersion)),
  });
  const manifestRef = manifestRefFor(sessionId, 0, attemptId, publishId());
  const prefix = manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1);
  const bundle =
    workspaceBundle ?? (await createGitBundle({ message: sessionId }));
  const bundlePut = await objects.putImmutable(
    `${prefix}workspace.bundle`,
    bundle.bytes,
  );
  const files = [];
  for (const file of untracked) {
    const bytes = new TextEncoder().encode(file.text);
    const key = `${prefix}untracked/${file.path}`;
    const put = await objects.putImmutable(key, bytes);
    files.push({
      bytes: bytes.byteLength,
      key,
      path: file.path,
      sha256: sha256Hex(bytes),
      ...(put.outcome === "created" ? { version: put.version } : {}),
    });
  }
  const manifest: CheckpointManifest = {
    createdAt: new Date(0).toISOString(),
    cwd: "/workspace",
    engine: "claude",
    resume: engineSession,
    revision: 0,
    runtime: { ...CLAUDE_RUNTIME_FINGERPRINT, profileSha256: "0".repeat(64) },
    sessionId,
    transcripts: {
      root: await pin(captured.root),
      subagents: Object.fromEntries(
        await Promise.all(
          Object.entries(captured.subagents).map(
            async ([subpath, revision]) => [subpath, await pin(revision)],
          ),
        ),
      ),
    },
    version: 2,
    workspace: {
      bundle: {
        bytes: bundle.bytes.byteLength,
        key: `${prefix}workspace.bundle`,
        sha256: bundle.sha256,
        ...(bundlePut.outcome === "created"
          ? { version: bundlePut.version }
          : {}),
      },
      gitCommit: bundle.commit,
      untracked: files,
    },
  };
  const sealed = claudeCheckpointCodec.encode(manifest);
  const put = await objects.putImmutable(manifestRef, sealed.bytes);
  if (put.outcome !== "created" || put.version === undefined) {
    throw new Error("manifest not created");
  }
  return {
    manifest,
    row: {
      manifestRef,
      manifestSha256: sealed.sha256,
      manifestVersion: put.version,
      revision: 0,
      sessionId,
    },
  };
}

/** `aws s3 sync s3://bucket dir`: every key's current bytes. */
async function syncDown(objects: MemoryCheckpointObjectStore, dir: string) {
  for (const key of objects.keys()) {
    const bytes = await objects.get(key);
    if (bytes === undefined) continue;
    const path = join(dir, key);
    await Bun.write(path, bytes);
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** `aws s3 sync dir s3://bucket`, minus what restore.sh leaves out. */
async function syncUp(
  dir: string,
  objects: MemoryCheckpointObjectStore,
  exclude: ReadonlySet<string>,
) {
  for (const key of await filesUnder(dir)) {
    if (exclude.has(key)) continue;
    await objects.put(key, new Uint8Array(await readFile(join(dir, key))));
  }
}

/** A restored bucket whose version ids cannot coincide with the source's. */
async function restoredBucket() {
  const objects = createMemoryCheckpointObjectStore({ versioned: true });
  for (let i = 0; i < 50; i += 1) {
    await objects.put(`filler/${i}`, new Uint8Array([i]));
  }
  return objects;
}

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "checkpoint-pins-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

function pointerOf(row: {
  manifestRef: string;
  manifestSha256: string;
  manifestVersion: string;
  revision?: number;
}): CheckpointPointer {
  return {
    committedAt: new Date(0),
    manifestRef: row.manifestRef,
    manifestSha256: row.manifestSha256,
    manifestVersion: row.manifestVersion,
    revision: row.revision ?? 0,
    turnId: null,
    versionsHeld: true,
  };
}

async function restorePlan(
  objects: MemoryCheckpointObjectStore,
  pointer: CheckpointPointer,
  seeded: Seeded,
  runtime = seeded.manifest.runtime,
) {
  const service = createCheckpointService({
    codecs,
    objectProtection: "locked",
    objects,
    store: {
      commitAtomic: () => {
        throw new Error("restore does not commit");
      },
      listCheckpoints: async () => [],
      readPointer: async () => pointer,
    },
    workspaceBundles: createGitWorkspaceBundleVerifier(),
  });
  return service.getRestorePlan({
    runtime,
    sessionId: seeded.row.sessionId,
  });
}

describe("backup → restore re-pin", () => {
  test("the restored checkpoint is ready under locked, on new versions, all held", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const seeded = await seed(source, [{ path: "notes.txt", text: "n" }]);
      await syncDown(source, dir);
      const capture = await captureCheckpointObjects({
        codecs,
        objects: source,
        objectsDir: dir,
        rows: [seeded.row],
      });
      expect(capture.replaced).toEqual([]);

      const restored = await restoredBucket();
      await syncUp(dir, restored, new Set([seeded.row.manifestRef]));
      const planned = await planRepin({
        codecs,
        objects: restored,
        objectsDir: dir,
        rows: [seeded.row],
      });
      const [row] = await applyRepin({ objects: restored, planned });
      if (row === undefined) throw new Error("no row");
      expect(row.previousSha256).toBe(seeded.row.manifestSha256);
      expect(row.manifestSha256).not.toBe(seeded.row.manifestSha256);

      const bytes = await restored.get(
        seeded.row.manifestRef,
        row.manifestVersion,
      );
      if (bytes === undefined) throw new Error("manifest not written");
      expect(sha256Hex(bytes)).toBe(row.manifestSha256);
      const manifest = claudeCheckpointCodec.decode(bytes);
      const before = refsOf(seeded.manifest);
      const after = refsOf(manifest);
      // Same objects, same bytes, same part-list digests; only the ids moved.
      expect(after.map(({ version: _, ...ref }) => ref)).toEqual(
        before.map(({ version: _, ...ref }) => ref),
      );
      expect(manifest.transcripts.root.sha256).toBe(
        seeded.manifest.transcripts.root.sha256,
      );
      for (const [index, ref] of after.entries()) {
        expect(ref.version).toBeDefined();
        expect(ref.version).not.toBe(before[index]?.version);
        expect((await restored.head(ref.key, ref.version))?.held).toBe(true);
      }
      expect(
        (await restored.head(seeded.row.manifestRef, row.manifestVersion))
          ?.held,
      ).toBe(true);

      const result = await restorePlan(
        restored,
        pointerOf({ ...seeded.row, ...row }),
        seeded,
      );
      expect(result.status).toBe("ready");
      if (result.status !== "ready") return;
      expect(result.plan.manifestVersion).toBe(row.manifestVersion);
      expect(
        result.plan.artifacts.flatMap((artifact) => artifact.objects),
      ).toEqual(expect.arrayContaining(after));
    });
  });

  test("without the re-pin the backup's versions are not in the restored bucket", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const seeded = await seed(source);
      await syncDown(source, dir);
      const restored = await restoredBucket();
      await syncUp(dir, restored, new Set());
      const result = await restorePlan(
        restored,
        pointerOf({
          ...seeded.row,
          manifestVersion: seeded.row.manifestVersion ?? "",
        }),
        seeded,
      );
      expect(result.status).toBe("unavailable");
    });
  });

  test("backup keeps the pinned bytes of a key overwritten or delete-marked after commit", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const seeded = await seed(source, [{ path: "a.txt", text: "pinned" }]);
      const overwritten = seeded.manifest.workspace.untracked[0]?.key ?? "";
      const deleted = seeded.manifest.transcripts.root.parts[0]?.key ?? "";
      await source.put(overwritten, new TextEncoder().encode("tampered"));
      source.remove(deleted);
      await syncDown(source, dir);
      expect(await Bun.file(join(dir, deleted)).exists()).toBe(false);

      const { replaced } = await captureCheckpointObjects({
        codecs,
        objects: source,
        objectsDir: dir,
        rows: [seeded.row],
      });
      expect(replaced).toEqual([deleted, overwritten].sort());
      expect(await readFile(join(dir, overwritten), "utf8")).toBe("pinned");

      const restored = await restoredBucket();
      await syncUp(dir, restored, new Set([seeded.row.manifestRef]));
      const planned = await planRepin({
        codecs,
        objects: restored,
        objectsDir: dir,
        rows: [seeded.row],
      });
      expect(planned).toHaveLength(1);
    });
  });

  test("backup refuses a checkpoint whose pinned version is gone or does not hash", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const seeded = await seed(source);
      const part = seeded.manifest.transcripts.root.parts[0];
      if (part?.version === undefined) throw new Error("no part");
      source.purgeVersion(part.key, part.version);
      await syncDown(source, dir);
      const refused = captureCheckpointObjects({
        codecs,
        objects: source,
        objectsDir: dir,
        rows: [
          seeded.row,
          { ...seeded.row, revision: 1, manifestSha256: "0".repeat(64) },
        ],
      });
      await expect(refused).rejects.toBeInstanceOf(CheckpointPinError);
      const error = (await refused.catch((e) => e)) as CheckpointPinError;
      expect(error.problems.join("\n")).toContain(
        `${part.key} (version ${part.version}) is missing`,
      );
      expect(error.problems.join("\n")).toContain("hashes to");
    });
  });

  test("a manifest key another checkpoint pins as an object is refused on both sides", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const victim = await seed(source);
      const victimBytes = await source.get(
        victim.row.manifestRef,
        victim.row.manifestVersion ?? undefined,
      );
      if (victimBytes === undefined) throw new Error("no manifest");
      // A second checkpoint whose untracked file is the first one's manifest.
      const borrower = await seed(source);
      const manifest: CheckpointManifest = {
        ...borrower.manifest,
        workspace: {
          ...borrower.manifest.workspace,
          untracked: [
            {
              bytes: victimBytes.byteLength,
              key: victim.row.manifestRef,
              path: "m.json",
              sha256: sha256Hex(victimBytes),
              version: victim.row.manifestVersion ?? "",
            },
          ],
        },
      };
      const sealed = claudeCheckpointCodec.encode(manifest);
      const ref = borrower.row.manifestRef.replace("manifest.json", "m2.json");
      const put = await source.putImmutable(ref, sealed.bytes);
      const row: CheckpointRow = {
        ...borrower.row,
        manifestRef: ref,
        manifestSha256: sealed.sha256,
        manifestVersion:
          put.outcome === "created" ? (put.version ?? null) : null,
      };
      await syncDown(source, dir);
      const rows = [victim.row, row];
      const capture = await captureCheckpointObjects({
        codecs,
        objects: source,
        objectsDir: dir,
        rows,
      }).catch((e) => e);
      expect(capture).toBeInstanceOf(CheckpointPinError);
      expect(String(capture.message)).toContain("which is the manifest of");

      const restored = await restoredBucket();
      await syncUp(dir, restored, new Set(rows.map((r) => r.manifestRef)));
      const plan = await planRepin({
        codecs,
        objects: restored,
        objectsDir: dir,
        rows,
      }).catch((e) => e);
      expect(plan).toBeInstanceOf(CheckpointPinError);
    });
  });

  test("restore refuses before writing when an object is missing, altered, or the manifest key exists", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const seeded = await seed(source, [{ path: "u.txt", text: "u" }]);
      await syncDown(source, dir);
      const bundleKey = seeded.manifest.workspace.bundle.key;
      const untrackedKey = seeded.manifest.workspace.untracked[0]?.key ?? "";

      const restored = await restoredBucket();
      await syncUp(dir, restored, new Set([seeded.row.manifestRef, bundleKey]));
      await restored.put(untrackedKey, new TextEncoder().encode("x"));
      const before = restored.keys().length;
      const refused = await planRepin({
        codecs,
        objects: restored,
        objectsDir: dir,
        rows: [seeded.row],
      }).catch((e) => e);
      expect(refused).toBeInstanceOf(CheckpointPinError);
      const problems = (refused as CheckpointPinError).problems.join("\n");
      expect(problems).toContain(`${bundleKey} is not in the restored bucket`);
      expect(problems).toContain(`${untrackedKey} (version`);
      expect(restored.keys().length).toBe(before);

      const occupied = await restoredBucket();
      await syncUp(dir, occupied, new Set());
      const taken = await planRepin({
        codecs,
        objects: occupied,
        objectsDir: dir,
        rows: [seeded.row],
      }).catch((e) => e);
      expect(String(taken.message)).toContain(
        "already exists in the restored bucket",
      );
    });
  });

  test("restore refuses a backup manifest that does not hash to its row", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const seeded = await seed(source);
      await syncDown(source, dir);
      await writeFile(join(dir, seeded.row.manifestRef), "{}");
      const refused = await planRepin({
        codecs,
        objects: await restoredBucket(),
        objectsDir: dir,
        rows: [seeded.row],
      }).catch((e) => e);
      expect(String(refused.message)).toContain("hashes to");
    });
  });

  test("every revision of a session is re-pinned, and parts they share get one version", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const first = await seed(source);
      // Revision 1 of the same session: the transcript parts carry over, the
      // bundle is the new attempt's own.
      const attempt = `attempt-${randomUUID().slice(0, 8)}`;
      const manifestRef = manifestRefFor(
        first.row.sessionId,
        1,
        attempt,
        publishId(),
      );
      const bundle = await createGitBundle({ message: "revision 1" });
      const bundleKey = manifestRef.replace(
        "manifest.json",
        "workspace.bundle",
      );
      const bundlePut = await source.putImmutable(bundleKey, bundle.bytes);
      const manifest: CheckpointManifest = {
        ...first.manifest,
        revision: 1,
        workspace: {
          ...first.manifest.workspace,
          bundle: {
            bytes: bundle.bytes.byteLength,
            key: bundleKey,
            sha256: bundle.sha256,
            ...(bundlePut.outcome === "created"
              ? { version: bundlePut.version }
              : {}),
          },
          gitCommit: bundle.commit,
        },
      };
      const sealed = claudeCheckpointCodec.encode(manifest);
      const put = await source.putImmutable(manifestRef, sealed.bytes);
      const second: CheckpointRow = {
        manifestRef,
        manifestSha256: sealed.sha256,
        manifestVersion:
          put.outcome === "created" ? (put.version ?? null) : null,
        revision: 1,
        sessionId: first.row.sessionId,
      };
      const rows = [first.row, second];
      await syncDown(source, dir);
      await captureCheckpointObjects({
        codecs,
        objects: source,
        objectsDir: dir,
        rows,
      });

      const restored = await restoredBucket();
      await syncUp(dir, restored, new Set(rows.map((row) => row.manifestRef)));
      const planned = await planRepin({
        codecs,
        objects: restored,
        objectsDir: dir,
        rows,
      });
      const repinned = await applyRepin({ objects: restored, planned });
      expect(repinned.map((row) => row.revision)).toEqual([0, 1]);
      const [older, newer] = planned;
      if (older === undefined || newer === undefined) throw new Error("rows");
      expect(newer.manifest.transcripts.root.parts).toEqual(
        older.manifest.transcripts.root.parts,
      );
      for (const [index, checkpoint] of planned.entries()) {
        const row = repinned[index];
        if (row === undefined) throw new Error("row");
        const bytes = await restored.get(
          checkpoint.row.manifestRef,
          row.manifestVersion,
        );
        expect(bytes && sha256Hex(bytes)).toBe(row.manifestSha256);
        for (const ref of refsOf(checkpoint.manifest)) {
          expect((await restored.head(ref.key, ref.version))?.held).toBe(true);
        }
      }
    });
  });

  test("an incremental checkpoint's base bundles are captured, re-pinned and held (94S-372)", async () => {
    await withDir(async (dir) => {
      const source = createMemoryCheckpointObjectStore({ versioned: true });
      const chain = await createGitBundleChain();
      const first = await seed(source, [], chain.base);
      const base = first.manifest.workspace.bundle;
      // Revision 1 uploads only the tip and names revision 0's bundle, where
      // revision 0 wrote it, as its base.
      const manifestRef = manifestRefFor(
        first.row.sessionId,
        1,
        `attempt-${randomUUID().slice(0, 8)}`,
        publishId(),
      );
      const tipKey = manifestRef.replace("manifest.json", "workspace.bundle");
      const tipPut = await source.putImmutable(tipKey, chain.tip.bytes);
      const incremental: CheckpointManifest = {
        ...first.manifest,
        revision: 1,
        workspace: {
          ...first.manifest.workspace,
          baseBundles: [base],
          bundle: {
            bytes: chain.tip.bytes.byteLength,
            key: tipKey,
            sha256: chain.tip.sha256,
            ...(tipPut.outcome === "created"
              ? { version: tipPut.version }
              : {}),
          },
          gitCommit: chain.tip.commit,
        },
      };
      const sealed = claudeCheckpointCodec.encode(incremental);
      const put = await source.putImmutable(manifestRef, sealed.bytes);
      const second: CheckpointRow = {
        manifestRef,
        manifestSha256: sealed.sha256,
        manifestVersion:
          put.outcome === "created" ? (put.version ?? null) : null,
        revision: 1,
        sessionId: first.row.sessionId,
      };
      expect(refsOf(incremental).map((ref) => ref.key)).toContain(base.key);

      // Only revision 1 is backed up, as after revision 0 was collected: its
      // base must come from its own manifest. The sync saw the key already
      // overwritten, so only a capture by version keeps the base's bytes.
      await source.put(base.key, new TextEncoder().encode("overwritten"));
      await syncDown(source, dir);
      const { replaced } = await captureCheckpointObjects({
        codecs,
        objects: source,
        objectsDir: dir,
        rows: [second],
      });
      expect(replaced).toEqual([base.key]);

      const restored = await restoredBucket();
      await syncUp(
        dir,
        restored,
        new Set([first.row.manifestRef, manifestRef]),
      );
      const planned = await planRepin({
        codecs,
        objects: restored,
        objectsDir: dir,
        rows: [second],
      });
      const [row] = await applyRepin({ objects: restored, planned });
      if (row === undefined) throw new Error("no row");
      const bytes = await restored.get(manifestRef, row.manifestVersion);
      if (bytes === undefined) throw new Error("manifest not written");
      const written = claudeCheckpointCodec.decode(bytes);
      const [repinnedBase, ...rest] = written.workspace.baseBundles ?? [];
      expect(rest).toEqual([]);
      expect(repinnedBase?.version).toBeDefined();
      expect(repinnedBase?.version).not.toBe(base.version);
      expect(repinnedBase?.version).toBe(
        (await restored.head(base.key))?.version,
      );
      for (const ref of refsOf(written)) {
        expect((await restored.head(ref.key, ref.version))?.held).toBe(true);
      }

      const result = await restorePlan(
        restored,
        pointerOf({ ...second, ...row, revision: 1 }),
        { manifest: incremental, row: second },
      );
      expect(result.status).toBe("ready");
    });
  });
});

describe("plans against a target worker image (verify-restore.sh --image)", () => {
  test("an image of another CLI build makes the plan incompatible; the image the checkpoint was sealed under does not", async () => {
    const objects = createMemoryCheckpointObjectStore({ versioned: true });
    const seeded = await seed(objects);
    const pointer = pointerOf({
      ...seeded.row,
      manifestVersion: seeded.row.manifestVersion as string,
    });
    const other = parseImageRuntime(
      JSON.stringify({ ...CLAUDE_RUNTIME_FINGERPRINT, cliVersion: "9.9.9" }),
    );

    const result = await restorePlan(
      objects,
      pointer,
      seeded,
      planRuntime(seeded.manifest.runtime, other),
    );
    expect(result.status).toBe("incompatible");
    if (result.status !== "incompatible") return;
    expect(describeMismatches(result.mismatches)).toBe(
      `cliVersion ${CLAUDE_RUNTIME_FINGERPRINT.cliVersion} → 9.9.9`,
    );

    const same = parseImageRuntime(JSON.stringify(CLAUDE_RUNTIME_FINGERPRINT));
    expect(
      (
        await restorePlan(
          objects,
          pointer,
          seeded,
          planRuntime(seeded.manifest.runtime, same),
        )
      ).status,
    ).toBe("ready");
  });

  test("the profile digest stays the checkpoint's; no image asks with the sealed runtime", () => {
    const sealed = {
      ...CLAUDE_RUNTIME_FINGERPRINT,
      profileSha256: "a".repeat(64),
    };
    const image = parseImageRuntime(
      JSON.stringify({ ...CLAUDE_RUNTIME_FINGERPRINT, profileSha256: "b" }),
    );
    expect(planRuntime(sealed, image)).toEqual(sealed);
    expect(planRuntime(sealed, undefined)).toBe(sealed);
  });

  test("an image runtime missing a field or not JSON is refused", () => {
    expect(() => parseImageRuntime("not json")).toThrow("is not JSON");
    expect(() =>
      parseImageRuntime(JSON.stringify({ cliVersion: "1", engine: "claude" })),
    ).toThrow("has no sdkVersion");
    expect(() => parseImageRuntime("null")).toThrow("has no cliVersion");
  });
});
