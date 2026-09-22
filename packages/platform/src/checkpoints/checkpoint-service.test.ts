import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  CheckpointCodec,
  CheckpointManifest,
  ObjectRef,
  RuntimeFingerprint,
  WorkspaceArtifact,
} from "@agent-platform/runtime-core";
import {
  createMemoryCheckpointObjectStore,
  type MemoryCheckpointObjectStore,
} from "@agent-platform/testkit/checkpoint-objects";

import type {
  CheckpointFence,
  CheckpointPointer,
  CheckpointStore,
  CommitCheckpointInput,
  CommitCheckpointResult,
} from "../ports/checkpoint-store.ts";
import {
  createCheckpointService,
  manifestRefFor,
  sessionObjectPrefix,
} from "./checkpoint-service.ts";

const sessionId = "11111111-1111-4111-8111-111111111111";
const attemptId = "attempt-1";
const runtime: RuntimeFingerprint = {
  cliVersion: "2.1.270",
  engine: "test-engine",
  profileSha256: "a".repeat(64),
  sdkVersion: "0.3.270",
};

function fence(overrides: Partial<CheckpointFence> = {}): CheckpointFence {
  return {
    attemptId,
    authRevision: 1,
    executionGeneration: 1,
    leaseEpoch: 1,
    sessionId,
    ...overrides,
  };
}

/**
 * Stands in for a real codec: it validates the fields the service relies on and
 * nothing else, so these tests exercise the service rather than a manifest
 * schema that lives in an adapter.
 */
const codec: CheckpointCodec = {
  engine: runtime.engine,
  encode(manifest) {
    const text = `${JSON.stringify(manifest)}\n`;
    return { bytes: encode(text), sha256: sha256(text) };
  },
  decode(bytes) {
    const parsed = JSON.parse(
      new TextDecoder().decode(bytes),
    ) as CheckpointManifest & { corrupt?: boolean };
    if (parsed.corrupt) throw new Error("manifest body is corrupt");
    return parsed;
  },
  validateCompatibility(manifest, expected) {
    const mismatches = (
      ["engine", "sdkVersion", "cliVersion", "profileSha256"] as const
    )
      .filter((field) => manifest.runtime[field] !== expected[field])
      .map((field) => ({
        expected: expected[field],
        field,
        found: manifest.runtime[field],
      }));
    return mismatches.length === 0
      ? { status: "compatible" }
      : { mismatches, status: "incompatible" };
  },
};

/** Artifact bodies the manifests below point at, by key. */
const ROOT_PART = `${sessionObjectPrefix(sessionId)}mirror/root-0.jsonl`;
const SUB_PART = `${sessionObjectPrefix(sessionId)}mirror/sub-0.jsonl`;
const UNTRACKED = `${sessionObjectPrefix(sessionId)}workspace/notes.md`;
const ARTIFACTS: Record<string, string> = {
  [ROOT_PART]: '{"type":"user","uuid":"r1"}\n',
  [SUB_PART]: '{"type":"user","uuid":"s1"}\n',
  [UNTRACKED]: "scratch\n",
};

function ref(key: string): ObjectRef {
  const body = ARTIFACTS[key] ?? "";
  return { bytes: encode(body).byteLength, key, sha256: sha256(body) };
}

function fileRef(key: string, path: string): WorkspaceArtifact {
  return { ...ref(key), path };
}

function manifest(
  overrides: Partial<CheckpointManifest> = {},
): CheckpointManifest {
  return {
    createdAt: "2026-09-22T00:00:00.000Z",
    cwd: "/workspace",
    engine: runtime.engine,
    resume: "engine-session-1",
    revision: 0,
    runtime,
    sessionId,
    transcripts: {
      root: {
        entryCount: 2,
        parts: [ref(ROOT_PART)],
        sha256: "c".repeat(64),
      },
      subagents: {
        "agents/reviewer": {
          entryCount: 1,
          parts: [ref(SUB_PART)],
          sha256: "e".repeat(64),
        },
      },
    },
    version: 1,
    workspace: {
      gitCommit: "f".repeat(40),
      untracked: [fileRef(UNTRACKED, "notes.md")],
    },
    ...overrides,
  };
}

/**
 * Pointer CAS with the two rules the database enforces: the fence must still
 * own the session, and revisions only move up.
 */
