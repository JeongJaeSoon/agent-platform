import { createHash } from "node:crypto";
import type { CheckpointRef } from "@agent-platform/contracts";
import type {
  CheckpointBlockReason,
  CheckpointCodec,
  CheckpointManifest,
  CheckpointObjectStore,
  CheckpointPreparation,
  CompatibilityMismatch,
  ObjectRef,
  RuntimeFingerprint,
} from "@agent-platform/runtime-core";

import type {
  CheckpointPointer,
  CheckpointStore,
} from "../ports/checkpoint-store.ts";

export type CheckpointRequest = {
  /** Where the worker must upload the manifest for this revision. */
  manifestRef: string;
  revision: number;
  sessionId: string;
};

export type CheckpointRequestDecision =
  | { status: "ready"; request: CheckpointRequest }
  | { detail: string; reason: CheckpointBlockReason; status: "blocked" };

export type ManifestVerdict =
  | { manifest: CheckpointManifest; status: "verified" }
  | { reason: string; status: "rejected" };

export type FinalizeCheckpointInput = {
  checkpoint: CheckpointRef;
  now: Date;
  sessionId: string;
  turnId: string | null;
};

export type FinalizeCheckpointResult =
  | { outcome: "committed" | "replayed"; revision: number }
  | { currentRevision: number | null; outcome: "conflict" }
  | { outcome: "rejected"; reason: string };

export type RestoreArtifact = {
  /** The subagent subpath, or "" for the root transcript. */
  label: string;
  objects: readonly ObjectRef[];
  kind: "transcript_root" | "transcript_subagent" | "workspace_untracked";
};

export type RestorePlan = {
  artifacts: readonly RestoreArtifact[];
  cwd: string;
  engine: string;
  gitCommit: string;
  manifestRef: string;
  /** Every object key the plan needs, deduplicated, in download order. */
  objectKeys: readonly string[];
  resume: string;
  revision: number;
};

export type RestorePlanResult =
  | { plan: RestorePlan; status: "ready" }
  | { status: "none" }
  | { code: "CHECKPOINT_UNAVAILABLE"; reason: string; status: "unavailable" }
  | {
      code: "INCOMPATIBLE_CHECKPOINT";
      mismatches: readonly CompatibilityMismatch[];
      status: "incompatible";
    };

export type CheckpointServiceDependencies = {
  /** Manifest codecs by engine name. */
  codecs: Readonly<Record<string, CheckpointCodec>>;
  objects: CheckpointObjectStore;
  store: CheckpointStore;
};

export function manifestRefFor(sessionId: string, revision: number): string {
  // Zero-padded so a prefix listing of a session's checkpoints is ordered.
  return `sessions/${sessionId}/checkpoints/${String(revision).padStart(10, "0")}/manifest.json`;
}

/**
 * Turns an uploaded manifest into the session's durable restore point, and
 * reads it back as a restore plan.
 *
 * The service never trusts the pointer or the object store on its own. A
 * pointer names a manifest, the manifest's bytes must hash to what the pointer
 * claims, and the manifest names the exact objects to restore. Anything that
 * does not line up is refused, because the alternative — resuming from the
 * latest mirror suffix or the branch head — silently produces a session that
 * never existed.
 */
