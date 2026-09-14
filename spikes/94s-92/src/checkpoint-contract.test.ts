import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assertSafeBoundary,
  fingerprintConfig,
  importLegacyCheckpoint,
  type PublishCheckpointDependencies,
  publishCheckpoint,
  QuiescenceTracker,
  readLegacyCheckpoint,
} from "./checkpoint-contract.ts";
import type { SessionRevision } from "./s3-session-store.ts";

const revision: SessionRevision = {
  entryCount: 3,
  parts: [{ key: "part-1", sha256: "a".repeat(64) }],
  sha256: "b".repeat(64),
};

test("requires tool and background-writer quiescence", () => {
  expect(() =>
    assertSafeBoundary({
      activeToolWrites: 1,
      backgroundWriters: 0,
      mirrorErrors: 0,
    }),
  ).toThrow("Workspace is not quiescent");
  expect(() =>
    assertSafeBoundary({
      activeToolWrites: 0,
      backgroundWriters: 1,
      mirrorErrors: 0,
    }),
  ).toThrow("Workspace is not quiescent");
  expect(() =>
    assertSafeBoundary({
      activeToolWrites: 0,
      backgroundWriters: 0,
      mirrorErrors: 1,
    }),
  ).toThrow("Transcript mirror is unhealthy");
});

test("publishes immutable manifest before advancing the pointer", async () => {
  const calls: string[] = [];
  const dependencies = dependenciesFor(calls);
  const { manifest, manifestKey } = await publishCheckpoint(dependencies, {
    cwd: "/workspace",
    generation: "generation-2",
    now: new Date("2026-09-15T00:00:00.000Z"),
    previousGeneration: "generation-1",
    runtime: {
      claudeCodeVersion: "2.1.270",
      configProfileSha256: fingerprintConfig({ settingSources: ["project"] }),
      sdkVersion: "0.3.270",
    },
    sessionId: "session-a",
  });

  expect(calls).toEqual([
    "quiesce",
    "acquire",
    "inspect",
    "git",
    "root",
    "subagents",
    `manifest:${manifestKey}`,
    `cas:generation-1:${manifestKey}`,
    "release",
  ]);
  expect(manifest.workspaceGitSha).toBe("c".repeat(40));
  expect(manifest.transcripts.root).toEqual(revision);
});

test("a manifest write failure leaves the prior pointer untouched", async () => {
  const calls: string[] = [];
  const dependencies: PublishCheckpointDependencies = {
    ...dependenciesFor(calls),
    putImmutableManifest: async () => {
      calls.push("manifest:failed");
      throw new Error("injected manifest failure");
    },
  };

  await expect(
    publishCheckpoint(dependencies, {
      cwd: "/workspace",
      generation: "generation-2",
      now: new Date("2026-09-15T00:00:00.000Z"),
      previousGeneration: "generation-1",
      runtime: {
        claudeCodeVersion: "2.1.270",
        configProfileSha256: "d".repeat(64),
        sdkVersion: "0.3.270",
      },
      sessionId: "session-a",
    }),
  ).rejects.toThrow("injected manifest failure");
  expect(calls.some((call) => call.startsWith("cas:"))).toBe(false);
  expect(calls.at(-1)).toBe("release");
});

test("holds an exclusive checkpoint lease across git, revision, manifest, and CAS", async () => {
  const tracker = new QuiescenceTracker();
  const gitStarted = Promise.withResolvers<void>();
  const finishGit = Promise.withResolvers<void>();
  const dependencies: PublishCheckpointDependencies = {
    ...dependenciesFor([]),
    acquireExclusiveCheckpoint: async () =>
      tracker.acquireCheckpointExclusive(),
    commitAndPushWorkspace: async () => {
      gitStarted.resolve();
      await finishGit.promise;
      return "c".repeat(40);
    },
    inspectQuiescence: async () => tracker.inspect(),
  };
  const publication = publishCheckpoint(dependencies, {
    cwd: "/workspace",
    generation: "generation-2",
    now: new Date("2026-09-15T00:00:00.000Z"),
    previousGeneration: null,
    runtime: {
      claudeCodeVersion: "2.1.270",
      configProfileSha256: "d".repeat(64),
      sdkVersion: "0.3.270",
    },
    sessionId: "session-a",
  });
  await gitStarted.promise;
  expect(() => tracker.beginToolWrite()).toThrow(
    "Checkpoint publication is exclusive",
  );
  expect(() => tracker.beginBackgroundWriter()).toThrow(
    "Checkpoint publication is exclusive",
  );
  finishGit.resolve();
  await publication;

  const releaseWriter = tracker.beginToolWrite();
  releaseWriter();
});

