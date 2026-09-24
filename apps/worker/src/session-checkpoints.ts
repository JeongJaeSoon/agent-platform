import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BootstrapClaimResponse,
  CheckpointRef,
  RestorePlanWire,
  WorkerScope,
} from "@agent-platform/contracts";
import {
  ClaudeSessionStore,
  claudeCheckpointCodec,
  TranscriptTooLarge,
} from "@agent-platform/runtime-claude";
import {
  type CheckpointCodec,
  type CheckpointManifest,
  type CheckpointObjectStore,
  type CheckpointPreparation,
  type CheckpointTranscripts,
  ObjectIntegrityError,
  type ObjectRef,
  type ReadyCheckpoint,
  type RejectedCheckpoint,
  type RuntimeFingerprint,
  restoreCwdRefusal,
  TRANSCRIPT_MIRROR_DIRECTORY,
  type TranscriptRevision,
  transcriptParts,
  transcriptSizeProblem,
  type WorkerGatewayClient,
  type WorkspaceArtifact,
  workspacePathsProblem,
  writeWorkspaceFile,
} from "@agent-platform/runtime-core";

import type {
  CheckpointCaptureContext,
  RuntimeResumePlan,
  WorkerCheckpointPort,
} from "./checkpoint.ts";
import {
  restoreCheckpointTree,
  stageCheckpointBundle,
  stagedClaudeMd,
} from "./checkpoint-restore.ts";
import { isOwnershipLost } from "./gateway-client.ts";
import type { WorkerLogger } from "./worker-host.ts";
import { committedClaudeMdOf, storableRepositoryUrl } from "./workspace.ts";
import {
  captureWorkspace,
  type InstructionsPin,
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
/** Objects a restore downloads at once, each verified and spooled to disk. */
const DOWNLOAD_CONCURRENCY = 8;
const UNSETTLED =
  "a transcript batch failed to mirror and has not been written since";

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
  /**
   * The commit the workspace preparer read CLAUDE.md from, for a session
   * with nothing to restore; a restore takes the checkpoint's instead.
   */
  instructionsCommit?: () => string | null;
  /** Where a restore spools downloads and keeps the instructions commit. */
  scratchRoot?: string;
  /** Swapped in by tests that need a workspace refused or captured slowly. */
  captureWorkspace?: (input: {
    root: string;
    signal: AbortSignal;
    limits?: WorkspaceCaptureLimits;
    instructions?: InstructionsPin;
  }) => Promise<WorkspaceCaptureResult>;
  limits?: WorkspaceCaptureLimits;
  now?: () => Date;
};

type Bound = {
  claim: BootstrapClaimResponse;
  /** Carried into every bundle this run captures (`CHECKPOINT_INSTRUCTIONS_REF`). */
  instructions: InstructionsPin | undefined;
  runtime: RuntimeFingerprint;
  store: ClaudeSessionStore;
};

/**
 * A checkpoint this worker will not resume from. The claim fails on it, as on
 * any restore that cannot finish: starting a fresh engine session on top of a
 * session that has a checkpoint is what the pointer exists to stop. `code` is
 * the restore plan's, when the gateway gave one.
 */
export class RestoreRefused extends Error {
  constructor(
    readonly code: "CHECKPOINT_UNAVAILABLE" | "INCOMPATIBLE_CHECKPOINT",
    reason: string,
  ) {
    super(`Checkpoint restore refused (${code}): ${reason}`);
    this.name = "RestoreRefused";
  }
}

/**
 * A publish that stopped short. Never thrown past the port: it is logged and
 * reported as the advisory `publish_failed`, so the session shows that its
 * last turn went without a checkpoint.
 */
class PublishFailure extends Error {
  constructor(
    readonly stage: string,
    reason: string,
  ) {
    super(reason);
  }
}

/**
 * The transcript is missing entries nobody can name. Unlike the other
 * failures this outlives the publish and is blocking: the session must not
 * report a turn complete without a checkpoint, so the gateway is told before
 * the port answers.
 */
