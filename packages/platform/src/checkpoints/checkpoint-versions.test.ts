import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { CheckpointRef } from "@agent-platform/contracts";
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

import type {
  CheckpointFence,
  CheckpointPointer,
  CheckpointStore,
} from "../ports/checkpoint-store.ts";
import { structuralBundleVerifier } from "../ports/workspace-bundle-verifier.ts";
import {
  createCheckpointService,
  manifestRefFor,
  sessionObjectPrefix,
} from "./checkpoint-service.ts";

/**
 * 94S-229: what a checkpoint verified is what it restores. Every object is
 * named by version, finalize reads those versions and holds them, and the
 * pointer and the restore plan carry them — so a key overwritten, deleted or
 * reused after the commit changes nothing the session resumes from.
 */

const sessionId = "44444444-4444-4444-8444-444444444444";
const attemptId = "attempt-1";
const prefix = sessionObjectPrefix(sessionId);
const runtime: RuntimeFingerprint = {
  cliVersion: "2.1.270",
  engine: "claude",
  profileSha256: "a".repeat(64),
  sdkVersion: "0.3.270",
};
const fence: CheckpointFence = {
  attemptId,
  authRevision: 1,
  executionGeneration: 1,
  leaseEpoch: 1,
  sessionId,
};

// The service is under test, not a manifest schema: JSON in, JSON out.
const codec: CheckpointCodec = {
  engine: runtime.engine,
  encode(manifest) {
    const text = `${JSON.stringify(manifest)}\n`;
    return { bytes: encode(text), sha256: sha256(encode(text)) };
  },
  decode(bytes) {
    return JSON.parse(new TextDecoder().decode(bytes)) as CheckpointManifest;
  },
  validateCompatibility() {
    return { status: "compatible" };
  },
};

const workspaceBundle = await createGitBundle();

function attemptDirectory(revision: number): string {
  const ref = manifestRefFor(sessionId, revision, attemptId);
  return ref.slice(0, ref.lastIndexOf("/") + 1);
}

/** The pointer store, recording the version the way the database does. */
function memoryCheckpointStore() {
  let pointer: CheckpointPointer | null = null;
  let commits = 0;
  const store: CheckpointStore = {
    async readPointer() {
      return pointer;
    },
    async commitAtomic(input) {
      if (pointer !== null && input.checkpoint.revision <= pointer.revision) {
        return { outcome: "conflict", currentRevision: pointer.revision };
      }
      commits += 1;
      pointer = {
        committedAt: input.now,
        manifestRef: input.checkpoint.manifest_ref,
        manifestSha256: input.checkpoint.manifest_sha256,
        manifestVersion: input.checkpoint.manifest_version ?? null,
        revision: input.checkpoint.revision,
        turnId: input.turnId,
      };
      return { outcome: "committed", revision: input.checkpoint.revision };
    },
  };
  return { commits: () => commits, pointer: () => pointer, store };
}

let objects: MemoryCheckpointObjectStore;
let checkpoints: ReturnType<typeof memoryCheckpointStore>;
let service: ReturnType<typeof createCheckpointService>;

beforeEach(() => {
  objects = createMemoryCheckpointObjectStore({ versioned: true });
  checkpoints = memoryCheckpointStore();
  service = createCheckpointService({
    codecs: { [runtime.engine]: codec },
    objects,
    store: checkpoints.store,
    workspaceBundles: structuralBundleVerifier,
  });
});

/** A worker's upload: create-only, keeping the version the store answered. */
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