function memoryCheckpointStore(owner: CheckpointFence = fence()) {
  let pointer: CheckpointPointer | null = null;
  const committed: CommitCheckpointInput[] = [];
  const store: CheckpointStore = {
    async readPointer() {
      return pointer;
    },
    async commitAtomic(input): Promise<CommitCheckpointResult> {
      if (
        input.fence.attemptId !== owner.attemptId ||
        input.fence.leaseEpoch !== owner.leaseEpoch ||
        input.fence.executionGeneration !== owner.executionGeneration
      ) {
        return { outcome: "stale_epoch" };
      }
      if (pointer !== null && input.checkpoint.revision === pointer.revision) {
        return pointer.manifestSha256 === input.checkpoint.manifest_sha256
          ? { outcome: "replayed", revision: pointer.revision }
          : { outcome: "conflict", currentRevision: pointer.revision };
      }
      if (pointer !== null && input.checkpoint.revision < pointer.revision) {
        return { outcome: "conflict", currentRevision: pointer.revision };
      }
      committed.push(input);
      pointer = {
        committedAt: input.now,
        manifestRef: input.checkpoint.manifest_ref,
        manifestSha256: input.checkpoint.manifest_sha256,
        revision: input.checkpoint.revision,
        turnId: input.turnId,
      };
      return { outcome: "committed", revision: pointer.revision };
    },
  };
  return { committed, store, pointer: () => pointer };
}

let objects: MemoryCheckpointObjectStore;
let checkpoints: ReturnType<typeof memoryCheckpointStore>;
let service: ReturnType<typeof createCheckpointService>;

beforeEach(async () => {
  objects = createMemoryCheckpointObjectStore();
  for (const [key, body] of Object.entries(ARTIFACTS)) {
    await objects.put(key, encode(body));
  }
  checkpoints = memoryCheckpointStore();
  service = createCheckpointService({
    codecs: { [runtime.engine]: codec },
    objects,
    store: checkpoints.store,
  });
});

/** A second service over the same objects, fenced to a different owner. */
function serviceOwnedBy(owner: CheckpointFence) {
  const store = memoryCheckpointStore(owner);
  return {
    store,
    service: createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objects,
      store: store.store,
    }),
  };
}

/** Uploads a manifest the way a worker would, and returns the ref for it. */
async function upload(body: CheckpointManifest, attempt = attemptId) {
  const manifestRef = manifestRefFor(body.sessionId, body.revision, attempt);
  const { bytes, sha256: digest } = codec.encode(body);
  const result = await objects.putImmutable(manifestRef, bytes);
  return {
    checkpoint: {
      manifest_ref: manifestRef,
      manifest_sha256: digest,
      revision: body.revision,
    },
    result,
  };
}

describe("requestCheckpoint", () => {
  test("hands out revision 0 for a session that has never checkpointed", async () => {
    expect(
      await service.requestCheckpoint({
        attemptId,
        preparation: ready(),
        sessionId,
      }),
    ).toEqual({
      status: "ready",
      request: {
        manifestRef: manifestRefFor(sessionId, 0, attemptId),
        revision: 0,
        sessionId,
      },
    });
  });

  test("hands out the revision after the pointer", async () => {
    const first = await upload(manifest());
    await service.finalize({
      ...first,
      fence: fence(),
      now: new Date(),
      sessionId,
      turnId: "1",
    });

    expect(
      await service.requestCheckpoint({
        attemptId,
        preparation: ready(),
        sessionId,
      }),
    ).toMatchObject({ status: "ready", request: { revision: 1 } });
  });

  test("gives each attempt its own key, so an orphan upload cannot wedge the session", async () => {
    // The first attempt uploads and then dies before finalizing.
    const orphan = await upload(manifest({ resume: "engine-session-dead" }));
    expect(orphan.result).toEqual({ outcome: "created" });

    // Its replacement is still handed revision 0 — the pointer never moved.
    const retry = await service.requestCheckpoint({
      attemptId: "attempt-2",
      preparation: ready(),
      sessionId,
    });
    if (retry.status !== "ready") throw new Error("expected a request");
    expect(retry.request.revision).toBe(0);
    expect(retry.request.manifestRef).not.toBe(orphan.checkpoint.manifest_ref);

    const second = await upload(manifest(), "attempt-2");
    expect(second.result).toEqual({ outcome: "created" });
    const replacement = serviceOwnedBy(fence({ attemptId: "attempt-2" }));
    expect(
      await replacement.service.finalize({
        ...second,
        fence: fence({ attemptId: "attempt-2" }),
        now: new Date(),
        sessionId,
        turnId: "1",
      }),
    ).toEqual({ outcome: "committed", revision: 0 });
  });

  test("passes the runtime's refusal through instead of allocating a revision", async () => {
    expect(
      await service.requestCheckpoint({
        attemptId,
        preparation: {
          status: "rejected",
          reason: "mirror_error",
          detail: "Transcript mirror dropped a root batch: append rejected",
        },
        sessionId,
      }),
    ).toEqual({
      status: "blocked",
      reason: "mirror_error",
      detail: "Transcript mirror dropped a root batch: append rejected",
    });
  });
});

