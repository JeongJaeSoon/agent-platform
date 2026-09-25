import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
  type ImmutableObjectSource,
  isOwnershipLost,
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
  WorkerGatewayRequestError,
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
  CheckpointBundleRefused,
  clearWorkspace,
  restoreCheckpointTree,
  stageCheckpointBundle,
  stagedClaudeMd,
} from "./checkpoint-restore.ts";
import { isObjectStoreOutage } from "./object-store.ts";
import type { WorkerLogger } from "./worker-host.ts";
import {
  committedClaudeMdOf,
  storableRepositoryUrl,
  workerScratch,
} from "./workspace.ts";
import {
  type BundleBase,
  captureWorkspace,
  DEFAULT_WORKSPACE_CAPTURE_LIMITS,
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
/**
 * The control plane's `MAX_WORKSPACE_BUNDLE_CHAIN`: a bundle builds on at
 * most one fewer. At the limit the next one stands alone and a chain starts
 * over.
 */
const MAX_BUNDLE_CHAIN = 32;
const UPLOAD_CONCURRENCY = 8;
/** Objects a restore downloads at once, each streamed and verified to disk. */
const DOWNLOAD_CONCURRENCY = 8;
/**
 * A restore the object store failed is redone after 1s, doubling to 30s,
 * until the startup budget (`WORKER_STARTUP_TIMEOUT_SEC`) stops it (94S-390).
 */
const RESTORE_RETRY_FIRST_MS = 1_000;
const RESTORE_RETRY_MAX_MS = 30_000;
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
  /** Swapped in by tests that need a workspace refused or captured slowly. */
  captureWorkspace?: (input: {
    root: string;
    bundlePath: string;
    signal: AbortSignal;
    limits?: WorkspaceCaptureLimits;
    instructions?: InstructionsPin;
    base?: BundleBase;
  }) => Promise<WorkspaceCaptureResult>;
  limits?: WorkspaceCaptureLimits;
  now?: () => Date;
  /** Waits out a restore's backoff; resolves early once `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

type Bound = {
  claim: BootstrapClaimResponse;
  /** Carried into every bundle this run captures (`CHECKPOINT_INSTRUCTIONS_REF`). */
  instructions: InstructionsPin | undefined;
  runtime: RuntimeFingerprint;
  store: ClaudeSessionStore;
  /** The checkpoint restored from, or the last one this run saw committed. */
  committed?: BundleChain;
  /** The last one this run published, until the next shows it committed. */
  published?: BundleChain | undefined;
};