async function publish(
  revision: number,
  parts: readonly ObjectRef[],
  edit: (manifest: CheckpointManifest) => CheckpointManifest = (m) => m,
) {
  const directory = attemptDirectory(revision);
  const bundle = await upload(
    `${directory}workspace.bundle`,
    workspaceBundle.bytes,
  );
  const notes = await upload(`${directory}untracked/notes.md`, encode("n\n"));
  const manifest = edit({
    createdAt: "2026-09-23T00:00:00.000Z",
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
  const manifestRef = manifestRefFor(sessionId, revision, attemptId);
  const encoded = codec.encode(manifest);
  const stored = await upload(manifestRef, encoded.bytes);
  return {
    checkpoint: {
      manifest_ref: manifestRef,
      manifest_sha256: encoded.sha256,
      manifest_version: stored.version as string,
      revision,
    },
    manifest,
  };
}

function finalize(checkpoint: CheckpointRef) {
  return service.finalize({
    checkpoint,
    fence,
    now: new Date("2026-09-23T00:00:00.000Z"),
    sessionId,
    turnId: null,
  });
}

function everyRef(manifest: CheckpointManifest): ObjectRef[] {
  return [
    ...manifest.transcripts.root.parts,
    manifest.workspace.bundle,
    ...manifest.workspace.untracked,
  ];
}

describe("locked (the default)", () => {
  test("will not run over a store that cannot hold versions", () => {
    expect(() =>
      createCheckpointService({
        codecs: { [runtime.engine]: codec },
        objects: createMemoryCheckpointObjectStore(),
        store: checkpoints.store,
        workspaceBundles: structuralBundleVerifier,
      }),
    ).toThrow(/objectProtection "locked" needs an object store that can hold/);
  });

  test("records the verified manifest version on the pointer and holds every version the checkpoint names", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const { checkpoint, manifest } = await publish(0, [part]);

    expect(await finalize(checkpoint)).toEqual({
      outcome: "committed",
      revision: 0,
    });
    expect(checkpoints.pointer()?.manifestVersion).toBe(
      checkpoint.manifest_version,
    );
    for (const ref of everyRef(manifest)) {
      expect(await objects.head(ref.key, ref.version)).toMatchObject({
        held: true,
        version: ref.version,
      });
    }
    expect(
      await objects.head(checkpoint.manifest_ref, checkpoint.manifest_version),
    ).toMatchObject({ held: true });
  });

  test("the restore plan names the versions finalize verified", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const { checkpoint, manifest } = await publish(0, [part]);
    await finalize(checkpoint);

    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result).toEqual({
      status: "ready",
      plan: {
        artifacts: [
          { kind: "transcript_root", label: "", objects: [part] },
          {
            kind: "workspace_bundle",
            label: "",
            objects: [manifest.workspace.bundle],
          },
          {
            kind: "workspace_untracked",
            label: "",
            objects: manifest.workspace.untracked,
          },
        ],
        cwd: "/workspace",
        engine: "claude",
        gitCommit: workspaceBundle.commit,
        manifestRef: checkpoint.manifest_ref,
        manifestVersion: checkpoint.manifest_version,
        objectKeys: everyRef(manifest).map((ref) => ref.key),
        resume: "engine-session-0",
        revision: 0,
      },
    });
    for (const ref of everyRef(manifest)) expect(ref.version).toBeString();
  });

  test("a key overwritten, deleted or reused after the commit leaves the plan on the versions it verified", async () => {
    const original = encode("a\n");
    const part = await upload(`${prefix}mirror/part-0.jsonl`, original);
    const { checkpoint, manifest } = await publish(0, [part]);
    await finalize(checkpoint);

    // A privileged overwrite with bytes of the same length, a delete marker,
    // and a create-only write that lands again once the key reads as absent.
    await objects.put(part.key, encode("b\n"));
    await objects.put(checkpoint.manifest_ref, encode("{}\n"));
    const untracked = manifest.workspace.untracked[0] as ObjectRef;
    objects.remove(untracked.key);
    objects.remove(manifest.workspace.bundle.key);
    await objects.putImmutable(manifest.workspace.bundle.key, encode("x"));

    const result = await service.getRestorePlan({ runtime, sessionId });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.plan.manifestVersion).toBe(checkpoint.manifest_version);
    expect(result.plan.artifacts[0]?.objects).toEqual([part]);
    // What the worker downloads by those versions is what was verified.
    expect(await objects.get(part.key, part.version)).toEqual(original);
    expect(await objects.get(part.key)).toEqual(encode("b\n"));
  });

  test("a held version cannot be destroyed", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const { checkpoint } = await publish(0, [part]);
    await finalize(checkpoint);

    expect(() =>
      objects.purgeVersion(part.key, part.version as string),
    ).toThrow(/under a legal hold/);
    expect(await objects.get(part.key, part.version)).toEqual(encode("a\n"));
  });

  test("refuses a checkpoint whose manifest is not named by version", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const { checkpoint } = await publish(0, [part]);
    const { manifest_version: _version, ...unpinned } = checkpoint;

    expect(await finalize(unpinned)).toEqual({
      outcome: "rejected",
      reason: expect.stringMatching(/is not named by version/),
    });
    expect(checkpoints.commits()).toBe(0);
  });

  test("refuses a manifest naming an object without its version", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const { version: _version, ...loose } = part;
    const { checkpoint } = await publish(0, [loose]);

    expect(await finalize(checkpoint)).toEqual({
      outcome: "rejected",
      reason: expect.stringMatching(
        new RegExp(`names ${part.key} without a version`),
      ),
    });
    expect(checkpoints.commits()).toBe(0);
    // Nothing was held for a checkpoint that did not verify.
    expect(await objects.head(part.key, part.version)).not.toHaveProperty(
      "held",
    );
  });

  test("refuses a version the store never issued", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const { checkpoint } = await publish(0, [{ ...part, version: "v999" }]);

    expect(await finalize(checkpoint)).toEqual({
      outcome: "rejected",
      reason: expect.stringMatching(/missing object: .* \(version v999\)/),
    });
  });

  test("a hold that fails leaves the pointer where it was", async () => {
    const part = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    const { checkpoint } = await publish(0, [part]);
    const failing = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objects: {
        ...objects,
        async hold() {
          throw new Error("AccessDenied");
        },
      },
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });

    await expect(
      failing.finalize({
        checkpoint,
        fence,
        now: new Date(),
        sessionId,
        turnId: null,
      }),
    ).rejects.toThrow(/AccessDenied/);
    expect(checkpoints.pointer()).toBeNull();
  });

  test("does not re-read a version the committed pointer already proved, but still holds it", async () => {
    const first = await upload(`${prefix}mirror/part-0.jsonl`, encode("a\n"));
    await finalize((await publish(0, [first])).checkpoint);

    const grown = await upload(`${prefix}mirror/part-1.jsonl`, encode("b\n"));
    const { checkpoint } = await publish(1, [first, grown]);
    objects.resetReads();
    expect(await finalize(checkpoint)).toEqual({
      outcome: "committed",
      revision: 1,
    });
    expect(objects.reads()).not.toContain(first.key);
    expect(objects.reads()).toContain(grown.key);
    expect(await objects.head(grown.key, grown.version)).toMatchObject({
      held: true,
    });
  });
});