describe("validateManifest", () => {
  test("accepts the manifest the ref describes", async () => {
    const { checkpoint } = await upload(manifest());

    expect(await service.validateManifest({ checkpoint, sessionId })).toEqual({
      status: "verified",
      manifest: manifest(),
    });
  });

  test("refuses a ref pointing at an object nobody uploaded", async () => {
    expect(
      await service.validateManifest({
        checkpoint: {
          manifest_ref: manifestRefFor(sessionId, 0, attemptId),
          manifest_sha256: "1".repeat(64),
          revision: 0,
        },
        sessionId,
      }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/manifest object is missing/),
    });
  });

  test("refuses a digest that does not match the stored bytes", async () => {
    const { checkpoint } = await upload(manifest());

    expect(
      await service.validateManifest({
        checkpoint: { ...checkpoint, manifest_sha256: "1".repeat(64) },
        sessionId,
      }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/digest mismatch/),
    });
  });

  test("refuses a manifest that belongs to another session", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const { checkpoint } = await upload(manifest({ sessionId: other }));

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: `manifest belongs to session ${other}`,
    });
  });

  test("refuses a manifest whose revision is not the one claimed", async () => {
    const { checkpoint } = await upload(manifest({ revision: 2 }));

    expect(
      await service.validateManifest({
        checkpoint: { ...checkpoint, revision: 3 },
        sessionId,
      }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/is revision 2, not 3/),
    });
  });

  test("refuses a manifest written by an engine this deployment has no codec for", async () => {
    const { checkpoint } = await upload(manifest({ engine: "other-engine" }));

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(
        /no codec for checkpoint engine: other-engine/,
      ),
    });
  });

  test("refuses bytes the codec cannot decode", async () => {
    const manifestRef = manifestRefFor(sessionId, 0, attemptId);
    const bytes = encode(
      JSON.stringify({ engine: runtime.engine, corrupt: true }),
    );
    await objects.putImmutable(manifestRef, bytes);

    expect(
      await service.validateManifest({
        checkpoint: {
          manifest_ref: manifestRef,
          manifest_sha256: sha256(new TextDecoder().decode(bytes)),
          revision: 0,
        },
        sessionId,
      }),
    ).toMatchObject({ status: "rejected", reason: "manifest body is corrupt" });
  });

  test("refuses a manifest naming a transcript part that was never uploaded", async () => {
    objects.remove(SUB_PART);
    const { checkpoint } = await upload(manifest());

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: `manifest references a missing object: ${SUB_PART}`,
    });
  });

  test("refuses a manifest naming an untracked file that was never uploaded", async () => {
    objects.remove(UNTRACKED);
    const { checkpoint } = await upload(manifest());

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/workspace\/notes\.md/),
    });
  });

  test("refuses a part whose stored size is not the size the manifest declares", async () => {
    await objects.put(ROOT_PART, encode("truncated"));
    const { checkpoint } = await upload(manifest());

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/mirror\/root-0\.jsonl is 9 bytes, not/),
    });
  });

  test("refuses a part replaced by different bytes of the same length", async () => {
    const original = ARTIFACTS[ROOT_PART] ?? "";
    // Same length, so a size check waves it through and only a digest catches
    // it — at which point the pointer has already superseded the last good one.
    await objects.put(ROOT_PART, encode(original.replace("r1", "XX")));
    const { checkpoint } = await upload(manifest());

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/hashes to [0-9a-f]{64}, not/),
    });
  });

  test("refuses a manifest naming another session's transcript", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const stolen = `${sessionObjectPrefix(other)}mirror/root-0.jsonl`;
    await objects.put(stolen, encode("{}\n"));
    const { checkpoint } = await upload(
      manifest({
        transcripts: {
          root: {
            entryCount: 1,
            parts: [{ bytes: 3, key: stolen, sha256: sha256("{}\n") }],
            sha256: "c".repeat(64),
          },
          subagents: {},
        },
      }),
    );

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/outside sessions\/11111111/),
    });
  });

  test("refuses a key that climbs out of the session namespace", async () => {
    const climbing = `${sessionObjectPrefix(sessionId)}../elsewhere/root.jsonl`;
    await objects.put(climbing, encode("{}\n"));
    const { checkpoint } = await upload(
      manifest({
        transcripts: {
          root: {
            entryCount: 1,
            parts: [{ bytes: 3, key: climbing, sha256: sha256("{}\n") }],
            sha256: "c".repeat(64),
          },
          subagents: {},
        },
      }),
    );

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({ status: "rejected" });
  });
});

