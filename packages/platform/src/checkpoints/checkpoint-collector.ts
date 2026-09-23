import type {
  CheckpointCodec,
  CheckpointManifest,
  CheckpointObjectStore,
} from "@agent-platform/runtime-core";

import type {
  CheckpointCollectionStore,
  CheckpointObjectCollector,
  StoredObjectVersion,
} from "../ports/checkpoint-collection.ts";
import type { CheckpointPointer } from "../ports/checkpoint-store.ts";
import {
  DEFAULT_MAX_RESTORE_FALLBACKS,
  type ObjectProtection,
  sessionObjectPrefix,
} from "./checkpoint-service.ts";
import {
  engineOf,
  inBatches,
  own,
  parentOf,
  sha256,
} from "./checkpoint-support.ts";

export type CheckpointCollectorDependencies = {
  codecs: Readonly<Record<string, CheckpointCodec>>;
  collector: CheckpointObjectCollector;
  /**
   * How many committed revisions below the pointer stay restorable. Must be
   * the CheckpointService's `maxRestoreFallbacks`: a smaller value here
   * releases revisions a fallback restore would still reach for.
   */
  maxRestoreFallbacks?: number;
  objectProtection: ObjectProtection;
  /** Reads manifests; the collector never writes through it. */
  objects: Pick<CheckpointObjectStore, "get">;
  store: CheckpointCollectionStore;
};

export type SessionCollection =
  | { kept: number; purged: number; status: "collected" }
  | { reason: string; status: "skipped" };

/**
 * Releases and deletes the checkpoint objects no restore can reach and no
 * finalize can still commit (94S-281).
 *
 * Only versions under `<session>/checkpoints/<revision>/<attempt>/` are ever
 * touched: manifests, workspace bundles and untracked files, which each
 * belong to the one attempt that wrote them. Transcript parts are shared by
 * every revision that inherits them and are left alone.
 *
 * A version goes only when both hold:
 *
 * - *No restore needs it.* It is not named by the pointer's checkpoint, the
 *   `maxRestoreFallbacks` revisions below it along the parent chain, or the
 *   fallback base the session was last restored from and as many below that
 *   (the window of the commit built on it). Only the attempt that
 *   holds the fence restores anything that matters, and the pointer does not
 *   move until that attempt commits, so its plan is always among these.
 * - *No finalize can commit it.* Its directory is at or below the pointer's
 *   revision — the pointer CAS accepts only the next one — or belongs to an
 *   attempt that lost its fence. Finalize accepts a manifest naming
 *   directory objects only in its own attempt's directory
 *   (`verifyAttemptManifest`), so whatever a finalize in flight has held
 *   sits in a directory that is neither, whatever order its hold, this
 *   collection and its CAS run in.
 *
 * Both conditions only ever grow more true, so reading the database before
 * listing the objects needs no lock — only the order the two reads run in
 * (`collectSession`).
 */
