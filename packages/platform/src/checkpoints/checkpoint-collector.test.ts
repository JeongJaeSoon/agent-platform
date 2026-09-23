import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  CheckpointCodec,
  CheckpointManifest,
  ObjectRef,
  RuntimeFingerprint,
} from "@agent-platform/runtime-core";
import {
  createMemoryCheckpointObjectStore,
  type MemoryCheckpointObjectStore,
} from "@agent-platform/testkit/checkpoint-objects";
import { createGitBundle } from "@agent-platform/testkit/git-bundle";

import type { CheckpointCollectionStore } from "../ports/checkpoint-collection.ts";
import type {
  CheckpointFence,
  CheckpointPointer,
  CheckpointStore,
} from "../ports/checkpoint-store.ts";
import { structuralBundleVerifier } from "../ports/workspace-bundle-verifier.ts";
import { createCheckpointCollector } from "./checkpoint-collector.ts";
import {
  createCheckpointService,
  manifestRefFor,
  sessionObjectPrefix,
} from "./checkpoint-service.ts";

/**
 * 94S-281: garbage collection releases and deletes what no restore can reach
 * and no finalize can still commit — and nothing else, whatever order it
 * runs in against a finalize.
 */

const sessionId = "55555555-5555-4555-8555-555555555555";
const prefix = sessionObjectPrefix(sessionId);
const runtime: RuntimeFingerprint = {
  cliVersion: "2.1.270",
  engine: "claude",
  profileSha256: "a".repeat(64),
  sdkVersion: "0.3.270",
};
const codec: CheckpointCodec = {
  engine: runtime.engine,
  encode(manifest) {
    const bytes = encode(`${JSON.stringify(manifest)}\n`);
    return { bytes, sha256: sha256(bytes) };
  },
  decode(bytes) {
    return JSON.parse(new TextDecoder().decode(bytes)) as CheckpointManifest;
  },
  validateCompatibility() {
    return { status: "compatible" };
  },
};
const workspaceBundle = await createGitBundle();

function fenceOf(attemptId: string): CheckpointFence {
  return {
    attemptId,
    authRevision: 1,
    executionGeneration: 1,
    leaseEpoch: 1,
    sessionId,
  };
}

/**
 * The session row, its checkpoint rows and its attempts, judged the way the
 * database judges them: a commit needs a live attempt and the next revision.
 */
function memorySession() {
  let pointer: CheckpointPointer | null = null;
  const rows: CheckpointPointer[] = [];
  const fenced = new Set<string>();
  const collected = new Set<number>();
  const state = {
    fallback: null as { attemptId: string; revision: number } | null,
    /** Runs once, right after the next pointer or fence read. */
    betweenReads: undefined as (() => Promise<void>) | undefined,
  };
  const afterRead = async () => {
    const between = state.betweenReads;
    if (between !== undefined) {
      state.betweenReads = undefined;
      await between();
    }
  };
  const store: CheckpointStore & CheckpointCollectionStore = {
    async readPointer() {
      const found = pointer;
      await afterRead();
      return found;
    },
    async readCollectionFences() {
      const found = {
        fallbackRevision: state.fallback?.revision ?? null,
        fencedAttemptIds: new Set(fenced),
      };
      await afterRead();
      return found;
    },
    async listCheckpoints(_session, { belowRevision, limit }) {
      return rows
        .filter((row) => row.revision < belowRevision)
        .sort((left, right) => right.revision - left.revision)
        .slice(0, limit);
    },
    async markCollected(_session, { keep, throughRevision }) {
      let marked = 0;
      for (const row of rows) {
        if (row.revision > throughRevision || keep.includes(row.revision)) {
          continue;
        }
        if (!collected.has(row.revision)) marked += 1;
        collected.add(row.revision);
      }
      return marked;
    },
    async listSessionIds({ after }) {
      return after === null ? [sessionId] : [];
    },
    async commitAtomic(input) {
      if (fenced.has(input.fence.attemptId)) return { outcome: "stale_epoch" };
      const next = (pointer?.revision ?? -1) + 1;
      if (input.checkpoint.revision !== next) {
        return {
          outcome: "conflict",
          currentRevision: pointer?.revision ?? null,
        };
      }
      pointer = {
        committedAt: input.now,
        manifestRef: input.checkpoint.manifest_ref,
        manifestSha256: input.checkpoint.manifest_sha256,
        manifestVersion: input.checkpoint.manifest_version ?? null,
        parentRevision:
          state.fallback?.attemptId === input.fence.attemptId
            ? state.fallback.revision
            : (pointer?.revision ?? null),
        revision: next,
        turnId: null,
        versionsHeld: input.versionsHeld === true,
      };
      state.fallback = null;
      rows.push(pointer);
      return { outcome: "committed", revision: next };
    },
  };
  return {
    collected,
    fence: (attemptId: string) => fenced.add(attemptId),
    pointer: () => pointer,
    state,
    store,
  };
}