describe("finalize", () => {
  test("promotes a validated manifest to the session pointer", async () => {
    const { checkpoint } = await upload(manifest());

    expect(
      await service.finalize({
        checkpoint,
        fence: fence(),
        now: new Date(),
        sessionId,
        turnId: "1",
      }),
    ).toEqual({ outcome: "committed", revision: 0 });
    expect(checkpoints.pointer()).toMatchObject({ revision: 0, turnId: "1" });
  });

  test("never commits a checkpoint it could not validate", async () => {
    const result = await service.finalize({
      checkpoint: {
        manifest_ref: manifestRefFor(sessionId, 0, attemptId),
        manifest_sha256: "1".repeat(64),
        revision: 0,
      },
      fence: fence(),
      now: new Date(),
      sessionId,
      turnId: "1",
    });

    expect(result).toMatchObject({ outcome: "rejected" });
    expect(checkpoints.committed).toEqual([]);
    expect(checkpoints.pointer()).toBeNull();
  });

  test("never commits a checkpoint whose artifacts are not all there", async () => {
    objects.remove(ROOT_PART);
    const { checkpoint } = await upload(manifest());

    expect(
      await service.finalize({
        checkpoint,
        fence: fence(),
        now: new Date(),
        sessionId,
        turnId: "1",
      }),
    ).toMatchObject({ outcome: "rejected" });
    expect(checkpoints.pointer()).toBeNull();
  });

  test("answers a conflict when the pointer has already moved past this revision", async () => {
    const zero = await upload(manifest());
    await service.finalize({
      ...zero,
      fence: fence(),
      now: new Date(),
      sessionId,
      turnId: "1",
    });
    const one = await upload(
      manifest({ revision: 1, resume: "engine-session-2" }),
    );
    await service.finalize({
      ...one,
      fence: fence(),
      now: new Date(),
      sessionId,
      turnId: "2",
    });

    expect(
      await service.finalize({
        ...zero,
        fence: fence(),
        now: new Date(),
        sessionId,
        turnId: "1",
      }),
    ).toEqual({ outcome: "conflict", currentRevision: 1 });
    expect(checkpoints.pointer()).toMatchObject({ revision: 1 });
  });

  test("replays the same finalize without moving the pointer", async () => {
    const zero = await upload(manifest());
    await service.finalize({
      ...zero,
      fence: fence(),
      now: new Date(),
      sessionId,
      turnId: "1",
    });

    expect(
      await service.finalize({
        ...zero,
        fence: fence(),
        now: new Date(),
        sessionId,
        turnId: "1",
      }),
    ).toEqual({ outcome: "replayed", revision: 0 });
    expect(checkpoints.committed).toHaveLength(1);
  });

  test("a worker whose lease was taken over loses even when it uploads first", async () => {
    // The stale execution wins the object-store race for revision 0 …
    const stale = await upload(
      manifest({ resume: "engine-session-stale" }),
      "attempt-stale",
    );
    expect(stale.result).toEqual({ outcome: "created" });

    // … and still cannot advance the pointer, because the fence no longer
    // matches the session row.
    expect(
      await service.finalize({
        ...stale,
        fence: fence({ attemptId: "attempt-stale", leaseEpoch: 0 }),
        now: new Date(),
        sessionId,
        turnId: "1",
      }),
    ).toEqual({ outcome: "stale_epoch" });
    expect(checkpoints.pointer()).toBeNull();

    // The live worker publishes its own manifest under its own key.
    const live = await upload(manifest({ resume: "engine-session-live" }));
    expect(
      await service.finalize({
        ...live,
        fence: fence(),
        now: new Date(),
        sessionId,
        turnId: "1",
      }),
    ).toEqual({ outcome: "committed", revision: 0 });
    expect(checkpoints.pointer()).toMatchObject({
      manifestSha256: live.checkpoint.manifest_sha256,
    });
  });

  test("a second upload of different bytes under one attempt's key is refused", async () => {
    const first = await upload(manifest({ resume: "engine-session-1" }));
    const rewrite = await upload(manifest({ resume: "engine-session-2" }));

    expect(rewrite.result).toMatchObject({ outcome: "conflict" });
    // The stored bytes are still the first ones, so the rewrite's digest does
    // not describe anything the store holds.
    expect(
      await service.finalize({
        ...rewrite,
        fence: fence(),
        now: new Date(),
        sessionId,
        turnId: "1",
      }),
    ).toMatchObject({
      outcome: "rejected",
      reason: expect.stringMatching(/digest mismatch/),
    });
    expect(await objects.get(first.checkpoint.manifest_ref)).toEqual(
      codec.encode(manifest({ resume: "engine-session-1" })).bytes,
    );
  });

  test("refuses to promote a manifest another attempt uploaded", async () => {
    // The orphan an attempt left behind before it died. Per-attempt keys keep
    // it out of the live attempt's way only if nobody may point at it.
    const orphan = await upload(
      manifest({ resume: "engine-session-dead" }),
      "attempt-dead",
    );
    expect(orphan.result).toEqual({ outcome: "created" });

    expect(
      await service.finalize({
        ...orphan,
        fence: fence(),
        now: new Date(),
        sessionId,
        turnId: "1",
      }),
    ).toMatchObject({
      outcome: "rejected",
      reason: expect.stringMatching(/is not this attempt's key/),
    });
    expect(checkpoints.committed).toEqual([]);
    expect(checkpoints.pointer()).toBeNull();
  });

  test("refuses a fence issued for a different session", async () => {
    const { checkpoint } = await upload(manifest());

    expect(
      await service.finalize({
        checkpoint,
        fence: fence({ sessionId: "22222222-2222-4222-8222-222222222222" }),
        now: new Date(),
        sessionId,
        turnId: "1",
      }),
    ).toMatchObject({
      outcome: "rejected",
      reason: expect.stringMatching(/fence belongs to session 22222222/),
    });
    expect(checkpoints.committed).toEqual([]);
  });

  test("does not re-read parts the committed pointer already proved", async () => {
    const zero = await upload(manifest());
    await service.finalize({
      ...zero,
      fence: fence(),
      now: new Date(),
      sessionId,
      turnId: "1",
    });

    // Revision 1 keeps revision 0's parts and adds one.
    const grown = `${sessionObjectPrefix(sessionId)}mirror/root-1.jsonl`;
    const body = '{"type":"user","uuid":"r2"}\n';
    await objects.put(grown, encode(body));
    const next = manifest({ revision: 1, resume: "engine-session-2" });
    const one = await upload({
      ...next,
      transcripts: {
        ...next.transcripts,
        root: {
          entryCount: 3,
          parts: [
            ref(ROOT_PART),
            {
              bytes: encode(body).byteLength,
              key: grown,
              sha256: sha256(body),
            },
          ],
          sha256: "c".repeat(64),
        },
      },
    });

    objects.resetReads();
    expect(
      await service.finalize({
        ...one,
        fence: fence(),
        now: new Date(),
        sessionId,
        turnId: "2",
      }),
    ).toEqual({ outcome: "committed", revision: 1 });
    // Only the new part's body is fetched; the carried-over ones are not.
    expect(objects.reads().filter((key) => key === ROOT_PART)).toEqual([]);
    expect(objects.reads()).toContain(grown);
  });
});

describe("getRestorePlan", () => {
  test("a session with no pointer has nothing to restore", async () => {
    expect(await service.getRestorePlan({ runtime, sessionId })).toEqual({
      status: "none",
    });
  });

  test("names exactly the objects the manifest pins", async () => {
    const { checkpoint } = await upload(manifest());
    await service.finalize({
      checkpoint,
      fence: fence(),
      now: new Date(),
      sessionId,
      turnId: "1",
    });

    expect(await service.getRestorePlan({ runtime, sessionId })).toEqual({
      status: "ready",
      plan: {
        artifacts: [
          {
            kind: "transcript_root",
            label: "",
            objects: [ref(ROOT_PART)],
          },
          {
            kind: "transcript_subagent",
            label: "agents/reviewer",
            objects: [ref(SUB_PART)],
          },
          {
            kind: "workspace_untracked",
            label: "",
            objects: [fileRef(UNTRACKED, "notes.md")],
          },
        ],
        cwd: "/workspace",
        engine: runtime.engine,
        gitCommit: "f".repeat(40),
        manifestRef: manifestRefFor(sessionId, 0, attemptId),
        objectKeys: [ROOT_PART, SUB_PART, UNTRACKED],
        resume: "engine-session-1",
        revision: 0,
      },
    });
  });

  test("refuses an untracked file whose path escapes the workspace", async () => {
    // The key is inside the session prefix, so the storage-side check passes;
    // what is unsafe here is the destination the restore would write to.
    const { checkpoint } = await upload(
      manifest({
        workspace: {
          gitCommit: "f".repeat(40),
          untracked: [fileRef(UNTRACKED, "../../etc/notes.md")],
        },
      }),
    );

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({ status: "rejected" });
  });

  test("refuses two untracked objects claiming one destination", async () => {
    // Restoring both would leave whichever landed second, so the manifest does
    // not describe one workspace.
    const { checkpoint } = await upload(
      manifest({
        workspace: {
          gitCommit: "f".repeat(40),
          untracked: [
            fileRef(UNTRACKED, "notes.md"),
            fileRef(ROOT_PART, "notes.md"),
          ],
        },
      }),
    );

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({ status: "rejected" });
  });

  test("leaves out the untracked artifact when there is nothing untracked", async () => {
    const { checkpoint } = await upload(
      manifest({ workspace: { gitCommit: "f".repeat(40), untracked: [] } }),
    );
    await service.finalize({
      checkpoint,
      fence: fence(),
      now: new Date(),
      sessionId,
      turnId: "1",
    });

    const result = await service.getRestorePlan({ runtime, sessionId });
    if (result.status !== "ready")
      throw new Error(`expected a plan: ${result.status}`);
    expect(result.plan.artifacts.map((artifact) => artifact.kind)).toEqual([
      "transcript_root",
      "transcript_subagent",
    ]);
  });

  test("refuses to restore a checkpoint a different runtime build wrote", async () => {
    const { checkpoint } = await upload(
      manifest({ runtime: { ...runtime, sdkVersion: "0.3.100" } }),
    );
    await service.finalize({
      checkpoint,
      fence: fence(),
      now: new Date(),
      sessionId,
      turnId: "1",
    });

    expect(await service.getRestorePlan({ runtime, sessionId })).toEqual({
      status: "incompatible",
      code: "INCOMPATIBLE_CHECKPOINT",
      mismatches: [
        { expected: "0.3.270", field: "sdkVersion", found: "0.3.100" },
      ],
    });
  });

  test("refuses to restore a checkpoint written under a different config profile", async () => {
    const { checkpoint } = await upload(
      manifest({ runtime: { ...runtime, profileSha256: "9".repeat(64) } }),
    );
    await service.finalize({
      checkpoint,
      fence: fence(),
      now: new Date(),
      sessionId,
      turnId: "1",
    });

    expect(await service.getRestorePlan({ runtime, sessionId })).toMatchObject({
      status: "incompatible",
      code: "INCOMPATIBLE_CHECKPOINT",
    });
  });

  test("reports a pointer whose manifest object has gone missing", async () => {
    const { checkpoint } = await upload(manifest());
    await service.finalize({
      checkpoint,
      fence: fence(),
      now: new Date(),
      sessionId,
      turnId: "1",
    });
    objects.remove(checkpoint.manifest_ref);

    expect(await service.getRestorePlan({ runtime, sessionId })).toMatchObject({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
    });
  });

  test("reports a pointer whose transcript parts have gone missing", async () => {
    const { checkpoint } = await upload(manifest());
    await service.finalize({
      checkpoint,
      fence: fence(),
      now: new Date(),
      sessionId,
      turnId: "1",
    });
    objects.remove(ROOT_PART);

    expect(await service.getRestorePlan({ runtime, sessionId })).toMatchObject({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
    });
  });
});

function ready() {
  return {
    status: "ready" as const,
    checkpoint: {
      engine: runtime.engine,
      resume: "engine-session-1",
      sdkVersion: runtime.sdkVersion,
    },
  };
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
