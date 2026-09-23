import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type CheckpointStore,
  manifestRefFor,
  type WorkspaceBundleVerifier,
} from "@agent-platform/platform";
import {
  DEFAULT_MAX_GIT_MEMORY_BYTES,
  defaultGitRunner,
  type GitCommandRunner,
} from "@agent-platform/storage";
import { createMemoryCheckpointObjectStore } from "@agent-platform/testkit/checkpoint-objects";
import {
  createGitBundle,
  type GitBundleFixture,
} from "@agent-platform/testkit/git-bundle";
import {
  type ApiCheckpointServiceDependencies,
  checkpointGitMemoryBytesFromEnv,
  checkpointStorageConfigFromEnv,
  createApiCheckpointService,
  createApiCheckpoints,
  MIN_CHECKPOINT_GIT_MEMORY_MB,
} from "./checkpoints.ts";

/**
 * The assembly, not the service: what matters here is which verifier the API
 * hands `createCheckpointService`, so the manifest is the smallest one the
 * service will read as far as the bundle.
 */

const sessionId = "44444444-4444-4444-8444-444444444444";
const attemptId = "attempt-1";
// What `requestCheckpoint` would have minted for the publish these tests upload.
const PUBLISH_ID = "0123456789abcdef0123456789abcdef";
const manifestRef = manifestRefFor(sessionId, 0, attemptId, PUBLISH_ID);
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
  async listCheckpoints() {
    return [];
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
  const codec = codecs.fake;
  if (!codec) throw new Error("fake codec missing");
  const encoded = codec.encode(manifest);
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
        calls.push({ bytes, commit, key });
        return { status: "restorable" };
      },
    };
    const { objects, checkpoint } = await checkpointWith(
      bundle.bytes,
      bundle.commit,
    );
    const service = createApiCheckpointService({
      codecs,
      objectProtection: "unversioned",
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
    const service = createApiCheckpointService({
      codecs,
      objectProtection: "unversioned",
      objects,
      store,
    });
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
    const service = createApiCheckpointService({
      codecs,
      objectProtection: "unversioned",
      objects,
      store,
    });
    const verdict = await service.validateManifest({ checkpoint, sessionId });
    expect(verdict.status).toBe("rejected");
    if (verdict.status === "rejected") {
      expect(verdict.reason).toContain("git fetch failed");
    }
  });

  test("starts every verifying git under the configured memory cap", async () => {
    const memory: Array<number | undefined> = [];
    const gitRunner: GitCommandRunner = (args, options) => {
      memory.push(options.limits?.memoryBytes);
      return defaultGitRunner(args, options);
    };
    const { objects, checkpoint } = await checkpointWith(
      bundle.bytes,
      bundle.commit,
    );
    const maxGitMemoryBytes = checkpointGitMemoryBytesFromEnv({
      CHECKPOINT_GIT_MEMORY_MB: "384",
    });
    const service = createApiCheckpointService({
      codecs,
      objectProtection: "unversioned",
      gitRunner,
      maxGitMemoryBytes,
      objects,
      store,
    });
    const verdict = await service.validateManifest({ checkpoint, sessionId });
    expect(verdict.status).toBe("verified");
    expect(memory.length).toBeGreaterThan(0);
    expect(new Set(memory)).toEqual(new Set([384 * 1024 * 1024]));
  });

  test("keeps the verifier's default cap when the environment names none", () => {
    expect(checkpointGitMemoryBytesFromEnv({})).toBe(
      DEFAULT_MAX_GIT_MEMORY_BYTES,
    );
    expect(
      checkpointGitMemoryBytesFromEnv({ CHECKPOINT_GIT_MEMORY_MB: " " }),
    ).toBe(DEFAULT_MAX_GIT_MEMORY_BYTES);
    expect(
      checkpointGitMemoryBytesFromEnv({ CHECKPOINT_GIT_MEMORY_MB: " 2048 " }),
    ).toBe(2048 * 1024 * 1024);
  });

  test.each([
    "0",
    "-1536",
    "1536.5",
    "1e3",
    "0x600",
    "1.5g",
    "abc",
    String(MIN_CHECKPOINT_GIT_MEMORY_MB - 1),
    "99999999999999",
  ])("refuses CHECKPOINT_GIT_MEMORY_MB=%s at startup", (value) => {
    expect(() =>
      checkpointGitMemoryBytesFromEnv({ CHECKPOINT_GIT_MEMORY_MB: value }),
    ).toThrow(/^CHECKPOINT_GIT_MEMORY_MB must be a whole number of MiB/);
  });

  test("pins and holds checkpoint objects unless degrading is said out loud", () => {
    const full = {
      AWS_ACCESS_KEY_ID: "id",
      AWS_REGION: "ap-northeast-1",
      AWS_SECRET_ACCESS_KEY: "s",
      S3_BUCKET: "claude-sessions",
    };
    const protection = (value?: string) => {
      const config = checkpointStorageConfigFromEnv(
        value === undefined
          ? full
          : { ...full, CHECKPOINT_OBJECT_PROTECTION: value },
      );
      return config === "disabled" ? config : config.protection;
    };
    expect(protection()).toBe("locked");
    expect(protection(" ")).toBe("locked");
    expect(protection("locked")).toBe("locked");
    expect(protection("unversioned")).toBe("unversioned");
    expect(() => protection("off")).toThrow(
      /^CHECKPOINT_OBJECT_PROTECTION must be "locked" \(default\) or "unversioned", not off$/,
    );
  });

  test("reads the object store from the environment and refuses a silent absence", () => {
    const full = {
      AWS_ACCESS_KEY_ID: "id",
      AWS_ENDPOINT_URL: "http://127.0.0.1:4566",
      AWS_REGION: "ap-northeast-1",
      AWS_SECRET_ACCESS_KEY: "s",
      S3_BUCKET: "claude-sessions",
    };
    expect(checkpointStorageConfigFromEnv(full)).toEqual({
      accessKeyId: "id",
      bucket: "claude-sessions",
      endpoint: "http://127.0.0.1:4566",
      protection: "locked",
      region: "ap-northeast-1",
      secretAccessKey: "s",
    });
    const { AWS_ENDPOINT_URL: _endpoint, ...aws } = full;
    expect(
      checkpointStorageConfigFromEnv({ ...aws, CHECKPOINT_OBJECT_STORE: "s3" }),
    ).not.toHaveProperty("endpoint");
    expect(
      checkpointStorageConfigFromEnv({ CHECKPOINT_OBJECT_STORE: "disabled" }),
    ).toBe("disabled");
    // Disabled has to be said: the missing bucket is a misconfiguration.
    expect(() => checkpointStorageConfigFromEnv({})).toThrow(
      /S3_BUCKET is required/,
    );
    expect(() =>
      checkpointStorageConfigFromEnv({ ...full, S3_BUCKET: " " }),
    ).toThrow(/S3_BUCKET/);
    expect(() =>
      checkpointStorageConfigFromEnv({
        ...full,
        AWS_ENDPOINT_URL: "localstack:4566",
      }),
    ).toThrow(/not an http\(s\) URL/);
    // Neither refusal repeats the value: it may carry a credential.
    expect(() =>
      checkpointStorageConfigFromEnv({
        ...full,
        AWS_ENDPOINT_URL: "ftp://user:hunter2@host",
      }),
    ).toThrow(/^AWS_ENDPOINT_URL is not an http\(s\) URL$/);
    expect(() =>
      checkpointStorageConfigFromEnv({
        ...full,
        AWS_ENDPOINT_URL: "http://user:hunter2@host:4566",
      }),
    ).toThrow(/^AWS_ENDPOINT_URL must not carry userinfo$/);
    expect(() =>
      checkpointStorageConfigFromEnv({
        ...full,
        CHECKPOINT_OBJECT_STORE: "memory",
      }),
    ).toThrow(/CHECKPOINT_OBJECT_STORE/);
  });

  test("without an object store the gateway gets the fail-closed verifier and no protocol", async () => {
    const wired = createApiCheckpoints({} as never, "disabled");
    expect(wired.protocol).toBeUndefined();
    expect(
      await wired.verifier.verify({
        fence: {
          sessionId,
          attemptId,
          leaseEpoch: 0,
          executionGeneration: 0,
          authRevision: 0,
        },
        turnId: "1",
        checkpoint: {
          manifest_ref: manifestRef,
          manifest_sha256: "0".repeat(64),
          revision: 0,
        },
        at: new Date(),
      }),
    ).toMatchObject({ status: "rejected" });
  });
});