export function createCheckpointCollector(
  deps: CheckpointCollectorDependencies,
) {
  const { codecs, collector, objects, store } = deps;
  const window = deps.maxRestoreFallbacks ?? DEFAULT_MAX_RESTORE_FALLBACKS;

  async function row(
    sessionId: string,
    revision: number,
  ): Promise<CheckpointPointer | undefined> {
    const [found] = await store.listCheckpoints(sessionId, {
      belowRevision: revision + 1,
      limit: 1,
    });
    return found?.revision === revision ? found : undefined;
  }

  /** The committed checkpoints a restore of this session may still read. */
  async function restorable(
    sessionId: string,
    pointer: CheckpointPointer | null,
    fallbackRevision: number | null,
  ): Promise<CheckpointPointer[] | string> {
    const rows = new Map<number, CheckpointPointer>();
    const walk = async (start: CheckpointPointer) => {
      let next = start;
      for (let depth = 0; ; depth += 1) {
        rows.set(next.revision, next);
        const parent = depth < window ? parentOf(next) : null;
        if (parent === null) return undefined;
        const found = await row(sessionId, parent);
        if (found === undefined) {
          return `no checkpoint row for revision ${parent}, which revision ${next.revision} was built on`;
        }
        next = found;
      }
    };
    const broken = pointer === null ? undefined : await walk(pointer);
    if (broken !== undefined) return broken;
    // The session runs on the fallback base, and its next commit is built on
    // it: that commit's own window then reaches below the base, so the base's
    // chain stays as the pointer's does.
    if (fallbackRevision !== null) {
      const base = await row(sessionId, fallbackRevision);
      if (base === undefined) {
        return `no checkpoint row for fallback revision ${fallbackRevision}`;
      }
      const brokenBase = await walk(base);
      if (brokenBase !== undefined) return brokenBase;
    }
    return [...rows.values()];
  }

  /**
   * The manifest as its row committed it, or a reason it cannot be trusted
   * to say what to keep. Read by the version the row recorded, the way a
   * restore reads it.
   */
  async function manifestOf(
    checkpoint: CheckpointPointer,
  ): Promise<CheckpointManifest | string> {
    const bytes = await objects.get(
      checkpoint.manifestRef,
      checkpoint.manifestVersion ?? undefined,
    );
    const label = `revision ${checkpoint.revision} manifest ${checkpoint.manifestRef}`;
    if (bytes === undefined) return `${label} is missing`;
    if (sha256(bytes) !== checkpoint.manifestSha256) {
      return `${label} does not match its digest`;
    }
    const engine = engineOf(bytes);
    const codec = engine === undefined ? undefined : own(codecs, engine);
    if (codec === undefined) return `${label} has no codec`;
    try {
      return codec.decode(bytes);
    } catch (error) {
      return `${label} does not decode: ${(error as Error).message}`;
    }
  }

  async function collectSession(
    sessionId: string,
    options: { dryRun: boolean },
  ): Promise<SessionCollection> {
    if (deps.objectProtection !== "locked") {
      return {
        status: "skipped",
        reason:
          "objectProtection is unversioned: nothing is held, and a checkpoint names keys rather than versions",
      };
    }
    // Fences first, pointer second. An attempt fenced by now committed
    // whatever it ever will before this read, so the pointer read after it
    // covers that commit. The other order loses it: the pointer is read,
    // the attempt commits the next revision and is released, and its fresh
    // pointer's directory then reads as a fenced attempt's garbage.
    // A fallback base recorded after this read needs nothing more: a locked
    // restore falls back one hop at most (`judgeEarlier` refuses damage), so
    // that base is the pointer's parent, and a commit built on it can reach
    // no further back than the pointer's own window already keeps.
    const fences = await store.readCollectionFences(sessionId);
    if (fences === null) {
      return { status: "skipped", reason: "session does not exist" };
    }
    const pointer = await store.readPointer(sessionId);
    const rows = await restorable(sessionId, pointer, fences.fallbackRevision);
    if (typeof rows === "string") return { status: "skipped", reason: rows };
    const keep = keepSet();
    for (const checkpoint of rows) {
      const manifest = await manifestOf(checkpoint);
      if (typeof manifest === "string") {
        return { status: "skipped", reason: manifest };
      }
      // Only a row a locked finalize committed vouches for its versions.
      // Any other named whatever the worker reported, which a restore
      // re-reads by key and re-holds, so every version of those keys stays.
      const trusted = checkpoint.versionsHeld === true;
      keep.add(
        checkpoint.manifestRef,
        trusted ? (checkpoint.manifestVersion ?? undefined) : undefined,
      );
      for (const ref of manifestObjects(manifest)) {
        keep.add(ref.key, trusted ? ref.version : undefined);
      }
    }
    const pointerRevision = pointer?.revision ?? -1;
    const directories = `${sessionObjectPrefix(sessionId)}checkpoints/`;
    const doomed: StoredObjectVersion[] = [];
    let kept = 0;
    for (const entry of await collector.listVersions(directories)) {
      const directory = attemptDirectory(entry.key, directories);
      const collectible =
        directory !== undefined &&
        (directory.revision <= pointerRevision ||
          fences.fencedAttemptIds.has(directory.attemptId));
      if (collectible && !keep.has(entry)) doomed.push(entry);
      else kept += 1;
    }
    if (!options.dryRun) {
      if (pointer !== null) {
        await store.markCollected(sessionId, {
          keep: rows.map((checkpoint) => checkpoint.revision),
          throughRevision: pointer.revision,
        });
      }
      await inBatches(doomed, 32, (entry) => collector.purge(entry));
    }
    return { status: "collected", kept, purged: doomed.length };
  }

  return {
    collectSession,

    /**
     * Every session, `batchSize` at a time. A session that fails is reported
     * and the rest still run: one unreadable bucket prefix must not keep
     * every other session's garbage forever.
     */
    async collect(options: {
      batchSize: number;
      dryRun: boolean;
      onSession?: (
        sessionId: string,
        result: SessionCollection | { error: unknown; status: "failed" },
      ) => void;
    }): Promise<{ failed: number; purged: number; sessions: number }> {
      const totals = { failed: 0, purged: 0, sessions: 0 };
      let after: string | null = null;
      for (;;) {
        const ids = await store.listSessionIds({
          after,
          limit: options.batchSize,
        });
        for (const sessionId of ids) {
          totals.sessions += 1;
          try {
            const result = await collectSession(sessionId, options);
            if (result.status === "collected") totals.purged += result.purged;
            options.onSession?.(sessionId, result);
          } catch (error) {
            totals.failed += 1;
            options.onSession?.(sessionId, { status: "failed", error });
          }
        }
        if (ids.length < options.batchSize) return totals;
        after = ids.at(-1) ?? null;
      }
    },
  };
}

export type CheckpointCollector = ReturnType<typeof createCheckpointCollector>;

/**
 * `<prefix><revision>/<attempt>/…` as `manifestRefFor` mints it. Anything
 * else under the prefix was not written by a checkpoint publish and is not
 * this collector's to judge.
 */
function attemptDirectory(
  key: string,
  prefix: string,
): { attemptId: string; revision: number } | undefined {
  const match = /^(\d{10})\/([^/]+)\/./.exec(key.slice(prefix.length));
  if (match === null || !key.startsWith(prefix)) return undefined;
  return { revision: Number(match[1]), attemptId: match[2] as string };
}

function manifestObjects(manifest: CheckpointManifest) {
  return [
    ...manifest.transcripts.root.parts,
    ...Object.values(manifest.transcripts.subagents).flatMap(
      (revision) => revision.parts,
    ),
    manifest.workspace.bundle,
    ...manifest.workspace.untracked,
  ];
}

/** Versions to keep, and keys whose every version is kept. */
function keepSet() {
  const keys = new Set<string>();
  const versions = new Set<string>();
  return {
    add(key: string, version: string | undefined) {
      if (version === undefined) keys.add(key);
      else versions.add(JSON.stringify([key, version]));
    },
    has(entry: StoredObjectVersion) {
      return (
        keys.has(entry.key) ||
        versions.has(JSON.stringify([entry.key, entry.version]))
      );
    },
  };
}