/** A checkpoint's workspace bundles as its manifest names them (94S-227). */
type BundleChain = {
  revision: number;
  /** Oldest first; the last is the manifest's `bundle`. */
  links: readonly ObjectRef[];
  tips: readonly string[];
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
 * back.
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
    const pointer = claim.restore;
    if (pointer !== null) {
      // The store not answering is no fault of the checkpoint: the restore
      // is redone whole inside this attempt rather than failing a claim the
      // session counts towards RESTORE_FAILED (94S-390). What the store did
      // answer is held to the manifest as ever.
      for (let retries = 0; ; retries += 1) {
        try {
          return await this.#restore(claim, pointer, runtime, signal);
        } catch (caught) {
          if (!signal.aborted && isRestoreOutage(caught)) {
            const retryInMs = Math.min(
              RESTORE_RETRY_FIRST_MS * 2 ** retries,
              RESTORE_RETRY_MAX_MS,
            );
            this.#options.logger.warn("worker.checkpoint.restore_unavailable", {
              reason: describe(caught),
              retries,
              retry_in_ms: retryInMs,
              revision: pointer.revision,
              manifest_ref: pointer.manifest_ref,
            });
            await (this.#options.sleep ?? sleepUnlessAborted)(
              retryInMs,
              signal,
            );
            signal.throwIfAborted();
            continue;
          }
          // Bytes that fail the store's checksum are as damaged as bytes that
          // fail the manifest's digest; only the layer that caught them
          // differs. So is a bundle that holds its digest but not its shape.
          const error =
            caught instanceof ObjectIntegrityError ||
            caught instanceof CheckpointBundleRefused
              ? new RestoreRefused("CHECKPOINT_UNAVAILABLE", caught.message)
              : caught;
          if (error instanceof RestoreRefused) {
            this.#options.logger.error("worker.checkpoint.restore_refused", {
              code: error.code,
              reason: error.message,
              revision: pointer.revision,
              manifest_ref: pointer.manifest_ref,
            });
          }
          throw error;
        }
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
   * Restores the checkpoint the claim names, in three steps.
   *
   * What needs no disk runs first, while the workspace is untouched: the
   * gateway's plan (whose fingerprint verdict is made against this worker's
   * recomputed one, 94S-261), the manifest the claim pinned by digest — the
   * authority for everything else — checked against the claim, this runtime
   * and this workspace root, and the inherited transcript parts read and
   * parsed.
   *
   * Then the old tree is cleared, to make room on the one disk the worker
   * has, and every object the manifest names is downloaded there and held to
   * its digest: the bundle fetched and its refs checked in a repository of
   * the worker's own, the untracked files spooled.
   *
   * Only then is the checkout written, and the untracked files written
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

    // On the workspace volume, the only disk a worker has, and so only once
    // the tree it replaces is gone: the volume's quota must not have to hold
    // both. Nothing reads that tree after a restore has a plan — this one
    // replaces it, and so does any restore after one that fails from here.
    // The restore moves the spool into the new `.git`, where its staged
    // repository outlives it: later captures take the instructions commit's
    // objects from it.
    signal.throwIfAborted();
    await clearWorkspace(workspaceRoot, signal);
    signal.throwIfAborted();
    let spool = await mkdtemp(join(workspaceRoot, ".agent-platform-restore-"));
    const spooled = new Map<string, string>();
    const bases = manifest.workspace.baseBundles ?? [];
    const artifacts = [
      { name: "workspace.bundle", ref: pinned(manifest.workspace.bundle) },
      ...bases.map((ref, index) => ({
        name: `workspace-base-${index}.bundle`,
        ref: pinned(ref),
      })),
      ...distinctRefs(manifest.workspace.untracked).map((ref, index) => {
        const name = `untracked-${index}`;
        spooled.set(ref.key, name);
        return { name, ref: pinned(ref) };
      }),
    ];
    let restored = false;
    try {
      await downloadAll(objects, artifacts, spool, signal);
      signal.throwIfAborted();
      const staged = await stageCheckpointBundle({
        bases: bases.map((_, index) =>
          join(spool, `workspace-base-${index}.bundle`),
        ),
        bundle: join(spool, "workspace.bundle"),
        gitCommit: manifest.workspace.gitCommit,
        repository: join(spool, "checkpoint.git"),
        signal,
      });
      const claudeMd = await stagedClaudeMd(staged, signal);
      // Staged, so their disk is free before the workspace fetches a copy.
      await Promise.all(
        artifacts
          .filter(({ name }) => name.endsWith(".bundle"))
          .map(({ name }) => rm(join(spool, name), { force: true })),
      );

      signal.throwIfAborted();
      const tree = await restoreCheckpointTree({
        keep: spool,
        origin: storableRepositoryUrl(claim.workspace.repository.url),
        root: workspaceRoot,
        signal,
        staged,
      });
      spool = tree.kept ?? spool;
      for (const file of manifest.workspace.untracked) {
        const bytes = await readFile(
          join(spool, spooled.get(file.key) as string),
        );
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
                objects: join(tree.staged.repository, "objects"),
              },
        runtime,
        store,
        committed: {
          revision: restoring.revision,
          links: [...bases, manifest.workspace.bundle],
          tips: staged.tips,
        },
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
      if (restored) {
        await Promise.all(
          artifacts.map(({ name }) => rm(join(spool, name), { force: true })),
        );
      } else {
        await rm(spool, { force: true, recursive: true });
      }
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
      ...(manifest.workspace.baseBundles ?? []),
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
    const timer = new StageTimer();
    try {
      const answer = await timer.time("request", () =>
        this.#options.gateway.requestCheckpoint({
          ...context.scope,
          preparation: { status: "ready" },
        }),
      );
      if (answer.status === "blocked") {
        this.#options.logger.warn("worker.checkpoint.blocked", {
          reason: answer.reason,
          detail: answer.detail,
        });
      } else {
        revision = answer.revision;
        manifestRef = answer.manifest_ref;
        stage = "publish";
        return await this.#publish(
          bound,
          preparation,
          context,
          { manifestRef: answer.manifest_ref, revision: answer.revision },
          timer,
        );
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
        ...timer.fields(),
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
    if (this.#bound !== undefined) this.#bound.published = undefined;
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

  /**
   * The chain a capture for `revision` may build on: that of the checkpoint
   * right before it, which finalize holds the new one to, and only while
   * every bundle of it is still in the store. The server hands out the
   * revision after the pointer, so one that follows what this run published
   * last shows that one committed; one that does not, that it was not.
   */
  async #chainBefore(
    bound: Bound,
    revision: number,
  ): Promise<BundleChain | undefined> {
    if (bound.published?.revision === revision - 1) {
      bound.committed = bound.published;
    }
    bound.published = undefined;
    const chain = bound.committed;
    if (
      chain === undefined ||
      chain.revision !== revision - 1 ||
      chain.links.length >= MAX_BUNDLE_CHAIN
    ) {
      return undefined;
    }
    const present = await Promise.all(
      chain.links.map(async (link) => {
        try {
          const head = await this.#options.objects.head(link.key, link.version);
          return head?.bytes === link.bytes;
        } catch {
          return false;
        }
      }),
    );
    return present.every(Boolean) ? chain : undefined;
  }

  async #publish(
    bound: Bound,
    preparation: ReadyCheckpoint,
    context: CheckpointCaptureContext,
    request: { manifestRef: string; revision: number },
    timer: StageTimer,
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
    const upload = async (
      key: string,
      body: Uint8Array | ImmutableObjectSource,
    ) => {
      const result = await objects.putImmutable(key, body, {
        contentAddressed: true,
      });
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

    const spool = await workerScratch(this.#options.workspaceRoot, "publish");
    if (spool === undefined) {
      throw new PublishFailure(
        "workspace",
        "the workspace .git is not a directory",
      );
    }
    const chain = await timer.time("chain", () =>
      this.#chainBefore(bound, request.revision),
    );
    const maxBundleBytes = (
      this.#options.limits ?? DEFAULT_WORKSPACE_CAPTURE_LIMITS
    ).maxBundleBytes;
    let captured: WorkspaceCaptureResult;
    let bundle: ObjectRef;
    try {
      const workspaceCapture =
        this.#options.captureWorkspace ?? captureWorkspace;
      captured = await timer.time("git", () =>
        workspaceCapture({
          root: this.#options.workspaceRoot,
          bundlePath: join(spool, "workspace.bundle"),
          signal: new AbortController().signal,
          ...(this.#options.limits === undefined
            ? {}
            : { limits: this.#options.limits }),
          ...(bound.instructions === undefined
            ? {}
            : { instructions: bound.instructions }),
          ...(chain === undefined
            ? {}
            : {
                base: {
                  maxBytes:
                    maxBundleBytes -
                    chain.links.reduce((total, link) => total + link.bytes, 0),
                  tips: chain.tips,
                },
              }),
        }),
      );
      if (captured.status === "refused") {
        throw new PublishFailure("workspace", captured.reason);
      }
      const { bytes, path, sha256: digest } = captured.capture.bundle;
      bundle = {
        bytes,
        key: `${directory}workspace-${digest}.bundle`,
        sha256: digest,
      };
      await timer.time("bundle_upload", () =>
        upload(bundle.key, {
          bytes,
          sha256: digest,
          open: () => createReadStream(path),
        }),
      );
    } finally {
      await rm(spool, { force: true, recursive: true });
    }
    const { capture } = captured;
    const bases = capture.bundle.incremental ? (chain?.links ?? []) : [];

    const untracked: WorkspaceArtifact[] = capture.untracked.map((file) => ({
      ...refOf(`${directory}untracked/${sha256(file.bytes)}`, file.bytes),
      ...(file.executable ? { executable: true } : {}),
      path: file.path,
    }));
    const distinct = new Map<string, Uint8Array>();
    capture.untracked.forEach((file, index) => {
      distinct.set((untracked[index] as WorkspaceArtifact).key, file.bytes);
    });
    await timer.time("untracked_upload", () =>
      inBatches([...distinct], UPLOAD_CONCURRENCY, ([key, bytes]) =>
        upload(key, bytes),
      ),
    );

    const transcripts = await timer.time("transcript", () =>
      bound.store
        .captureTranscripts(preparation.checkpoint.resume)
        .catch((error: unknown) => {
          throw error instanceof TranscriptTooLarge
            ? new PublishFailure("transcript", error.message)
            : error;
        }),
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
      throw new MirrorLost(UNSETTLED);
    }
    const now = await timer.time("recheck", () => context.recheck());
    if (now.status === "rejected" && now.reason === "mirror_error") {
      throw new MirrorLost(now.detail);
    }

    const oversized = transcriptSizeProblem(transcriptParts(transcripts));
    if (oversized !== undefined) {
      throw new PublishFailure("transcript", oversized);
    }
    const referenced =
      1 +
      bases.length +
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
        ...(bases.length === 0 ? {} : { baseBundles: bases }),
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
    const stored = await timer.time("manifest", () =>
      objects.putImmutable(manifestRef, encoded.bytes),
    );
    if (stored.outcome === "conflict") {
      throw new PublishFailure(
        "manifest",
        `${manifestRef} already holds another manifest`,
      );
    }
    bound.published = {
      revision: request.revision,
      links: [...bases, manifest.workspace.bundle],
      tips: [
        ...(bases.length === 0 ? [] : (chain?.tips ?? [])),
        ...capture.bundle.tips,
      ],
    };
    this.#options.logger.info("worker.checkpoint.published", {
      revision: request.revision,
      manifest_ref: manifestRef,
      git_commit: capture.gitCommit,
      untracked: untracked.length,
      bundle_bytes: bundle.bytes,
      base_bundles: bases.length,
      ...timer.fields(),
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

/**
 * How long each stage of one capture took, for its log line (94S-380): a
 * capture that runs long says which stage it spent the time in. A stage
 * that failed is timed up to its failure; one never reached is absent.
 */
class StageTimer {
  readonly #started = performance.now();
  readonly #stages: Record<string, number> = {};

  async time<T>(stage: string, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await work();
    } finally {
      this.#stages[stage] = Math.round(performance.now() - started);
    }
  }

  fields(): { durations_ms: Record<string, number>; total_ms: number } {
    return {
      durations_ms: { ...this.#stages },
      total_ms: Math.round(performance.now() - this.#started),
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

/**
 * Streams `ref` into a new file at `path`, held to the manifest's size and
 * digest as it arrives: a body longer than pinned stops at the first byte
 * past it.
 */
async function download(
  objects: CheckpointObjectStore,
  ref: ObjectRef,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  const damaged = () =>
    new RestoreRefused(
      "CHECKPOINT_UNAVAILABLE",
      `${ref.key} is missing or not the bytes the manifest pinned`,
    );
  const body = await objects.stream(ref.key, ref.version);
  if (body === undefined) throw damaged();
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    Readable.from(
      (async function* () {
        for await (const chunk of body) {
          bytes += chunk.byteLength;
          if (bytes > ref.bytes) throw damaged();
          hash.update(chunk);
          // Copied: the store may refill the chunk before the file takes it.
          yield Buffer.from(chunk);
        }
      })(),
    ),
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
    { signal },
  );
  if (bytes !== ref.bytes || hash.digest("hex") !== ref.sha256) {
    throw damaged();
  }
}

/**
 * The object store failing to answer, or the gateway failing to plan for the
 * same reason (it reads the checkpoint's objects too, and answers a
 * retryable error then). Everything else fails the claim as before.
 */
function isRestoreOutage(error: unknown): boolean {
  return (
    (error instanceof WorkerGatewayRequestError && error.retryable) ||
    isObjectStoreOutage(error)
  );
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Every artifact into `spool`, `DOWNLOAD_CONCURRENCY` at a time. The first
 * failure stops the rest and they are waited out before it is thrown, so a
 * restore redone after it never shares the volume with this one's streams.
 */
async function downloadAll(
  objects: CheckpointObjectStore,
  artifacts: readonly { name: string; ref: ObjectRef }[],
  spool: string,
  signal: AbortSignal,
): Promise<void> {
  const round = new AbortController();
  const stop = () => round.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  let failure: { error: unknown } | undefined;
  try {
    for (
      let start = 0;
      start < artifacts.length;
      start += DOWNLOAD_CONCURRENCY
    ) {
      await Promise.allSettled(
        artifacts
          .slice(start, start + DOWNLOAD_CONCURRENCY)
          .map(({ name, ref }) =>
            download(objects, ref, join(spool, name), round.signal).catch(
              (error: unknown) => {
                failure ??= { error };
                round.abort(error);
              },
            ),
          ),
      );
      if (failure !== undefined) throw failure.error;
    }
  } finally {
    signal.removeEventListener("abort", stop);
  }
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
