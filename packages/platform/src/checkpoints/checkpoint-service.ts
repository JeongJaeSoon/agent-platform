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
  CheckpointFence,
  CheckpointPointer,
  CheckpointStore,
} from "../ports/checkpoint-store.ts";

export type CheckpointRequest = {
  /** Where this attempt must upload its manifest. */
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
  fence: CheckpointFence;
  now: Date;
  sessionId: string;
  turnId: string | null;
};

export type FinalizeCheckpointResult =
  | { outcome: "committed" | "replayed"; revision: number }
  | { currentRevision: number | null; outcome: "conflict" }
  | { outcome: "rejected"; reason: string }
  | { outcome: "stale_epoch" | "lease_expired" };

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

/**
 * Every publish attempt gets its own key.
 *
 * Keying by revision alone deadlocks the session: a worker that uploads and
 * then dies before finalizing leaves an orphan object at the key the next
 * attempt is handed, and create-only then refuses every later manifest for that
 * revision forever. Two attempts may therefore both upload; which one becomes
 * the session's truth is decided by the fenced pointer CAS, not by who wrote
 * the object first.
 */
export function manifestRefFor(
  sessionId: string,
  revision: number,
  attemptId: string,
): string {
  // Zero-padded so a prefix listing of a session's checkpoints is ordered.
  const padded = String(revision).padStart(10, "0");
  return `sessions/${sessionId}/checkpoints/${padded}/${attemptId}/manifest.json`;
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
    const missing = await missingArtifact(manifest);
    if (missing !== undefined) return { status: "rejected", reason: missing };
    return { status: "verified", manifest };
  }

  /**
   * A manifest that parses is not yet a restorable checkpoint: a partial
   * upload, a lifecycle deletion or a truncated part leaves it naming objects
   * that are not there. The pointer must never advance to one of those, so
   * every referenced object is checked for presence and declared size before
   * the checkpoint counts as verified.
   *
   * Sizes, not digests: the bytes are hashed on the way back in
   * `loadRevision`, where they have to be read anyway. Re-downloading every
   * transcript part on each checkpoint would double the transfer to catch a
   * corruption that restore catches regardless.
   */
  async function missingArtifact(
    manifest: CheckpointManifest,
  ): Promise<string | undefined> {
    const refs = [
      ...manifest.transcripts.root.parts,
      ...Object.values(manifest.transcripts.subagents).flatMap(
        (revision) => revision.parts,
      ),
      ...manifest.workspace.untracked,
    ];
    const heads = await Promise.all(
      refs.map(async (ref) => [ref, await objects.head(ref.key)] as const),
    );
    for (const [ref, head] of heads) {
      if (head === undefined) {
        return `manifest references a missing object: ${ref.key}`;
      }
      if (head.bytes !== ref.bytes) {
        return `manifest object ${ref.key} is ${head.bytes} bytes, not ${ref.bytes}`;
      }
    }
    return undefined;
  }

  return {
    /**
     * Answers a checkpoint trigger: the runtime's own verdict decides whether
     * the session is at a safe boundary, and the current pointer decides which
     * revision the worker may claim next.
     */
    async requestCheckpoint(input: {
      attemptId: string;
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
          manifestRef: manifestRefFor(
            input.sessionId,
            revision,
            input.attemptId,
          ),
          revision,
          sessionId: input.sessionId,
        },
      };
    },

    validateManifest,

    /**
     * Promotes a validated manifest to the session pointer. A checkpoint that
     * does not validate is never committed, and a pointer that has already
     * moved past this revision is a conflict the caller answers with 409.
     *
     * The fence travels into the same transaction as the pointer update, so a
     * worker whose lease was taken over cannot win the next revision merely by
     * uploading first — object-store ordering decides nothing here.
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
        fence: input.fence,
        now: input.now,
        sessionId: input.sessionId,
        turnId: input.turnId,
      });
      switch (result.outcome) {
        case "conflict":
          return {
            outcome: "conflict",
            currentRevision: result.currentRevision,
          };
        case "stale_epoch":
        case "lease_expired":
          return { outcome: result.outcome };
        default:
          return { outcome: result.outcome, revision: result.revision };
      }
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