describe("unversioned", () => {
  test("reads by key, ignores versions a manifest carries, and holds nothing", async () => {
    const plain = createMemoryCheckpointObjectStore();
    objects = plain as MemoryCheckpointObjectStore;
    const degraded = createCheckpointService({
      codecs: { [runtime.engine]: codec },
      objectProtection: "unversioned",
      objects: plain,
      store: checkpoints.store,
      workspaceBundles: structuralBundleVerifier,
    });
    const body = encode("a\n");
    await plain.putImmutable(`${prefix}mirror/part-0.jsonl`, body);
    // Versions from a store this one is not — a bucket restored from a
    // backup keeps the manifests but issues every object a new version.
    const part = {
      bytes: body.byteLength,
      key: `${prefix}mirror/part-0.jsonl`,
      sha256: sha256(body),
      version: "from-another-bucket",
    };
    const directory = attemptDirectory(0);
    await plain.putImmutable(
      `${directory}workspace.bundle`,
      workspaceBundle.bytes,
    );
    const manifest: CheckpointManifest = {
      createdAt: "2026-09-23T00:00:00.000Z",
      cwd: "/workspace",
      engine: runtime.engine,
      resume: "engine-session-0",
      revision: 0,
      runtime,
      sessionId,
      transcripts: {
        root: { entryCount: 1, parts: [part], sha256: "c".repeat(64) },
        subagents: {},
      },
      version: 2,
      workspace: {
        bundle: {
          bytes: workspaceBundle.bytes.byteLength,
          key: `${directory}workspace.bundle`,
          sha256: workspaceBundle.sha256,
          version: "from-another-bucket",
        },
        gitCommit: workspaceBundle.commit,
        untracked: [],
      },
    };
    const manifestRef = manifestRefFor(sessionId, 0, attemptId);
    const encoded = codec.encode(manifest);
    await plain.putImmutable(manifestRef, encoded.bytes);

    expect(
      await degraded.finalize({
        checkpoint: {
          manifest_ref: manifestRef,
          manifest_sha256: encoded.sha256,
          manifest_version: "from-another-bucket",
          revision: 0,
        },
        fence,
        now: new Date(),
        sessionId,
        turnId: null,
      }),
    ).toEqual({ outcome: "committed", revision: 0 });
    const result = await degraded.getRestorePlan({ runtime, sessionId });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.plan).not.toHaveProperty("manifestVersion");
    for (const artifact of result.plan.artifacts) {
      for (const object of artifact.objects) {
        expect(object).not.toHaveProperty("version");
      }
    }
  });
});

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
