import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  CheckpointCodec,
  CheckpointManifest,
  CheckpointWorkspace,
  ObjectRef,
  RuntimeFingerprint,
  WorkspaceArtifact,
} from "@agent-platform/runtime-core";
import {
  createMemoryCheckpointObjectStore,
  type MemoryCheckpointObjectStore,
} from "@agent-platform/testkit/checkpoint-objects";
import { createGitBundle } from "@agent-platform/testkit/git-bundle";

import type {
  CheckpointFence,
  CheckpointPointer,
  CheckpointStore,
  CommitCheckpointInput,
  CommitCheckpointResult,
} from "../ports/checkpoint-store.ts";
import {
  structuralBundleVerifier,
  type WorkspaceBundleVerifier,
} from "../ports/workspace-bundle-verifier.ts";
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

// Real `git bundle` bytes, so what the service accepts is what git can restore.
const workspaceBundle = await createGitBundle();

/** A bundle lives beside the manifest that names it, in the attempt's own dir. */
function bundleKeyFor(revision: number, attempt: string): string {
  const ref = manifestRefFor(sessionId, revision, attempt);
  return `${ref.slice(0, ref.lastIndexOf("/") + 1)}workspace.bundle`;
}

const BUNDLE = bundleKeyFor(0, attemptId);

function bundleRef(key = BUNDLE): ObjectRef {
  return {
    bytes: workspaceBundle.bytes.byteLength,
    key,
    sha256: workspaceBundle.sha256,
  };
}

function ref(key: string): ObjectRef {
  const body = ARTIFACTS[key] ?? "";
  return { bytes: encode(body).byteLength, key, sha256: sha256(body) };
}

function fileRef(key: string, path: string): WorkspaceArtifact {
  return { ...ref(key), path };
}

function manifest(
  overrides: Partial<CheckpointManifest> = {},
  attempt = attemptId,
): CheckpointManifest {
  const revision = overrides.revision ?? 0;
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
    version: 2,
    workspace: workspace({
      bundle: bundleRef(bundleKeyFor(revision, attempt)),
    }),
    ...overrides,
  };
}

function workspace(
  overrides: Partial<CheckpointWorkspace> = {},
): CheckpointWorkspace {
  return {
    bundle: bundleRef(),
    gitCommit: workspaceBundle.commit,
    untracked: [fileRef(UNTRACKED, "notes.md")],
    ...overrides,
  };
}

/**
 * Pointer CAS with the two rules the database enforces: the fence must still
 * own the session, and revisions only move up.
 */