let objects: MemoryCheckpointObjectStore;
let session: ReturnType<typeof memorySession>;

beforeEach(() => {
  objects = createMemoryCheckpointObjectStore({ versioned: true });
  session = memorySession();
});

function service(options: { unversioned?: boolean } = {}) {
  return createCheckpointService({
    codecs: { [runtime.engine]: codec },
    objects,
    store: session.store,
    workspaceBundles: structuralBundleVerifier,
    ...(options.unversioned ? { objectProtection: "unversioned" } : {}),
  });
}

function collector(
  options: { maxRestoreFallbacks?: number; unversioned?: boolean } = {},
) {
  return createCheckpointCollector({
    codecs: { [runtime.engine]: codec },
    collector: objects,
    objectProtection: options.unversioned ? "unversioned" : "locked",
    objects,
    store: session.store,
    ...(options.maxRestoreFallbacks === undefined
      ? {}
      : { maxRestoreFallbacks: options.maxRestoreFallbacks }),
  });
}

async function upload(key: string, bytes: Uint8Array): Promise<ObjectRef> {
  const result = await objects.putImmutable(key, bytes);
  if (result.outcome === "conflict" || result.version === undefined) {
    throw new Error(`upload of ${key} did not land with a version`);
  }
  return {
    bytes: bytes.byteLength,
    key,
    sha256: sha256(bytes),
    version: result.version,
  };
}

let publishes = 0;

/** What a worker's publish leaves: bundle, untracked file and manifest. */
async function publish(
  revision: number,
  attemptId: string,
  parts: readonly ObjectRef[],
  edit: (manifest: CheckpointManifest) => CheckpointManifest = (m) => m,
) {
  publishes += 1;
  const manifestRef = manifestRefFor(
    sessionId,
    revision,
    attemptId,
    publishes.toString(16).padStart(32, "0"),
  );
  const directory = manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1);
  const bundle = await upload(
    `${directory}workspace.bundle`,
    workspaceBundle.bytes,
  );
  const notes = await upload(
    `${directory}untracked/notes`,
    encode(`notes ${revision}\n`),
  );
  const manifest = edit({
    createdAt: "2026-09-24T00:00:00.000Z",
    cwd: "/workspace",
    engine: runtime.engine,
    resume: `engine-session-${revision}`,
    revision,
    runtime,
    sessionId,
    transcripts: {
      root: { entryCount: parts.length, parts, sha256: "c".repeat(64) },
      subagents: {},
    },
    version: 2,
    workspace: {
      bundle,
      gitCommit: workspaceBundle.commit,
      untracked: [{ ...notes, path: "notes.md" }],
    },
  });
  const encoded = codec.encode(manifest);
  const stored = await upload(manifestRef, encoded.bytes);
  return {
    checkpoint: {
      manifest_ref: manifestRef,
      manifest_sha256: encoded.sha256,
      manifest_version: stored.version as string,
      revision,
    },
    versions: [
      { key: manifestRef, version: stored.version as string },
      ...[bundle, notes].map(({ key, version }) => ({
        key,
        version: version as string,
      })),
    ],
  };
}

