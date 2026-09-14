import { createHash } from "node:crypto";
import type { SessionRevision } from "./s3-session-store.ts";

export type QuiescenceState = {
  readonly activeToolWrites: number;
  readonly backgroundWriters: number;
  readonly mirrorErrors: number;
};

export class QuiescenceTracker {
  #activeToolWrites = 0;
  #backgroundWriters = 0;
  #checkpointExclusive = false;
  #mirrorErrors = 0;

  beginToolWrite(): () => void {
    this.#assertWriterMayStart();
    this.#activeToolWrites += 1;
    return once(() => {
      this.#activeToolWrites -= 1;
    });
  }

  beginBackgroundWriter(): () => void {
    this.#assertWriterMayStart();
    this.#backgroundWriters += 1;
    return once(() => {
      this.#backgroundWriters -= 1;
    });
  }

  recordMirrorError(): void {
    this.#mirrorErrors += 1;
  }

  inspect(): QuiescenceState {
    return {
      activeToolWrites: this.#activeToolWrites,
      backgroundWriters: this.#backgroundWriters,
      mirrorErrors: this.#mirrorErrors,
    };
  }

  acquireCheckpointExclusive(): () => void {
    if (this.#checkpointExclusive) {
      throw new Error("Checkpoint publication is already exclusive");
    }
    assertSafeBoundary(this.inspect());
    this.#checkpointExclusive = true;
    return once(() => {
      this.#checkpointExclusive = false;
    });
  }

  #assertWriterMayStart(): void {
    if (this.#checkpointExclusive) {
      throw new Error("Checkpoint publication is exclusive");
    }
  }
}

export type RuntimeFingerprint = {
  readonly claudeCodeVersion: string;
  readonly configProfileSha256: string;
  readonly sdkVersion: string;
};

export type CheckpointManifest = {
  readonly createdAt: string;
  readonly cwd: string;
  readonly generation: string;
  readonly runtime: RuntimeFingerprint;
  readonly sessionId: string;
  readonly transcripts: {
    readonly root: SessionRevision;
    readonly subagents: Readonly<Record<string, SessionRevision>>;
  };
  readonly version: 2;
  readonly workspaceGitSha: string;
};

export type PublishCheckpointDependencies = {
  readonly acquireExclusiveCheckpoint: () => Promise<() => void>;
  readonly captureRootRevision: () => Promise<SessionRevision | null>;
  readonly captureSubagentRevisions: () => Promise<
    Readonly<Record<string, SessionRevision>>
  >;
  readonly commitAndPushWorkspace: () => Promise<string>;
  readonly compareAndSwapPointer: (
    previousGeneration: string | null,
    manifestKey: string,
  ) => Promise<void>;
  readonly inspectQuiescence: () => Promise<QuiescenceState>;
  readonly putImmutableManifest: (
    key: string,
    bytes: Uint8Array,
  ) => Promise<void>;
  readonly quiesce: () => Promise<void>;
};

export type PublishCheckpointInput = {
  readonly cwd: string;
  readonly generation: string;
  readonly now: Date;
  readonly previousGeneration: string | null;
  readonly runtime: RuntimeFingerprint;
  readonly sessionId: string;
};

export async function publishCheckpoint(
  dependencies: PublishCheckpointDependencies,
  input: PublishCheckpointInput,
): Promise<{ manifest: CheckpointManifest; manifestKey: string }> {
  await dependencies.quiesce();
  const releaseExclusive = await dependencies.acquireExclusiveCheckpoint();
  try {
    assertSafeBoundary(await dependencies.inspectQuiescence());
    const workspaceGitSha = await dependencies.commitAndPushWorkspace();
    const root = await dependencies.captureRootRevision();
    if (!root) throw new Error("Root transcript has no durable revision");
    const subagents = await dependencies.captureSubagentRevisions();
    const manifest: CheckpointManifest = {
      createdAt: input.now.toISOString(),
      cwd: input.cwd,
      generation: input.generation,
      runtime: input.runtime,
      sessionId: input.sessionId,
      transcripts: { root, subagents },
      version: 2,
      workspaceGitSha,
    };
    const manifestKey = `sessions/${input.sessionId}/checkpoints/${input.generation}/manifest.json`;
    await dependencies.putImmutableManifest(
      manifestKey,
      new TextEncoder().encode(`${JSON.stringify(manifest)}\n`),
    );
    await dependencies.compareAndSwapPointer(
      input.previousGeneration,
      manifestKey,
    );
    return { manifest, manifestKey };
  } finally {
    releaseExclusive();
  }
}