test("reads M0 metadata losslessly but never marks the pair consistent", () => {
  const source = new TextEncoder().encode(
    '{"version":1,"claude_session_id":"legacy","cwd":"/workspace","uploaded_at":"2026-09-14T00:00:00.000Z","transcript":{"bytes":3,"mode":"single","objects":[{"bytes":3,"key":"sessions/a/transcript.jsonl","sha256":"abc"}],"sha256":"abc"},"unknown":{"keep":true}}\n',
  );
  const legacy = readLegacyCheckpoint(source);

  expect(legacy.consistency).toBe("unverified");
  expect(legacy.reason).toBe("missing_workspace_git_sha");
  expect(legacy.originalBytes).toEqual(source);
  expect(legacy.metadata.unknown).toEqual({ keep: true });
});

test("imports legacy transcript bytes into a new generation and preserves rollback inputs", async () => {
  const first = new TextEncoder().encode('{"type":"user","uuid":"one"}\n');
  const second = new TextEncoder().encode(
    '{"type":"assistant","uuid":"two"}\n',
  );
  const combined = new Uint8Array(first.byteLength + second.byteLength);
  combined.set(first, 0);
  combined.set(second, first.byteLength);
  const metadataBytes = new TextEncoder().encode(
    `${JSON.stringify({
      version: 1,
      claude_session_id: "legacy",
      cwd: "/workspace",
      uploaded_at: "2026-09-14T00:00:00.000Z",
      transcript: {
        bytes: combined.byteLength,
        mode: "chunked",
        objects: [
          { bytes: first.byteLength, key: "legacy/first", sha256: hash(first) },
          {
            bytes: second.byteLength,
            key: "legacy/second",
            sha256: hash(second),
          },
        ],
        sha256: hash(combined),
      },
    })}\n`,
  );
  const objects = new Map<string, Uint8Array>([
    ["legacy/first", first],
    ["legacy/second", second],
  ]);
  const before = new Map(objects);
  const imported = await importLegacyCheckpoint(
    readLegacyCheckpoint(metadataBytes),
    {
      getObject: async (key) => objects.get(key)?.slice() ?? null,
      putImmutableObject: async (key, bytes) => {
        if (objects.has(key)) throw new Error(`Object already exists: ${key}`);
        objects.set(key, bytes.slice());
      },
    },
    { generation: "generation-2", sessionId: "session-a" },
  );

  expect(imported.revision.entryCount).toBe(2);
  expect(imported.rollback.metadataBytes).toEqual(metadataBytes);
  expect(imported.rollback.objectKeys).toEqual([
    "legacy/first",
    "legacy/second",
  ]);
  expect(objects.get("legacy/first")).toEqual(before.get("legacy/first"));
  expect(objects.get("legacy/second")).toEqual(before.get("legacy/second"));
  expect(imported.revision.parts.map(({ key }) => key)).toEqual([
    "sessions/session-a/checkpoints/generation-2/legacy/000000.jsonl",
    "sessions/session-a/checkpoints/generation-2/legacy/000001.jsonl",
  ]);

  const calls: string[] = [];
  await publishCheckpoint(
    {
      ...dependenciesFor(calls),
      captureRootRevision: async () => imported.revision,
    },
    {
      cwd: "/workspace",
      generation: "generation-2",
      now: new Date("2026-09-15T00:00:00.000Z"),
      previousGeneration: null,
      runtime: {
        claudeCodeVersion: "2.1.270",
        configProfileSha256: "d".repeat(64),
        sdkVersion: "0.3.270",
      },
      sessionId: "session-a",
    },
  );
  expect(calls.some((call) => call.startsWith("cas:null:"))).toBe(true);
  expect(calls.at(-1)).toBe("release");
});

test("refuses a legacy transcript object whose hash does not match metadata", async () => {
  const bytes = new TextEncoder().encode('{"type":"user"}\n');
  const metadataBytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      cwd: "/workspace",
      transcript: {
        bytes: bytes.byteLength,
        objects: [{ bytes: bytes.byteLength, key: "legacy/one", sha256: "0" }],
        sha256: hash(bytes),
      },
    }),
  );

  await expect(
    importLegacyCheckpoint(
      readLegacyCheckpoint(metadataBytes),
      {
        getObject: async () => bytes,
        putImmutableObject: async () => {},
      },
      { generation: "generation-2", sessionId: "session-a" },
    ),
  ).rejects.toThrow("Legacy transcript object integrity failure");
});

function dependenciesFor(calls: string[]): PublishCheckpointDependencies {
  return {
    acquireExclusiveCheckpoint: async () => {
      calls.push("acquire");
      return () => calls.push("release");
    },
    captureRootRevision: async () => {
      calls.push("root");
      return revision;
    },
    captureSubagentRevisions: async () => {
      calls.push("subagents");
      return { "subagents/agent-a": revision };
    },
    commitAndPushWorkspace: async () => {
      calls.push("git");
      return "c".repeat(40);
    },
    compareAndSwapPointer: async (previous, next) => {
      calls.push(`cas:${previous}:${next}`);
    },
    inspectQuiescence: async () => {
      calls.push("inspect");
      return { activeToolWrites: 0, backgroundWriters: 0, mirrorErrors: 0 };
    },
    putImmutableManifest: async (key) => {
      calls.push(`manifest:${key}`);
    },
    quiesce: async () => {
      calls.push("quiesce");
    },
  };
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