async function commit(
  revision: number,
  attemptId: string,
  parts: readonly ObjectRef[],
  checkpoints = service(),
) {
  const published = await publish(revision, attemptId, parts);
  const result = await checkpoints.finalize({
    checkpoint: published.checkpoint,
    fence: fenceOf(attemptId),
    now: new Date("2026-09-24T00:00:00.000Z"),
    sessionId,
    turnId: null,
  });
  expect(result).toEqual({ outcome: "committed", revision });
  return published;
}

async function present(entry: { key: string; version: string }) {
  return (await objects.head(entry.key, entry.version)) !== undefined;
}

async function transcriptPart(index: number): Promise<ObjectRef> {
  return upload(
    `${prefix}transcripts/generation-0000000001/part-${index}.jsonl`,
    encode(`{"type":"user","uuid":"u${index}"}\n`),
  );
}

describe("superseded revisions", () => {
  test("go once they fall out of the fallback window; the transcript parts the pointer shares stay", async () => {
    const first = await transcriptPart(0);
    const second = await transcriptPart(1);
    const revision0 = await commit(0, "attempt-a", [first]);
    const revision1 = await commit(1, "attempt-a", [first, second]);
    const revision2 = await commit(2, "attempt-a", [first, second]);

    expect(
      await collector({ maxRestoreFallbacks: 1 }).collectSession(sessionId, {
        dryRun: false,
      }),
    ).toEqual({ status: "collected", kept: 6, purged: 3 });

    for (const entry of revision0.versions)
      expect(await present(entry)).toBe(false);
    for (const entry of [...revision1.versions, ...revision2.versions]) {
      expect(await present(entry)).toBe(true);
    }
    expect(await present(first as { key: string; version: string })).toBe(true);
    expect([...session.collected]).toEqual([0]);

    const plan = await service().getRestorePlan({ runtime, sessionId });
    expect(plan.status).toBe("ready");
  });

  test("the default window keeps the pointer and three revisions below it", async () => {
    const part = await transcriptPart(0);
    const published = [];
    for (let revision = 0; revision < 5; revision += 1) {
      published.push(await commit(revision, "attempt-a", [part]));
    }

    await collector().collectSession(sessionId, { dryRun: false });

    const kept = await Promise.all(
      published.map(async (revision) => present(revision.versions[0] as never)),
    );
    expect(kept).toEqual([false, true, true, true, true]);
  });

  test("the fallback base a session was restored from stays, even outside the window", async () => {
    const part = await transcriptPart(0);
    const revision0 = await commit(0, "attempt-a", [part]);
    await commit(1, "attempt-a", [part]);
    await commit(2, "attempt-a", [part]);
    session.state.fallback = { attemptId: "attempt-b", revision: 0 };

    await collector({ maxRestoreFallbacks: 1 }).collectSession(sessionId, {
      dryRun: false,
    });

    for (const entry of revision0.versions)
      expect(await present(entry)).toBe(true);
  });

  test("so does the chain below that base, which the next commit built on it restores from", async () => {
    const part = await transcriptPart(0);
    const published = [];
    for (let revision = 0; revision < 6; revision += 1) {
      published.push(await commit(revision, "attempt-a", [part]));
    }
    // Revision 5 was damaged; attempt-b restored revision 2 instead.
    session.state.fallback = { attemptId: "attempt-b", revision: 2 };

    await collector({ maxRestoreFallbacks: 2 }).collectSession(sessionId, {
      dryRun: false,
    });
    await commit(6, "attempt-b", [part]);

    // Revision 6 is built on 2, so its window is 6, 2 and 1.
    expect(session.pointer()?.parentRevision).toBe(2);
    for (const revision of [1, 2]) {
      for (const entry of published[revision]?.versions ?? []) {
        expect(await present(entry)).toBe(true);
      }
    }
    expect([...session.collected]).toEqual([]);
  });

  test("a dry run deletes and marks nothing", async () => {
    const part = await transcriptPart(0);
    const revision0 = await commit(0, "attempt-a", [part]);
    await commit(1, "attempt-a", [part]);

    expect(
      await collector({ maxRestoreFallbacks: 0 }).collectSession(sessionId, {
        dryRun: true,
      }),
    ).toMatchObject({ status: "collected", purged: 3 });
    for (const entry of revision0.versions)
      expect(await present(entry)).toBe(true);
    expect(session.collected.size).toBe(0);
  });

  test("a retained manifest that cannot be read leaves the whole session alone", async () => {
    const part = await transcriptPart(0);
    const revision0 = await commit(0, "attempt-a", [part]);
    const revision1 = await commit(1, "attempt-a", [part]);
    const manifest = revision1.versions[0] as { key: string; version: string };
    objects.releaseHold(manifest.key, manifest.version);
    objects.purgeVersion(manifest.key, manifest.version);

    expect(
      await collector({ maxRestoreFallbacks: 0 }).collectSession(sessionId, {
        dryRun: false,
      }),
    ).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/missing/),
    });
    for (const entry of revision0.versions)
      expect(await present(entry)).toBe(true);
  });
});