export function assertSafeBoundary(state: QuiescenceState): void {
  if (state.mirrorErrors > 0) {
    throw new Error("Transcript mirror is unhealthy");
  }
  if (state.activeToolWrites > 0 || state.backgroundWriters > 0) {
    throw new Error("Workspace is not quiescent");
  }
}

export type LegacyCheckpoint = {
  readonly consistency: "unverified";
  readonly metadata: Record<string, unknown>;
  readonly originalBytes: Uint8Array;
  readonly reason: "missing_workspace_git_sha";
};

export type LegacyImportDependencies = {
  readonly getObject: (key: string) => Promise<Uint8Array | null>;
  readonly putImmutableObject: (
    key: string,
    bytes: Uint8Array,
  ) => Promise<void>;
};

export type LegacyImportResult = {
  readonly revision: SessionRevision;
  readonly rollback: {
    readonly metadataBytes: Uint8Array;
    readonly objectKeys: readonly string[];
  };
};

export function readLegacyCheckpoint(bytes: Uint8Array): LegacyCheckpoint {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid legacy checkpoint metadata");
  }
  const metadata = parsed as Record<string, unknown>;
  if (metadata.version !== 1 || typeof metadata.cwd !== "string") {
    throw new Error("Invalid legacy checkpoint metadata");
  }
  return {
    consistency: "unverified",
    metadata,
    originalBytes: bytes.slice(),
    reason: "missing_workspace_git_sha",
  };
}

export async function importLegacyCheckpoint(
  legacy: LegacyCheckpoint,
  dependencies: LegacyImportDependencies,
  target: { readonly generation: string; readonly sessionId: string },
): Promise<LegacyImportResult> {
  const transcript = parseLegacyTranscript(legacy.metadata.transcript);
  const sourceParts: Uint8Array[] = [];
  for (const object of transcript.objects) {
    const bytes = await dependencies.getObject(object.key);
    if (!bytes)
      throw new Error(`Missing legacy transcript object: ${object.key}`);
    if (bytes.byteLength !== object.bytes || sha256(bytes) !== object.sha256) {
      throw new Error(
        `Legacy transcript object integrity failure: ${object.key}`,
      );
    }
    sourceParts.push(bytes);
  }
  const combined = concatenate(sourceParts);
  if (
    combined.byteLength !== transcript.bytes ||
    sha256(combined) !== transcript.sha256
  ) {
    throw new Error("Legacy transcript integrity failure");
  }
  const parts = await Promise.all(
    sourceParts.map(async (bytes, index) => {
      const key = `sessions/${target.sessionId}/checkpoints/${target.generation}/legacy/${String(index).padStart(6, "0")}.jsonl`;
      await dependencies.putImmutableObject(key, bytes);
      return { key, sha256: sha256(bytes) };
    }),
  );
  const revision: SessionRevision = {
    entryCount: countJsonLines(combined),
    parts,
    sha256: sha256(new TextEncoder().encode(JSON.stringify(parts))),
  };
  return {
    revision,
    rollback: {
      metadataBytes: legacy.originalBytes.slice(),
      objectKeys: transcript.objects.map(({ key }) => key),
    },
  };
}

export function fingerprintConfig(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortObject(value)))
    .digest("hex");
}

type LegacyTranscript = {
  readonly bytes: number;
  readonly objects: readonly {
    readonly bytes: number;
    readonly key: string;
    readonly sha256: string;
  }[];
  readonly sha256: string;
};

function parseLegacyTranscript(value: unknown): LegacyTranscript {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid legacy transcript metadata");
  }
  const candidate = value as Partial<LegacyTranscript>;
  if (
    typeof candidate.bytes !== "number" ||
    typeof candidate.sha256 !== "string" ||
    !Array.isArray(candidate.objects)
  ) {
    throw new Error("Invalid legacy transcript metadata");
  }
  for (const object of candidate.objects) {
    if (
      typeof object !== "object" ||
      object === null ||
      typeof object.bytes !== "number" ||
      typeof object.key !== "string" ||
      typeof object.sha256 !== "string"
    ) {
      throw new Error("Invalid legacy transcript object metadata");
    }
  }
  return candidate as LegacyTranscript;
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function countJsonLines(bytes: Uint8Array): number {
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line)).length;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortObject(nested)]),
  );
}

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}