export function createCheckpointService(deps: CheckpointServiceDependencies) {
  const { codecs, objects, store } = deps;

  async function validateManifest(input: {
    checkpoint: CheckpointRef;
    sessionId: string;
  }): Promise<ManifestVerdict> {
    const { checkpoint, sessionId } = input;
    const bytes = await objects.get(checkpoint.manifest_ref);
    if (bytes === undefined) {
      return {
        status: "rejected",
        reason: `manifest object is missing: ${checkpoint.manifest_ref}`,
      };
    }
    const digest = sha256(bytes);
    if (digest !== checkpoint.manifest_sha256) {
      return {
        status: "rejected",
        reason: `manifest digest mismatch: stored ${digest}`,
      };
    }
    const engine = engineOf(bytes);
    const codec = engine === undefined ? undefined : own(codecs, engine);
    if (codec === undefined) {
      return {
        status: "rejected",
        reason: `no codec for checkpoint engine: ${engine ?? "<unreadable>"}`,
      };
    }
    let manifest: CheckpointManifest;
    try {
      manifest = codec.decode(bytes);
    } catch (error) {
      return { status: "rejected", reason: (error as Error).message };
    }
    if (manifest.sessionId !== sessionId) {
      return {
        status: "rejected",
        reason: `manifest belongs to session ${manifest.sessionId}`,
      };
    }
    if (manifest.revision !== checkpoint.revision) {
      return {
        status: "rejected",
        reason: `manifest is revision ${manifest.revision}, not ${checkpoint.revision}`,
      };
    }
    return { status: "verified", manifest };
  }

  return {
    /**
     * Answers a checkpoint trigger: the runtime's own verdict decides whether
     * the session is at a safe boundary, and the current pointer decides which
     * revision the worker may claim next.
     */
    async requestCheckpoint(input: {
      preparation: CheckpointPreparation;
      sessionId: string;
    }): Promise<CheckpointRequestDecision> {
      if (input.preparation.status === "rejected") {
        return {
          status: "blocked",
          reason: input.preparation.reason,
          detail: input.preparation.detail,
        };
      }
      const pointer = await store.readPointer(input.sessionId);
      const revision = (pointer?.revision ?? -1) + 1;
      return {
        status: "ready",
        request: {
          manifestRef: manifestRefFor(input.sessionId, revision),
          revision,
          sessionId: input.sessionId,
        },
      };
    },

    validateManifest,

    /**
     * Promotes a validated manifest to the session pointer. A checkpoint that
     * does not validate is never committed, and a pointer that has already
     * moved past this revision is a conflict the caller answers with 409 —
     * a worker whose epoch ended does not get to overwrite its successor.
     */
    async finalize(
      input: FinalizeCheckpointInput,
    ): Promise<FinalizeCheckpointResult> {
      const verdict = await validateManifest({
        checkpoint: input.checkpoint,
        sessionId: input.sessionId,
      });
      if (verdict.status === "rejected") {
        return { outcome: "rejected", reason: verdict.reason };
      }
      const result = await store.commitAtomic({
        checkpoint: input.checkpoint,
        now: input.now,
        sessionId: input.sessionId,
        turnId: input.turnId,
      });
      return result.outcome === "conflict"
        ? { outcome: "conflict", currentRevision: result.currentRevision }
        : { outcome: result.outcome, revision: result.revision };
    },

    /**
     * What a new execution must download before it may start the engine. A
     * session with no pointer is a new session, not a broken one; a pointer
     * whose manifest cannot be read or replayed is reported rather than
     * approximated, so the worker fails its claim instead of quietly starting
     * a fresh conversation.
     */
    async getRestorePlan(input: {
      runtime: RuntimeFingerprint;
      sessionId: string;
    }): Promise<RestorePlanResult> {
      const pointer: CheckpointPointer | null = await store.readPointer(
        input.sessionId,
      );
      if (pointer === null) return { status: "none" };
      const verdict = await validateManifest({
        checkpoint: {
          manifest_ref: pointer.manifestRef,
          manifest_sha256: pointer.manifestSha256,
          revision: pointer.revision,
        },
        sessionId: input.sessionId,
      });
      if (verdict.status === "rejected") {
        return {
          status: "unavailable",
          code: "CHECKPOINT_UNAVAILABLE",
          reason: verdict.reason,
        };
      }
      const { manifest } = verdict;
      const codec = own(codecs, manifest.engine);
      if (codec === undefined) {
        return {
          status: "unavailable",
          code: "CHECKPOINT_UNAVAILABLE",
          reason: `no codec for checkpoint engine: ${manifest.engine}`,
        };
      }
      const compatibility = codec.validateCompatibility(
        manifest,
        input.runtime,
      );
      if (compatibility.status === "incompatible") {
        return {
          status: "incompatible",
          code: "INCOMPATIBLE_CHECKPOINT",
          mismatches: compatibility.mismatches,
        };
      }
      return { status: "ready", plan: planOf(manifest, pointer.manifestRef) };
    },
  };
}

export type CheckpointService = ReturnType<typeof createCheckpointService>;

function planOf(
  manifest: CheckpointManifest,
  manifestRef: string,
): RestorePlan {
  const artifacts: RestoreArtifact[] = [
    {
      kind: "transcript_root",
      label: "",
      objects: manifest.transcripts.root.parts,
    },
    ...Object.entries(manifest.transcripts.subagents)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([subpath, revision]): RestoreArtifact => {
        return {
          kind: "transcript_subagent",
          label: subpath,
          objects: revision.parts,
        };
      }),
  ];
  if (manifest.workspace.untracked.length > 0) {
    artifacts.push({
      kind: "workspace_untracked",
      label: "",
      objects: manifest.workspace.untracked,
    });
  }
  return {
    artifacts,
    cwd: manifest.cwd,
    engine: manifest.engine,
    gitCommit: manifest.workspace.gitCommit,
    manifestRef,
    objectKeys: [
      ...new Set(
        artifacts.flatMap((artifact) =>
          artifact.objects.map((object) => object.key),
        ),
      ),
    ],
    resume: manifest.resume,
    revision: manifest.revision,
  };
}

/**
 * Reads only the engine discriminator, to pick the codec that validates the
 * rest. The platform never interprets a manifest body itself.
 */
function engineOf(bytes: Uint8Array): string | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const engine = (parsed as { engine?: unknown }).engine;
    return typeof engine === "string" ? engine : undefined;
  } catch {
    return undefined;
  }
}

// Codec registries are plain objects; inherited keys are not codecs.
function own<T>(record: Readonly<Record<string, T>>, key: string) {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