describe("against a finalize in flight", () => {
  test("a collection between the finalize's holds and its CAS leaves the checkpoint it commits whole", async () => {
    const part = await transcriptPart(0);
    await commit(0, "attempt-a", [part]);
    const checkpoints = service();
    const next = await publish(1, "attempt-a", [part]);

    const verdict = await checkpoints.verifyAttemptManifest({
      checkpoint: next.checkpoint,
      fence: fenceOf("attempt-a"),
    });
    expect(verdict).toMatchObject({ status: "verified", versionsHeld: true });
    await collector({ maxRestoreFallbacks: 0 }).collectSession(sessionId, {
      dryRun: false,
    });
    expect(
      await session.store.commitAtomic({
        checkpoint: next.checkpoint,
        fence: fenceOf("attempt-a"),
        now: new Date(),
        sessionId,
        turnId: null,
        versionsHeld: true,
      }),
    ).toEqual({ outcome: "committed", revision: 1 });

    const plan = await checkpoints.getRestorePlan({ runtime, sessionId });
    if (plan.status !== "ready") throw new Error(JSON.stringify(plan));
    const planned = [
      { key: plan.plan.manifestRef, version: plan.plan.manifestVersion },
      ...plan.plan.artifacts.flatMap((artifact) => artifact.objects),
    ];
    for (const { key, version } of planned) {
      expect(await objects.head(key, version)).toMatchObject({ held: true });
    }
  });

  test("an attempt that commits and loses its fence between GC's two reads keeps its commit", async () => {
    const part = await transcriptPart(0);
    await commit(0, "attempt-a", [part]);
    const next = await publish(1, "attempt-a", [part]);
    const checkpoints = service();
    session.state.betweenReads = async () => {
      await checkpoints.finalize({
        checkpoint: next.checkpoint,
        fence: fenceOf("attempt-a"),
        now: new Date(),
        sessionId,
        turnId: null,
      });
      session.fence("attempt-a");
    };

    await collector({ maxRestoreFallbacks: 0 }).collectSession(sessionId, {
      dryRun: false,
    });

    expect(session.pointer()?.revision).toBe(1);
    for (const entry of next.versions) expect(await present(entry)).toBe(true);
  });

  test("finalize refuses a manifest that names another publish's untracked file", async () => {
    const part = await transcriptPart(0);
    const revision0 = await commit(0, "attempt-a", [part]);
    const foreign = revision0.versions[2] as { key: string; version: string };
    const stray = await publish(1, "attempt-a", [part], (manifest) => ({
      ...manifest,
      workspace: {
        ...manifest.workspace,
        untracked: [
          {
            bytes: encode("notes 0\n").byteLength,
            key: foreign.key,
            path: "notes.md",
            sha256: sha256(encode("notes 0\n")),
            version: foreign.version,
          },
        ],
      },
    }));

    expect(
      await service().verifyAttemptManifest({
        checkpoint: stray.checkpoint,
        fence: fenceOf("attempt-a"),
      }),
    ).toEqual({
      status: "rejected",
      reason: expect.stringMatching(/not under this publish's/),
    });
  });

  test("finalize refuses a transcript part stored in a checkpoint directory", async () => {
    const part = await transcriptPart(0);
    const revision0 = await commit(0, "attempt-a", [part]);
    const bundle = revision0.versions[1] as { key: string; version: string };
    const stray = await publish(1, "attempt-a", [
      {
        bytes: workspaceBundle.bytes.byteLength,
        key: bundle.key,
        sha256: sha256(workspaceBundle.bytes),
        version: bundle.version,
      },
    ]);

    expect(
      await service().verifyAttemptManifest({
        checkpoint: stray.checkpoint,
        fence: fenceOf("attempt-a"),
      }),
    ).toMatchObject({ status: "rejected" });
  });
});

describe("orphaned attempt directories", () => {
  test("go only once their attempt has lost its fence", async () => {
    const part = await transcriptPart(0);
    await commit(0, "attempt-a", [part]);
    // Uploaded, held by a finalize, and never committed.
    const orphan = await publish(1, "attempt-a", [part]);
    await service().verifyAttemptManifest({
      checkpoint: orphan.checkpoint,
      fence: fenceOf("attempt-a"),
    });

    await collector().collectSession(sessionId, { dryRun: false });
    for (const entry of orphan.versions)
      expect(await present(entry)).toBe(true);

    session.fence("attempt-a");
    await collector().collectSession(sessionId, { dryRun: false });
    for (const entry of orphan.versions)
      expect(await present(entry)).toBe(false);
  });

  test("a live attempt's candidate that lost the CAS goes once the pointer passes its revision", async () => {
    const part = await transcriptPart(0);
    await commit(0, "attempt-a", [part]);
    const loser = await publish(1, "attempt-a", [part]);
    await commit(1, "attempt-a", [part]);

    await collector().collectSession(sessionId, { dryRun: false });

    for (const entry of loser.versions)
      expect(await present(entry)).toBe(false);
  });

  test("a session with no checkpoint yet loses only fenced attempts' uploads", async () => {
    const part = await transcriptPart(0);
    const live = await publish(0, "attempt-b", [part]);
    const dead = await publish(0, "attempt-a", [part]);
    session.fence("attempt-a");

    await collector().collectSession(sessionId, { dryRun: false });

    for (const entry of live.versions) expect(await present(entry)).toBe(true);
    for (const entry of dead.versions) expect(await present(entry)).toBe(false);
    expect(await present(part as { key: string; version: string })).toBe(true);
  });
});

describe("what the pointer vouches for", () => {
  test("a pointer committed without held versions keeps every version of every key it names", async () => {
    const part = await transcriptPart(0);
    const unversioned = service({ unversioned: true });
    const revision0 = await commit(0, "attempt-a", [part], unversioned);
    expect(session.pointer()?.versionsHeld).toBe(false);
    // A second write under the manifest's key: only a key-level keep holds it.
    const rewrite = await (async () => {
      await objects.put(revision0.checkpoint.manifest_ref, encode("{}\n"));
      const head = await objects.head(revision0.checkpoint.manifest_ref);
      return {
        key: revision0.checkpoint.manifest_ref,
        version: head?.version as string,
      };
    })();
    session.fence("attempt-a");

    await collector().collectSession(sessionId, { dryRun: false });

    for (const entry of [...revision0.versions, rewrite]) {
      expect(await present(entry)).toBe(true);
    }
  });

  test("an unversioned deployment collects nothing", async () => {
    const part = await transcriptPart(0);
    const revision0 = await commit(0, "attempt-a", [part]);
    await commit(1, "attempt-a", [part]);

    expect(
      await collector({ maxRestoreFallbacks: 0, unversioned: true }).collect({
        batchSize: 10,
        dryRun: false,
      }),
    ).toEqual({ failed: 0, purged: 0, sessions: 1 });
    for (const entry of revision0.versions)
      expect(await present(entry)).toBe(true);
  });
});

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
