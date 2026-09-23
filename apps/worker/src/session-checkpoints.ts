import { createHash } from "node:crypto";
import type {
  BootstrapClaimResponse,
  CheckpointRef,
  WorkerScope,
} from "@agent-platform/contracts";
import {
  ClaudeSessionStore,
  claudeCheckpointCodec,
} from "@agent-platform/runtime-claude";
import type {
  CheckpointCodec,
  CheckpointManifest,
  CheckpointObjectStore,
  CheckpointPreparation,
  ObjectRef,
  ReadyCheckpoint,
  RejectedCheckpoint,
  RuntimeFingerprint,
  WorkerGatewayClient,
  WorkspaceArtifact,
} from "@agent-platform/runtime-core";

import type {
  CheckpointCaptureContext,
  RuntimeResumePlan,
  WorkerCheckpointPort,
} from "./checkpoint.ts";
import { isOwnershipLost } from "./gateway-client.ts";
import type { WorkerLogger } from "./worker-host.ts";
import {
  captureWorkspace,
  type WorkspaceCaptureLimits,
  type WorkspaceCaptureResult,
} from "./workspace-capture.ts";

/**
 * The control plane's own manifest limits (`DEFAULT_MAX_MANIFEST_BYTES`,
 * `DEFAULT_MAX_MANIFEST_OBJECTS`). A manifest over either is refused at
 * finalize after everything it names was uploaded, so it is refused here
 * before the manifest itself goes up.
 */
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_OBJECTS = 20_000;
const UPLOAD_CONCURRENCY = 8;

export type SessionCheckpointsOptions = {
  gateway: Pick<WorkerGatewayClient, "requestCheckpoint" | "restorePlan">;
  logger: WorkerLogger;
  /** Scoped to the session: every key it takes starts with `objectPrefix`. */
  objects: CheckpointObjectStore;
  /** `sessions/<id>/`, as the launcher configured the store. */
  objectPrefix: string;
  /** What this worker runs, recomputed from the claim (94S-261). */
  fingerprint: (claim: BootstrapClaimResponse) => RuntimeFingerprint;
  /** The provisioned root the engine runs in, and the manifest's `cwd`. */
  workspaceRoot: string;
  codec?: CheckpointCodec;
  /** Swapped in by tests that need a workspace refused or captured slowly. */
  captureWorkspace?: (input: {
    root: string;
    signal: AbortSignal;
    limits?: WorkspaceCaptureLimits;
  }) => Promise<WorkspaceCaptureResult>;
  limits?: WorkspaceCaptureLimits;
  now?: () => Date;
};

type Bound = {
  claim: BootstrapClaimResponse;
  runtime: RuntimeFingerprint;
  store: ClaudeSessionStore;
};

/** A publish that stopped short; logged, never thrown past the port. */
class PublishFailure extends Error {
  constructor(
    readonly stage: string,
    reason: string,
  ) {
    super(reason);
  }
}

/**
 * Checkpoints one claimed session: the transcript mirror the engine writes
 * to, and the publisher that turns a quiescent turn boundary into a manifest
 * finalize can commit.
 *
 * A publish follows the server's answer, never this worker's memory: the
 * revision and the manifest key are what `requestCheckpoint` answered, the
 * workspace is committed and bundled, the untracked files and the pinned
 * transcripts go up beside it, and only then the manifest, create-only,
 * under the key it was handed. Every object is written into that publish's
 * own directory, so nothing another publish or attempt wrote is ever
 * overwritten, and a publish that stops half way leaves orphans rather than
 * a manifest that names something missing.
 *
 * The caller holds the run's checkpoint lease for the whole of it, so no
 * tool the engine runs writes between the verdict and the commit. What the
 * engine does not run — a process a command detached from it — is not held
 * back (DESIGN §6.3.1).
 *
 * Restoring from a checkpoint is the second half of 94S-246; until it lands a
 * claim that names one is refused here too.
 */
export class SessionCheckpoints implements WorkerCheckpointPort {
  readonly #options: SessionCheckpointsOptions;
  readonly #codec: CheckpointCodec;
  #bound: Bound | undefined;