function memoryCheckpointStore(owner: CheckpointFence = fence()) {
  let pointer: CheckpointPointer | null = null;
  const history: CheckpointPointer[] = [];
  const committed: CommitCheckpointInput[] = [];
  const store: CheckpointStore = {
    async readPointer() {
      return pointer;
    },
    async listCheckpoints(_sessionId, { belowRevision, limit }) {
      return history
        .filter((row) => row.revision < belowRevision)
        .sort((left, right) => right.revision - left.revision)
        .slice(0, limit);
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
      history.push(pointer);
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
  for (const [revision, attempt] of [
    [0, attemptId],
    [1, attemptId],
    [2, attemptId],
    [0, "attempt-2"],
    [0, "attempt-stale"],
  ] as Array<[number, string]>) {
    await objects.put(bundleKeyFor(revision, attempt), workspaceBundle.bytes);
  }
  checkpoints = memoryCheckpointStore();
  service = createCheckpointService({
    codecs: { [runtime.engine]: codec },
    objectProtection: "unversioned",
    objects,
    store: checkpoints.store,
    workspaceBundles: structuralBundleVerifier,
  });
});

/** A second service over the same objects, fenced to a different owner. */
function serviceOwnedBy(owner: CheckpointFence) {
  const store = memoryCheckpointStore(owner);
  return {
    store,
    service: createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objectProtection: "unversioned",
      objects,
      store: store.store,
      workspaceBundles: structuralBundleVerifier,
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

    const second = await upload(manifest({}, "attempt-2"), "attempt-2");
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

  test("refuses a commit the workspace bundle cannot produce", async () => {
    // The whole point of the ticket: 40 hex characters are not a commit. The
    // manifest is otherwise perfect, the bundle is a real one, and the commit
    // simply is not in it.
    const { checkpoint } = await upload(
      manifest({ workspace: workspace({ gitCommit: "f".repeat(40) }) }),
    );

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: `workspace bundle ${BUNDLE} cannot restore ${"f".repeat(40)}: git bundle does not offer ${"f".repeat(40)} as a ref tip`,
    });
  });

  test("refuses a bundle that is not a bundle", async () => {
    const body = encode("not a bundle at all\n");
    await objects.put(BUNDLE, body);
    const { checkpoint } = await upload(
      manifest({
        workspace: workspace({
          bundle: {
            bytes: body.byteLength,
            key: BUNDLE,
            sha256: sha256("not a bundle at all\n"),
          },
        }),
      }),
    );

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/cannot restore .*: not a git bundle/),
    });
  });

  test("refuses a workspace bundle that was never uploaded", async () => {
    objects.remove(BUNDLE);
    const { checkpoint } = await upload(manifest());

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: `manifest references a missing workspace bundle: ${BUNDLE}`,
    });
  });

  test("refuses a workspace bundle whose stored size is not the declared one", async () => {
    await objects.put(BUNDLE, workspaceBundle.bytes.slice(0, 32));
    const { checkpoint } = await upload(manifest());

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(
        new RegExp(`workspace bundle ${BUNDLE} is 32 bytes, not`),
      ),
    });
  });

  test("refuses a workspace bundle replaced by different bytes of the same length", async () => {
    const swapped = new Uint8Array(workspaceBundle.bytes);
    // The first character of the header's first ref line: same length as the
    // real bundle, so only a digest tells them apart.
    const firstRefLine = swapped.indexOf(0x0a) + 1;
    swapped.set([(swapped[firstRefLine] ?? 0) ^ 0x01], firstRefLine);
    await objects.put(BUNDLE, swapped);
    const { checkpoint } = await upload(manifest());

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(
        new RegExp(`workspace bundle ${BUNDLE} hashes to [0-9a-f]{64}, not`),
      ),
    });
  });

  test("refuses a workspace bundle stored outside the session namespace", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const stolen = `${sessionObjectPrefix(other)}workspace/workspace.bundle`;
    await objects.put(stolen, workspaceBundle.bytes);
    const { checkpoint } = await upload(
      manifest({
        workspace: workspace({ bundle: { ...bundleRef(), key: stolen } }),
      }),
    );

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: `manifest references an object outside ${sessionObjectPrefix(sessionId)}: ${stolen}`,
    });
  });

  test("refuses a workspace bundle larger than the control plane will read", async () => {
    // Verifying means holding the object whole to hash it, so the ceiling is
    // checked against the declared size before anything is fetched.
    const small = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objectProtection: "unversioned",
      maxWorkspaceBundleBytes: 16,
      objects,
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });
    const { checkpoint } = await upload(manifest());

    expect(
      await small.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(
        /over the 16 the control plane will verify/,
      ),
    });
  });

  test("refuses a manifest over the byte limit without fetching its body", async () => {
    // The worker wrote it: its size is untrusted, so a HEAD decides first.
    const fetched: string[] = [];
    const watched = {
      ...objects,
      head: objects.head.bind(objects),
      async get(key: string) {
        fetched.push(key);
        return objects.get(key);
      },
    };
    const capped = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objectProtection: "unversioned",
      maxManifestBytes: 64,
      objects: watched,
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });
    const { checkpoint } = await upload(manifest());

    expect(
      await capped.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/over the 64-byte limit/),
    });
    expect(fetched).toEqual([]);
  });

  test("refuses a manifest naming more objects than the limit before any request", async () => {
    const heads: string[] = [];
    const watched = {
      ...objects,
      get: objects.get.bind(objects),
      async head(key: string) {
        heads.push(key);
        return objects.head(key);
      },
    };
    const capped = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objectProtection: "unversioned",
      maxManifestObjects: 1,
      objects: watched,
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });
    const { checkpoint } = await upload(manifest());

    expect(
      await capped.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/over the 1-object limit/),
    });
    // Only the manifest itself was looked at.
    expect(heads).toEqual([checkpoint.manifest_ref]);
  });

  test("defers the commit question to the injected bundle verifier", async () => {
    // A deployment that wants git-grade assurance swaps this port out; the
    // service must ask it rather than settle the question itself.
    const asked: string[] = [];
    const workspaceBundles: WorkspaceBundleVerifier = {
      async verify(input) {
        asked.push(input.commit);
        return { status: "unusable", reason: "git says no" };
      },
    };
    const strict = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objectProtection: "unversioned",
      objects,
      store: checkpoints.store,
      workspaceBundles,
    });
    const { checkpoint } = await upload(manifest());

    expect(
      await strict.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: `workspace bundle ${BUNDLE} cannot restore ${workspaceBundle.commit}: git says no`,
    });
    expect(asked).toEqual([workspaceBundle.commit]);
  });

  test("commits nothing when no bundle verifier is configured", async () => {
    // The default is fail-closed: promoting a pointer on a check nobody chose
    // only shows up as damage at the next restore, when the execution that
    // wrote it is gone and the last healthy revision has been superseded.
    const unconfigured = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objectProtection: "unversioned",
      objects,
      store: checkpoints.store,
    });
    const { checkpoint } = await upload(manifest());

    expect(
      await unconfigured.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/no workspace bundle verifier configured/),
    });
  });

  test("refuses a bundle that is not in this attempt's own directory", async () => {
    // A key the session reuses across revisions is either overwritten — so the
    // committed checkpoint stops describing what is stored — or refused by
    // create-only forever after the first one.
    const shared = `${sessionObjectPrefix(sessionId)}workspace/workspace.bundle`;
    await objects.put(shared, workspaceBundle.bytes);
    const { checkpoint } = await upload(
      manifest({ workspace: workspace({ bundle: bundleRef(shared) }) }),
    );

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/is not under this attempt's /),
    });
  });

  test("refuses another attempt's bundle even inside the same session", async () => {
    const { checkpoint } = await upload(
      manifest({
        workspace: workspace({
          bundle: bundleRef(bundleKeyFor(0, "attempt-2")),
        }),
      }),
    );

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({
      status: "rejected",
      reason: expect.stringMatching(/is not under this attempt's /),
    });
  });

  test("never verifies more bundles at once than it was allowed to", async () => {
    // The size ceiling bounds one bundle; this is what bounds the process.
    let inFlight = 0;
    let peak = 0;
    const workspaceBundles: WorkspaceBundleVerifier = {
      async verify() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { status: "restorable" };
      },
    };
    const gated = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objectProtection: "unversioned",
      maxConcurrentBundleVerifications: 2,
      objects,
      store: checkpoints.store,
      workspaceBundles,
    });
    const { checkpoint } = await upload(manifest());

    const verdicts = await Promise.all(
      Array.from({ length: 8 }, () =>
        gated.validateManifest({ checkpoint, sessionId }),
      ),
    );

    expect(verdicts.every((verdict) => verdict.status === "verified")).toBe(
      true,
    );
    expect(peak).toBe(2);
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

  test("keeps the last healthy pointer when the next commit is not restorable", async () => {
    // The failure this guards: revision 0 is good, revision 1 names a commit
    // nothing can produce, and promoting it would retire the one checkpoint
    // the session could still have resumed from.
    const zero = await upload(manifest());
    await service.finalize({
      ...zero,
      fence: fence(),
      now: new Date(),
      sessionId,
      turnId: "1",
    });
    const one = await upload(
      manifest({
        resume: "engine-session-2",
        revision: 1,
        workspace: workspace({ gitCommit: "d".repeat(40) }),
      }),
    );

    expect(
      await service.finalize({
        ...one,
        fence: fence(),
        now: new Date(),
        sessionId,
        turnId: "2",
      }),
    ).toMatchObject({ outcome: "rejected" });
    expect(checkpoints.pointer()).toMatchObject({
      manifestSha256: zero.checkpoint.manifest_sha256,
      revision: 0,
    });
    expect(await service.getRestorePlan({ runtime, sessionId })).toMatchObject({
      status: "ready",
      plan: { gitCommit: workspaceBundle.commit, revision: 0 },
    });
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
      manifest({ resume: "engine-session-stale" }, "attempt-stale"),
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

  // The versioned counterpart, which does skip them, is in
  // checkpoint-versions.test.ts.
  test("re-reads parts the committed pointer proved when nothing pins their version", async () => {
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
    // A key can be rewritten with different bytes of the same length, which
    // the HEAD that still runs cannot tell apart, so the old part is hashed
    // again rather than trusted.
    expect(objects.reads()).toContain(ROOT_PART);
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
            kind: "workspace_bundle",
            label: "",
            objects: [bundleRef()],
          },
          {
            kind: "workspace_untracked",
            label: "",
            objects: [fileRef(UNTRACKED, "notes.md")],
          },
        ],
        cwd: "/workspace",
        engine: runtime.engine,
        gitCommit: workspaceBundle.commit,
        manifestRef: manifestRefFor(sessionId, 0, attemptId),
        objectKeys: [ROOT_PART, SUB_PART, BUNDLE, UNTRACKED],
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
        workspace: workspace({
          untracked: [fileRef(UNTRACKED, "../../etc/notes.md")],
        }),
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
        workspace: workspace({
          untracked: [
            fileRef(UNTRACKED, "notes.md"),
            fileRef(ROOT_PART, "notes.md"),
          ],
        }),
      }),
    );

    expect(
      await service.validateManifest({ checkpoint, sessionId }),
    ).toMatchObject({ status: "rejected" });
  });

  test.each([
    [["./notes.md"], '"./notes.md" has a "." segment'],
    [[".git/hooks/pre-commit"], '".git/hooks/pre-commit" writes into .git'],
    [
      ["notes.md", "notes.md/inner"],
      "notes.md is restored both as a file and as the directory of notes.md/inner",
    ],
  ])("refuses untracked destinations %p", async (paths, problem) => {
    const { checkpoint } = await upload(
      manifest({
        workspace: workspace({
          untracked: paths.map((path, index) =>
            fileRef(index === 0 ? UNTRACKED : ROOT_PART, path),
          ),
        }),
      }),
    );

    expect(await service.validateManifest({ checkpoint, sessionId })).toEqual({
      status: "rejected",
      reason: `manifest restores untracked files unsafely: ${problem}`,
    });
  });

  test("leaves out the untracked artifact when there is nothing untracked", async () => {
    const { checkpoint } = await upload(
      manifest({ workspace: workspace({ untracked: [] }) }),
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
      "workspace_bundle",
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

describe("getRestorePlan falls back to an earlier revision (94S-204)", () => {
  const LATER_PART = `${sessionObjectPrefix(sessionId)}mirror/root-1.jsonl`;

  /** Commits revisions 0..last, each adding one transcript part. */
  async function commitRevisions(last: number) {
    const committed = [];
    for (let revision = 0; revision <= last; revision += 1) {
      await objects.put(
        bundleKeyFor(revision, attemptId),
        workspaceBundle.bytes,
      );
      const parts = [ref(ROOT_PART)];
      if (revision > 0) {
        const key = `${sessionObjectPrefix(sessionId)}mirror/root-${revision}.jsonl`;
        const body = `{"type":"user","uuid":"r${revision + 1}"}\n`;
        await objects.put(key, encode(body));
        parts.push({
          bytes: encode(body).byteLength,
          key,
          sha256: sha256(body),
        });
      }
      const { checkpoint } = await upload(
        manifest({
          resume: `engine-session-${revision}`,
          revision,
          transcripts: {
            root: { entryCount: 2, parts, sha256: "c".repeat(64) },
            subagents: {},
          },
        }),
      );
      expect(
        await service.finalize({
          checkpoint,
          fence: fence(),
          now: new Date(),
          sessionId,
          turnId: String(revision + 1),
        }),
      ).toMatchObject({ outcome: "committed", revision });
      committed.push(checkpoint);
    }
    return committed;
  }

  test("the store lists committed revisions below the one asked, newest first, bounded", async () => {
    await commitRevisions(3);
    const listed = await checkpoints.store.listCheckpoints(sessionId, {
      belowRevision: 3,
      limit: 2,
    });
    expect(listed.map((row) => row.revision)).toEqual([2, 1]);
    expect(listed[0]).toMatchObject({
      manifestRef: manifestRefFor(sessionId, 2, attemptId),
      turnId: "3",
    });
    expect(
      await checkpoints.store.listCheckpoints(sessionId, {
        belowRevision: 0,
        limit: 5,
      }),
    ).toEqual([]);
  });

  test("restores revision 0 when an artifact of revision 1 has gone missing, and says so", async () => {
    await commitRevisions(1);
    objects.remove(LATER_PART);

    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result).toMatchObject({
      status: "ready",
      plan: {
        manifestRef: manifestRefFor(sessionId, 0, attemptId),
        resume: "engine-session-0",
        revision: 0,
        fallback: {
          pointerRevision: 1,
          skipped: [
            {
              revision: 1,
              reason: `manifest references a missing object: ${LATER_PART}`,
            },
          ],
        },
      },
    });
    if (result.status !== "ready") return;
    expect(result.plan.objectKeys).not.toContain(LATER_PART);
  });

  test("falls back past a pointer whose manifest itself is gone", async () => {
    const [, latest] = await commitRevisions(1);
    objects.remove(latest?.manifest_ref as string);

    expect(await service.getRestorePlan({ runtime, sessionId })).toMatchObject({
      status: "ready",
      plan: {
        revision: 0,
        fallback: { pointerRevision: 1, skipped: [{ revision: 1 }] },
      },
    });
  });

  test("walks down past every broken revision and lists each one it skipped", async () => {
    const [, second, third] = await commitRevisions(2);
    objects.remove(third?.manifest_ref as string);
    objects.remove(second?.manifest_ref as string);

    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result).toMatchObject({
      status: "ready",
      plan: { revision: 0, fallback: { pointerRevision: 2 } },
    });
    if (result.status !== "ready") return;
    expect(result.plan.fallback?.skipped.map((skip) => skip.revision)).toEqual([
      2, 1,
    ]);
  });

  test("a plan from a healthy pointer carries no fallback", async () => {
    await commitRevisions(1);
    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result).toMatchObject({ status: "ready", plan: { revision: 1 } });
    if (result.status !== "ready") return;
    expect(result.plan).not.toHaveProperty("fallback");
  });

  test("is CHECKPOINT_UNAVAILABLE when no revision verifies", async () => {
    const [first, second] = await commitRevisions(1);
    objects.remove(first?.manifest_ref as string);
    objects.remove(second?.manifest_ref as string);

    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result).toMatchObject({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
    });
    if (result.status !== "unavailable") return;
    expect(result.reason).toContain(
      `manifest object is missing: ${second?.manifest_ref}`,
    );
    expect(result.reason).toContain("none of the 1 earlier revisions");
  });

  test("tries no more earlier revisions than it is allowed to", async () => {
    const [, second, third] = await commitRevisions(2);
    objects.remove(third?.manifest_ref as string);
    objects.remove(second?.manifest_ref as string);
    const limited = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      maxRestoreFallbacks: 1,
      objectProtection: "unversioned",
      objects,
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });

    expect(await limited.getRestorePlan({ runtime, sessionId })).toMatchObject({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
    });
  });

  test("with fallback turned off, a broken pointer is unavailable and nothing earlier is listed", async () => {
    const [, second] = await commitRevisions(1);
    objects.remove(second?.manifest_ref as string);
    let listed = 0;
    const off = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      maxRestoreFallbacks: 0,
      objectProtection: "unversioned",
      objects,
      store: {
        ...checkpoints.store,
        listCheckpoints(...args) {
          listed += 1;
          return checkpoints.store.listCheckpoints(...args);
        },
      },
      workspaceBundles: structuralBundleVerifier,
    });

    expect(await off.getRestorePlan({ runtime, sessionId })).toMatchObject({
      status: "unavailable",
    });
    expect(listed).toBe(0);
    expect(() =>
      createCheckpointService({
        codecs: {},
        maxRestoreFallbacks: -1,
        objectProtection: "unversioned",
        objects,
        store: checkpoints.store,
      }),
    ).toThrow(/maxRestoreFallbacks/);
  });

  test("an object store that throws is an outage, not a reason to restore something older", async () => {
    await commitRevisions(1);
    const flaky = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objectProtection: "unversioned",
      objects: {
        ...objects,
        async head(key, version) {
          if (key === LATER_PART) throw new Error("S3 is down");
          return objects.head(key, version);
        },
      },
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });

    await expect(flaky.getRestorePlan({ runtime, sessionId })).rejects.toThrow(
      /S3 is down/,
    );
  });

  test("an earlier revision is hashed in full rather than trusted", async () => {
    await commitRevisions(1);
    objects.remove(LATER_PART);
    // Same length, different bytes: only a hash tells them apart.
    await objects.put(ROOT_PART, encode('{"type":"user","uuid":"XX"}\n'));

    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result).toMatchObject({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
    });
  });

  test("a pointer refused for anything but damage does not fall back", async () => {
    await commitRevisions(1);
    // A limit lowered since the commit refuses revision 1; revision 0 is
    // smaller and would pass, which is exactly why it must not be tried.
    const stricter = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      maxManifestObjects: 3,
      objectProtection: "unversioned",
      objects,
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });

    const result = await stricter.getRestorePlan({ runtime, sessionId });
    expect(result).toMatchObject({
      status: "unavailable",
      code: "CHECKPOINT_UNAVAILABLE",
    });
    if (result.status !== "unavailable") return;
    expect(result.reason).toMatch(/over the 3-object limit/);
  });

  test("an earlier revision refused for anything but damage ends the search", async () => {
    const [first, , third] = await commitRevisions(2);
    objects.remove(third?.manifest_ref as string);
    // Revision 1 verifies only under a limit revision 0 fails; revision 1 is
    // then damaged, and the refusal of 0 must stop the walk, not skip it.
    objects.remove(LATER_PART);
    const stricter = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      maxManifestBytes: 1,
      objectProtection: "unversioned",
      objects,
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });

    const result = await stricter.getRestorePlan({ runtime, sessionId });
    expect(result).toMatchObject({ status: "unavailable" });
    if (result.status !== "unavailable") return;
    expect(result.reason).toContain(
      `manifest object is missing: ${third?.manifest_ref}`,
    );
    expect(result.reason).toContain("earlier revision 1 is refused");
    expect(first?.revision).toBe(0);
  });

  test("an earlier revision the runtime cannot resume is reported, not skipped", async () => {
    await commitRevisions(1);
    objects.remove(LATER_PART);

    const result = await service.getRestorePlan({
      runtime: { ...runtime, sdkVersion: "0.3.999" },
      sessionId,
    });
    expect(result).toEqual({
      status: "incompatible",
      code: "INCOMPATIBLE_CHECKPOINT",
      mismatches: [
        { expected: "0.3.999", field: "sdkVersion", found: "0.3.270" },
      ],
      fallback: {
        pointerRevision: 1,
        revision: 0,
        skipped: [
          {
            revision: 1,
            reason: `manifest references a missing object: ${LATER_PART}`,
          },
        ],
      },
    });
  });

  test("a checkpoint built on the fallback commits as the next revision and restores without one", async () => {
    await commitRevisions(1);
    objects.remove(LATER_PART);
    const fallback = await service.getRestorePlan({ runtime, sessionId });
    if (fallback.status !== "ready") throw new Error("expected a plan");
    expect(fallback.plan.revision).toBe(0);

    // The restored worker checkpoints on top of revision 0's transcript, and
    // is handed the revision after the pointer, not after what it restored.
    const next = await service.requestCheckpoint({
      attemptId,
      preparation: ready(),
      sessionId,
    });
    expect(next).toMatchObject({ status: "ready", request: { revision: 2 } });
    const grown = `${sessionObjectPrefix(sessionId)}mirror/root-2b.jsonl`;
    const body = '{"type":"user","uuid":"r2b"}\n';
    await objects.put(grown, encode(body));
    const inherited = fallback.plan.artifacts[0]?.objects ?? [];
    const { checkpoint } = await upload(
      manifest({
        resume: "engine-session-2",
        revision: 2,
        transcripts: {
          root: {
            entryCount: 2,
            parts: [
              ...inherited,
              {
                bytes: encode(body).byteLength,
                key: grown,
                sha256: sha256(body),
              },
            ],
            sha256: "c".repeat(64),
          },
          subagents: {},
        },
      }),
    );
    expect(
      await service.finalize({
        checkpoint,
        fence: fence(),
        now: new Date(),
        sessionId,
        turnId: "3",
      }),
    ).toEqual({ outcome: "committed", revision: 2 });

    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result).toMatchObject({
      status: "ready",
      plan: { revision: 2, resume: "engine-session-2" },
    });
    if (result.status !== "ready") return;
    expect(result.plan).not.toHaveProperty("fallback");
    expect(result.plan.objectKeys).toContain(grown);
    expect(result.plan.objectKeys).not.toContain(LATER_PART);
  });

  test("never tries more than the ceiling allows", () => {
    expect(() =>
      createCheckpointService({
        codecs: {},
        maxRestoreFallbacks: 11,
        objectProtection: "unversioned",
        objects,
        store: checkpoints.store,
      }),
    ).toThrow(/from 0 to 10/);
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