class MirrorLost extends PublishFailure {
  constructor(reason: string) {
    super("transcript", reason);
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
 * A claim that names a checkpoint is restored from it before the engine
 * starts; see `restorePlan`.
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

  async restorePlan(
    claim: BootstrapClaimResponse,
    signal: AbortSignal,
  ): Promise<RuntimeResumePlan> {
    const runtime = this.#options.fingerprint(claim);
    if (claim.restore !== null) {
      try {
        return await this.#restore(claim, claim.restore, runtime, signal);
      } catch (caught) {
        // Bytes that fail the store's checksum are as damaged as bytes that
        // fail the manifest's digest; only the layer that caught them differs.
        const error =
          caught instanceof ObjectIntegrityError
            ? new RestoreRefused("CHECKPOINT_UNAVAILABLE", caught.message)
            : caught;
        if (error instanceof RestoreRefused) {
          this.#options.logger.error("worker.checkpoint.restore_refused", {
            code: error.code,
            reason: error.message,
            revision: claim.restore.revision,
            manifest_ref: claim.restore.manifest_ref,
          });
        }
        throw error;
      }
    }
    const store = new ClaudeSessionStore({
      generation: claim.execution_generation,
      objects: this.#options.objects,
      prefix: this.#transcriptPrefix(),
    });
    // Before the engine starts: a generation another launch already wrote
    // to would otherwise surface as the first append failing mid-turn.
    await store.ready();
    signal.throwIfAborted();
    const commit = this.#options.instructionsCommit?.() ?? null;
    this.#bound = {
      claim,
      instructions: commit === null ? undefined : { commit },
      runtime,
      store,
    };
    return { mode: "new", sessionStore: store };
  }

  /**
   * Restores the checkpoint the claim names, in two halves.
   *
   * Everything that can refuse runs first, while the workspace is untouched:
   * the gateway's plan (whose fingerprint verdict is made against this
   * worker's recomputed one, 94S-261), the manifest the claim pinned by
   * digest — the authority for everything else — checked against the claim,
   * this runtime and this workspace root, and every object it names
   * downloaded and held to its digest: the bundle fetched and its refs
   * checked in a repository of the worker's own, the untracked files spooled,
   * the inherited transcript parts read and parsed.
   *
   * Only then is the workspace replaced, and the untracked files written
   * back without following a link the checkout brought. The signal is
   * checked between every step, and nothing that finishes late starts
   * touching files once it has fired; a restore stopped half way leaves a
   * workspace the next attempt restores again from the start.
   */
  async #restore(
    claim: BootstrapClaimResponse,
    pointer: CheckpointRef,
    runtime: RuntimeFingerprint,
    signal: AbortSignal,
  ): Promise<RuntimeResumePlan> {
    const { objects, workspaceRoot } = this.#options;
    const answer = await this.#options.gateway.restorePlan({
      ...claimScope(claim),
      runtime: {
        cli_version: runtime.cliVersion,
        engine: runtime.engine,
        profile_sha256: runtime.profileSha256,
        sdk_version: runtime.sdkVersion,
      },
    });
    signal.throwIfAborted();
    const { plan, restoring } = planFor(answer, pointer);
    // Which write of each object to read is the gateway's call: it knows
    // whether this deployment pins versions. What the bytes must be is the
    // manifest's, so a wrong answer here can only fail the restore.
    const versions = versionsOf(plan);
    const manifestBytes = await objects.get(
      restoring.manifest_ref,
      plan.manifest_version,
    );
    signal.throwIfAborted();
    if (
      manifestBytes === undefined ||
      sha256(manifestBytes) !== restoring.manifest_sha256
    ) {
      throw new RestoreRefused(
        "CHECKPOINT_UNAVAILABLE",
        `manifest ${restoring.manifest_ref} is not the one ${restoring === pointer ? "the claim" : "the fallback plan"} pinned`,
      );
    }
    const manifest = this.#codec.decode(manifestBytes);
    this.#checkManifest(claim, restoring, runtime, manifest);
    const pinned = (ref: ObjectRef): ObjectRef => {
      const { version: _stale, ...rest } = ref;
      const version = versions.get(ref.key);
      return version === undefined ? rest : { ...rest, version };
    };

    const store = new ClaudeSessionStore({
      generation: claim.execution_generation,
      inherit: {
        sessionId: manifest.resume,
        transcripts: transcriptsWith(manifest.transcripts, pinned),
      },
      objects,
      prefix: this.#transcriptPrefix(),
    });
    await store.ready();
    await store.verifyInherited(signal);

    const scratchRoot = this.#options.scratchRoot ?? tmpdir();
    const spool = await mkdtemp(join(scratchRoot, "worker-restore-"));
    // Outlives the restore on success: later captures take the instructions
    // commit's objects from it.
    const kept = await mkdtemp(join(scratchRoot, "worker-instructions-"));
    let restored = false;
    try {
      const bundlePath = join(spool, "workspace.bundle");
      const spooled = new Map<string, string>();
      const artifacts = [
        { path: bundlePath, ref: pinned(manifest.workspace.bundle) },
        ...distinctRefs(manifest.workspace.untracked).map((ref, index) => {
          const path = join(spool, `untracked-${index}`);
          spooled.set(ref.key, path);
          return { path, ref: pinned(ref) };
        }),
      ];
      await inBatches(
        artifacts,
        DOWNLOAD_CONCURRENCY,
        async ({ path, ref }) => {
          const bytes = await objects.get(ref.key, ref.version);
          signal.throwIfAborted();
          if (
            bytes === undefined ||
            bytes.byteLength !== ref.bytes ||
            sha256(bytes) !== ref.sha256
          ) {
            throw new RestoreRefused(
              "CHECKPOINT_UNAVAILABLE",
              `${ref.key} is missing or not the bytes the manifest pinned`,
            );
          }
          await writeFile(path, bytes, { mode: 0o600 });
        },
      );
      signal.throwIfAborted();
      const staged = await stageCheckpointBundle({
        bundle: bundlePath,
        gitCommit: manifest.workspace.gitCommit,
        repository: join(kept, "checkpoint.git"),
        signal,
      });
      const claudeMd = await stagedClaudeMd(staged, signal);

      signal.throwIfAborted();
      await restoreCheckpointTree({
        origin: storableRepositoryUrl(claim.workspace.repository.url),
        root: workspaceRoot,
        signal,
        staged,
      });
      for (const file of manifest.workspace.untracked) {
        const bytes = await readFile(spooled.get(file.key) as string);
        signal.throwIfAborted();
        const refusal = await writeWorkspaceFile({
          bytes,
          executable: file.executable === true,
          path: file.path,
          workspaceRoot,
        });
        if (refusal !== undefined) {
          throw new RestoreRefused("CHECKPOINT_UNAVAILABLE", refusal.reason);
        }
      }
      signal.throwIfAborted();
      this.#bound = {
        claim,
        instructions:
          staged.instructions === null
            ? undefined
            : {
                commit: staged.instructions,
                objects: join(staged.repository, "objects"),
              },
        runtime,
        store,
      };
      restored = true;
      this.#options.logger.info("worker.checkpoint.restored", {
        revision: restoring.revision,
        manifest_ref: restoring.manifest_ref,
        ...(plan.fallback === undefined
          ? {}
          : { fallback_from: plan.fallback.pointer_revision }),
        git_commit: manifest.workspace.gitCommit,
        untracked: manifest.workspace.untracked.length,
      });
      return {
        mode: "resume",
        resume: manifest.resume,
        sessionStore: store,
        committedClaudeMd: () => committedClaudeMdOf(claudeMd),
        restoredRevision: restoring.revision,
      };
    } finally {
      await rm(spool, { force: true, recursive: true });
      if (!restored) await rm(kept, { force: true, recursive: true });
    }
  }

  /**
   * The manifest the claim pinned, against everything this worker knows
   * independently of it: the claim, the runtime it would resume on, and the
   * workspace root the backend provisioned.
   */
  #checkManifest(
    claim: BootstrapClaimResponse,
    pointer: CheckpointRef,
    runtime: RuntimeFingerprint,
    manifest: CheckpointManifest,
  ): void {
    const refuse = (reason: string) =>
      new RestoreRefused("CHECKPOINT_UNAVAILABLE", reason);
    if (manifest.sessionId !== claim.session_id) {
      throw refuse(`manifest belongs to session ${manifest.sessionId}`);
    }
    if (manifest.revision !== pointer.revision) {
      throw refuse(
        `manifest is revision ${manifest.revision}, not the planned ${pointer.revision}`,
      );
    }
    const verdict = this.#codec.validateCompatibility(manifest, runtime);
    if (verdict.status === "incompatible") {
      throw new RestoreRefused(
        "INCOMPATIBLE_CHECKPOINT",
        verdict.mismatches
          .map(
            ({ expected, field, found }) =>
              `${field} ${found} where this worker runs ${expected}`,
          )
          .join("; "),
      );
    }
    const cwd = restoreCwdRefusal(manifest.cwd, this.#options.workspaceRoot);
    if (cwd !== undefined) throw refuse(cwd.reason);
    const paths = workspacePathsProblem(
      manifest.workspace.untracked.map(({ path }) => path),
    );
    if (paths !== undefined) throw refuse(`untracked files: ${paths}`);
    // Before a single part is fetched: holding and parsing a transcript this
    // size is what would take the worker down (94S-296).
    const oversized = transcriptSizeProblem(
      transcriptParts(manifest.transcripts),
    );
    if (oversized !== undefined) throw refuse(oversized);
    for (const ref of [
      manifest.workspace.bundle,
      ...manifest.workspace.untracked,
    ]) {
      if (!ref.key.startsWith(this.#options.objectPrefix)) {
        throw refuse(`${ref.key} is outside this session's objects`);
      }
    }
  }

  #transcriptPrefix(): string {
    return `${this.#options.objectPrefix}${TRANSCRIPT_MIRROR_DIRECTORY}`;
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
      if (preparation.reason !== "mirror_error") {
        await this.#reportLostMirror(bound, context, undefined);
      }
      return null;
    }
    let stage = "request";
    let revision: number | null = null;
    let manifestRef: string | null = null;
    let lost: string | undefined;
    let failed: string | undefined;
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
      } else {
        revision = answer.revision;
        manifestRef = answer.manifest_ref;
        stage = "publish";
        return await this.#publish(bound, preparation, context, {
          manifestRef: answer.manifest_ref,
          revision: answer.revision,
        });
      }
    } catch (error) {
      if (isOwnershipLost(error)) throw error;
      const failedAt = error instanceof PublishFailure ? error.stage : stage;
      this.#options.logger.warn("worker.checkpoint.failed", {
        stage: failedAt,
        category: error instanceof PublishFailure ? "refused" : "error",
        reason: describe(error),
        revision,
        manifest_ref: manifestRef,
      });
      if (error instanceof MirrorLost) lost = error.message;
      else failed = `${failedAt}: ${describe(error)}`;
    }
    const mirrorLost = await this.#reportLostMirror(bound, context, lost);
    // A ready run whose checkpoint went unwritten looks, from the session,
    // exactly like one that wrote it until something needs it. A lost mirror
    // already says more, and outranks it.
    if (failed !== undefined && !mirrorLost) {
      await this.#report(
        { status: "rejected", reason: "publish_failed", detail: failed },
        context.scope,
      );
    }
    return null;
  }

  async finalizeRefused(detail: string, scope: WorkerScope): Promise<void> {
    await this.#report(
      {
        status: "rejected",
        reason: "publish_failed",
        detail: `finalize: ${detail}`,
      },
      scope,
    );
  }

  /**
   * Whatever left the turn without a checkpoint — a refusal, a blocked
   * request, a failed publish — a mirror that lost a batch is recorded
   * before the turn can be finalized without one. Answers whether it was.
   */
  async #reportLostMirror(
    bound: Bound,
    context: CheckpointCaptureContext,
    known: string | undefined,
  ): Promise<boolean> {
    let lost = known ?? (bound.store.unsettled ? UNSETTLED : undefined);
    if (lost === undefined) {
      // The run's verdict as of now: a batch the SDK gave up on after the
      // one this capture started from, which a later append may have left
      // the store settled on.
      const now = await context.recheck();
      if (now.status === "rejected" && now.reason === "mirror_error") {
        lost = now.detail;
      }
    }
    if (lost === undefined) return false;
    await this.#report(
      { status: "rejected", reason: "mirror_error", detail: lost },
      context.scope,
    );
    return true;
  }

  /**
   * Sends a refusal to the gateway, which records the ones that outlive the
   * turn as the session's pending reason. An advisory one that does not land
   * is only logged. A mirror error that does not land throws: finalize
   * without a checkpoint is accepted only while no blocking reason is
   * recorded, so the turn must stay open rather than be reported complete
   * ahead of the heartbeat that would have recorded it.
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
      if (preparation.reason === "mirror_error") {
        throw new Error(
          `The transcript mirror failed and the gateway did not record it: ${describe(error)}`,
        );
      }
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
    // The version each upload answered, which the manifest names (94S-229).
    const versions = new Map<string, string>();
    const upload = async (key: string, bytes: Uint8Array) => {
      const result = await objects.putImmutable(key, bytes);
      // Content-addressed keys under this publish's own directory: another
      // body there is corruption, not a race anyone could have won.
      if (result.outcome === "conflict") {
        throw new PublishFailure("upload", `${key} already holds other bytes`);
      }
      if (result.version !== undefined) versions.set(key, result.version);
    };
    const versioned = <T extends ObjectRef>(ref: T): T => {
      const version = versions.get(ref.key);
      return version === undefined ? ref : { ...ref, version };
    };

    const workspace = await (
      this.#options.captureWorkspace ?? captureWorkspace
    )({
      root: this.#options.workspaceRoot,
      signal: new AbortController().signal,
      ...(this.#options.limits === undefined
        ? {}
        : { limits: this.#options.limits }),
      ...(bound.instructions === undefined
        ? {}
        : { instructions: bound.instructions }),
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
      ...(file.executable ? { executable: true } : {}),
      path: file.path,
    }));
    const distinct = new Map<string, Uint8Array>();
    capture.untracked.forEach((file, index) => {
      distinct.set((untracked[index] as WorkspaceArtifact).key, file.bytes);
    });
    await inBatches([...distinct], UPLOAD_CONCURRENCY, ([key, bytes]) =>
      upload(key, bytes),
    );

    const transcripts = await bound.store
      .captureTranscripts(preparation.checkpoint.resume)
      .catch((error: unknown) => {
        throw error instanceof TranscriptTooLarge
          ? new PublishFailure("transcript", error.message)
          : error;
      });
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
      throw new MirrorLost(UNSETTLED);
    }
    const now = await context.recheck();
    if (now.status === "rejected" && now.reason === "mirror_error") {
      throw new MirrorLost(now.detail);
    }

    const oversized = transcriptSizeProblem(transcriptParts(transcripts));
    if (oversized !== undefined) {
      throw new PublishFailure("transcript", oversized);
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
      workspace: {
        bundle: versioned(bundle),
        gitCommit: capture.gitCommit,
        untracked: untracked.map(versioned),
      },
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
      ...(stored.version === undefined
        ? {}
        : { manifest_version: stored.version }),
    };
  }
}

/** The fenced identity a claim runs under, before any turn. */
function claimScope(claim: BootstrapClaimResponse): WorkerScope {
  return {
    session_id: claim.session_id,
    turn_id: null,
    attempt_id: claim.attempt_id,
    lease_epoch: claim.lease_epoch,
    execution_generation: claim.execution_generation,
    auth_revision: claim.auth_revision,
  };
}