  constructor(options: SessionCheckpointsOptions) {
    if (!options.objectPrefix.endsWith("/")) {
      throw new Error(
        `Object prefix ${options.objectPrefix} must end in "/"; it is a key prefix`,
      );
    }
    this.#options = options;
    this.#codec = options.codec ?? claudeCheckpointCodec;
  }

  async restorePlan(claim: BootstrapClaimResponse): Promise<RuntimeResumePlan> {
    if (claim.restore !== null) {
      throw new Error(
        `Session needs checkpoint revision ${claim.restore.revision} restored, and this worker cannot restore yet (94S-246)`,
      );
    }
    const store = new ClaudeSessionStore({
      generation: claim.execution_generation,
      objects: this.#options.objects,
      prefix: `${this.#options.objectPrefix}transcripts`,
    });
    // Before the engine starts: a generation another launch already wrote
    // to would otherwise surface as the first append failing mid-turn.
    await store.ready();
    this.#bound = {
      claim,
      runtime: this.#options.fingerprint(claim),
      store,
    };
    return { mode: "new", sessionStore: store };
  }

  mirror(): { persistedAt: Date | null } | undefined {
    const store = this.#bound?.store;
    return store === undefined ? undefined : { persistedAt: store.persistedAt };
  }

  async capture(
    preparation: CheckpointPreparation,
    context: CheckpointCaptureContext,
  ): Promise<CheckpointRef | null> {
    const bound = this.#bound;
    if (bound === undefined) return null;
    if (preparation.status === "rejected") {
      await this.#report(preparation, context.scope);
      return null;
    }
    let stage = "request";
    let revision: number | null = null;
    let manifestRef: string | null = null;
    try {
      const answer = await this.#options.gateway.requestCheckpoint({
        ...context.scope,
        preparation: { status: "ready" },
      });
      if (answer.status === "blocked") {
        this.#options.logger.warn("worker.checkpoint.blocked", {
          reason: answer.reason,
          detail: answer.detail,
        });
        return null;
      }
      revision = answer.revision;
      manifestRef = answer.manifest_ref;
      stage = "publish";
      return await this.#publish(bound, preparation, context, {
        manifestRef: answer.manifest_ref,
        revision: answer.revision,
      });
    } catch (error) {
      if (isOwnershipLost(error)) throw error;
      this.#options.logger.warn("worker.checkpoint.failed", {
        stage: error instanceof PublishFailure ? error.stage : stage,
        category: error instanceof PublishFailure ? "refused" : "error",
        reason: describe(error),
        revision,
        manifest_ref: manifestRef,
      });
      return null;
    }
  }

  /**
   * Sends a refusal to the gateway, which records the ones that outlive the
   * turn — a dropped mirror batch above all — as the session's pending
   * reason. A report that does not land is logged: the heartbeat carries a
   * mirror error on its own, and the other reasons are advisory.
   */
  async #report(
    preparation: RejectedCheckpoint,
    scope: WorkerScope,
  ): Promise<void> {
    try {
      await this.#options.gateway.requestCheckpoint({
        ...scope,
        preparation: {
          status: "rejected",
          reason: preparation.reason,
          detail: preparation.detail,
        },
      });
    } catch (error) {
      if (isOwnershipLost(error)) throw error;
      this.#options.logger.warn("worker.checkpoint.report_failed", {
        reason: describe(error),
      });
    }
  }

  async #publish(
    bound: Bound,
    preparation: ReadyCheckpoint,
    context: CheckpointCaptureContext,
    request: { manifestRef: string; revision: number },
  ): Promise<CheckpointRef> {
    const { objects } = this.#options;
    const { manifestRef } = request;
    if (
      !manifestRef.startsWith(this.#options.objectPrefix) ||
      !manifestRef.endsWith("/manifest.json")
    ) {
      throw new PublishFailure(
        "request",
        `the gateway handed a manifest key outside this session: ${manifestRef}`,
      );
    }
    const directory = manifestRef.slice(0, manifestRef.lastIndexOf("/") + 1);
    const upload = async (key: string, bytes: Uint8Array) => {
      const result = await objects.putImmutable(key, bytes);
      // Content-addressed keys under this publish's own directory: another
      // body there is corruption, not a race anyone could have won.
      if (result.outcome === "conflict") {
        throw new PublishFailure("upload", `${key} already holds other bytes`);
      }
    };

    const workspace = await (
      this.#options.captureWorkspace ?? captureWorkspace
    )({
      root: this.#options.workspaceRoot,
      signal: new AbortController().signal,
      ...(this.#options.limits === undefined
        ? {}
        : { limits: this.#options.limits }),
    });
    if (workspace.status === "refused") {
      throw new PublishFailure("workspace", workspace.reason);
    }
    const { capture } = workspace;
    const bundle = refOf(
      `${directory}workspace-${sha256(capture.bundle)}.bundle`,
      capture.bundle,
    );
    await upload(bundle.key, capture.bundle);

    const untracked: WorkspaceArtifact[] = capture.untracked.map((file) => ({
      ...refOf(`${directory}untracked/${sha256(file.bytes)}`, file.bytes),
      path: file.path,
    }));
    const distinct = new Map<string, Uint8Array>();
    capture.untracked.forEach((file, index) => {
      distinct.set((untracked[index] as WorkspaceArtifact).key, file.bytes);
    });
    await inBatches([...distinct], UPLOAD_CONCURRENCY, ([key, bytes]) =>
      upload(key, bytes),
    );

    const transcripts = await bound.store.captureTranscripts(
      preparation.checkpoint.resume,
    );
    if (transcripts === null) {
      throw new PublishFailure(
        "transcript",
        `engine session ${preparation.checkpoint.resume} has no mirrored root transcript`,
      );
    }
    // Pinned, but only worth committing if nothing was lost on the way: a
    // batch whose append failed is one the SDK may still retry or give up
    // on, and a mirror error the engine raised since the verdict means the
    // pinned parts are missing entries nobody can name.
    if (bound.store.unsettled) {
      throw new PublishFailure(
        "transcript",
        "a transcript batch failed to mirror and has not been written since",
      );
    }
    const now = await context.recheck();
    if (now.status === "rejected" && now.reason === "mirror_error") {
      throw new PublishFailure("transcript", now.detail);
    }

    const referenced =
      1 +
      untracked.length +
      transcripts.root.parts.length +
      Object.values(transcripts.subagents).reduce(
        (total, revision) => total + revision.parts.length,
        0,
      );
    if (referenced > MAX_MANIFEST_OBJECTS) {
      throw new PublishFailure(
        "manifest",
        `the manifest would name ${referenced} objects, over the ${MAX_MANIFEST_OBJECTS} the control plane reads`,
      );
    }
    const manifest: CheckpointManifest = {
      createdAt: (this.#options.now?.() ?? new Date()).toISOString(),
      cwd: this.#options.workspaceRoot,
      engine: preparation.checkpoint.engine,
      resume: preparation.checkpoint.resume,
      revision: request.revision,
      runtime: bound.runtime,
      sessionId: bound.claim.session_id,
      transcripts,
      version: 2,
      workspace: { bundle, gitCommit: capture.gitCommit, untracked },
    };
    const encoded = this.#codec.encode(manifest);
    if (encoded.bytes.byteLength > MAX_MANIFEST_BYTES) {
      throw new PublishFailure(
        "manifest",
        `the manifest is ${encoded.bytes.byteLength} bytes, over the ${MAX_MANIFEST_BYTES} the control plane reads`,
      );
    }
    const stored = await objects.putImmutable(manifestRef, encoded.bytes);
    if (stored.outcome === "conflict") {
      throw new PublishFailure(
        "manifest",
        `${manifestRef} already holds another manifest`,
      );
    }
    this.#options.logger.info("worker.checkpoint.published", {
      revision: request.revision,
      manifest_ref: manifestRef,
      git_commit: capture.gitCommit,
      untracked: untracked.length,
    });
    return {
      revision: request.revision,
      manifest_ref: manifestRef,
      manifest_sha256: encoded.sha256,
    };
  }
}

function refOf(key: string, bytes: Uint8Array): ObjectRef {
  return { bytes: bytes.byteLength, key, sha256: sha256(bytes) };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function inBatches<T>(
  items: readonly T[],
  size: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < items.length; start += size) {
    await Promise.all(items.slice(start, start + size).map(task));
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
