import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type CheckpointStore,
  manifestRefFor,
  type WorkspaceBundleVerifier,
} from "@agent-platform/platform";
import { createMemoryCheckpointObjectStore } from "@agent-platform/testkit/checkpoint-objects";
import {
  createGitBundle,
  type GitBundleFixture,
} from "@agent-platform/testkit/git-bundle";

import {
  type ApiCheckpointServiceDependencies,
  createApiCheckpointService,
} from "./checkpoints.ts";

/**
 * The assembly, not the service: what matters here is which verifier the API
 * hands `createCheckpointService`, so the manifest is the smallest one the
 * service will read as far as the bundle.
 */

const sessionId = "44444444-4444-4444-8444-444444444444";
const attemptId = "attempt-1";
const manifestRef = manifestRefFor(sessionId, 0, attemptId);
const bundleKey = `${manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1)}workspace.bundle`;

const codecs: ApiCheckpointServiceDependencies["codecs"] = {
  fake: {
    engine: "fake",
    decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)),
    encode: (manifest) => {
      const bytes = new TextEncoder().encode(JSON.stringify(manifest));
      return { bytes, sha256: sha256(bytes) };
    },
    validateCompatibility: () => ({ status: "compatible" }),
  },
};

const store: CheckpointStore = {
  async readPointer() {
    return null;
  },
  async commitAtomic() {
    throw new Error("not exercised");
  },
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

let bundle: GitBundleFixture;

beforeAll(async () => {
  bundle = await createGitBundle();
});

async function checkpointWith(bytes: Uint8Array, commit: string) {
  const objects = createMemoryCheckpointObjectStore();
  await objects.put(bundleKey, bytes);
  const manifest = {
    createdAt: "2026-09-23T00:00:00.000Z",
    cwd: "/workspace",
    engine: "fake",
    resume: "r",
    revision: 0,
    runtime: {
      cliVersion: "0",
      engine: "fake",
      profileSha256: "p",
      sdkVersion: "0",
    },
    sessionId,
    transcripts: {
      root: { entryCount: 0, parts: [], sha256: sha256(new Uint8Array()) },
      subagents: {},
    },
    version: 2 as const,
    workspace: {
      bundle: {
        bytes: bytes.byteLength,
        key: bundleKey,
        sha256: sha256(bytes),
      },
      gitCommit: commit,
      untracked: [],
    },
  };
  const encoded = codecs.fake!.encode(manifest);
  await objects.put(manifestRef, encoded.bytes);
  return {
    objects,
    checkpoint: {
      manifest_ref: manifestRef,
      manifest_sha256: encoded.sha256,
      revision: 0,
    },
  };
}

describe("API checkpoint composition", () => {
  test("hands the injected verifier the stored bundle and the pinned commit", async () => {
    const calls: Array<{ bytes: number; commit: string; key: string }> = [];
    const spy: WorkspaceBundleVerifier = {
      async verify({ bytes, commit, key }) {
        calls.push({ bytes: bytes.byteLength, commit, key });
        return { status: "restorable" };
      },
    };
    const { objects, checkpoint } = await checkpointWith(
      bundle.bytes,
      bundle.commit,
    );
    const service = createApiCheckpointService({
      codecs,
      objects,
      store,
      workspaceBundles: spy,
    });
    const verdict = await service.validateManifest({ checkpoint, sessionId });
    expect(verdict.status).toBe("verified");
    expect(calls).toEqual([
      { bytes: bundle.bytes.byteLength, commit: bundle.commit, key: bundleKey },
    ]);
  });

  test("by default verifies bundles with git: a real bundle passes", async () => {
    const { objects, checkpoint } = await checkpointWith(
      bundle.bytes,
      bundle.commit,
    );
    const service = createApiCheckpointService({ codecs, objects, store });
    const verdict = await service.validateManifest({ checkpoint, sessionId });
    expect(verdict.status).toBe("verified");
  });

  test("by default verifies bundles with git: a header that lies about its tip is rejected", async () => {
    const text = new TextDecoder("latin1").decode(bundle.bytes);
    const header = text.slice(0, text.indexOf("\n\n"));
    const commit = "1".repeat(40);
    const bytes = new Uint8Array(bundle.bytes);
    bytes.set(
      new TextEncoder().encode(header.replace(bundle.commit, commit)),
      0,
    );
    const { objects, checkpoint } = await checkpointWith(bytes, commit);
    const service = createApiCheckpointService({ codecs, objects, store });
    const verdict = await service.validateManifest({ checkpoint, sessionId });
    expect(verdict.status).toBe("rejected");
    if (verdict.status === "rejected") {
      expect(verdict.reason).toContain("git fetch failed");
    }
  });
});