/**
 * The gateway's plan for the claim's checkpoint, or a refusal, with the
 * checkpoint it restores. A plan for another revision or manifest means the
 * pointer moved after the claim, and the claim is what this worker restores
 * — unless the plan says it falls back from the claim's own pointer, which
 * was damaged, to an earlier revision (94S-204). That one is pinned by the
 * digest the plan carries, since the claim only knows the pointer's.
 */
function planFor(
  answer: Awaited<ReturnType<WorkerGatewayClient["restorePlan"]>>,
  pointer: CheckpointRef,
): { plan: RestorePlanWire; restoring: CheckpointRef } {
  switch (answer.status) {
    case "none":
      throw new RestoreRefused(
        "CHECKPOINT_UNAVAILABLE",
        `the claim names revision ${pointer.revision} and the gateway has no checkpoint`,
      );
    case "unavailable":
      throw new RestoreRefused(answer.code, answer.reason);
    case "incompatible":
      throw new RestoreRefused(
        answer.code,
        answer.mismatches
          .map(
            ({ expected, field, found }) =>
              `${field} ${found} where this worker runs ${expected}`,
          )
          .join("; "),
      );
    case "ready":
      break;
  }
  const { plan } = answer;
  if (plan.fallback !== undefined) {
    if (
      plan.fallback.pointer_revision !== pointer.revision ||
      plan.revision >= pointer.revision
    ) {
      throw new RestoreRefused(
        "CHECKPOINT_UNAVAILABLE",
        `the gateway falls back from revision ${plan.fallback.pointer_revision} to ${plan.revision}, not from the claim's ${pointer.revision} to an earlier one`,
      );
    }
    return {
      plan,
      restoring: {
        revision: plan.revision,
        manifest_ref: plan.manifest_ref,
        manifest_sha256: plan.manifest_sha256,
        ...(plan.manifest_version === undefined
          ? {}
          : { manifest_version: plan.manifest_version }),
      },
    };
  }
  if (
    plan.revision !== pointer.revision ||
    plan.manifest_ref !== pointer.manifest_ref
  ) {
    throw new RestoreRefused(
      "CHECKPOINT_UNAVAILABLE",
      `the gateway planned revision ${plan.revision} (${plan.manifest_ref}), not the claim's ${pointer.revision} (${pointer.manifest_ref})`,
    );
  }
  return { plan, restoring: pointer };
}

function versionsOf(plan: RestorePlanWire): Map<string, string> {
  const versions = new Map<string, string>();
  for (const artifact of plan.artifacts) {
    for (const object of artifact.objects) {
      if (object.version !== undefined)
        versions.set(object.key, object.version);
    }
  }
  return versions;
}

function transcriptsWith(
  transcripts: CheckpointTranscripts,
  pinned: (ref: ObjectRef) => ObjectRef,
): CheckpointTranscripts {
  const revision = (value: TranscriptRevision): TranscriptRevision => ({
    ...value,
    parts: value.parts.map(pinned),
  });
  return {
    root: revision(transcripts.root),
    subagents: Object.fromEntries(
      Object.entries(transcripts.subagents).map(([subpath, value]) => [
        subpath,
        revision(value),
      ]),
    ),
  };
}

/** One download per stored object, however many paths share its bytes. */
function distinctRefs(untracked: readonly WorkspaceArtifact[]): ObjectRef[] {
  const byKey = new Map<string, ObjectRef>();
  for (const file of untracked) byKey.set(file.key, file);
  return [...byKey.values()];
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
