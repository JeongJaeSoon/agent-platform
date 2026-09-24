import { createHash } from "node:crypto";
import type {
  AttemptState,
  BootstrapClaimResponse,
  CheckpointRef,
  ClaimPrincipal,
  ControlIntent,
  NextInputResponse,
  RuntimeConfig,
  SessionRuntime,
  TerminalTurnStatus,
  TranscriptReport,
  WorkerScope,
} from "@agent-platform/contracts";
import {
  MAX_TURN_COST_USD,
  TURN_BUDGET_EXCEEDED_REASON,
} from "@agent-platform/contracts";
import { endedByAbort } from "@agent-platform/runtime-claude";
import type {
  AgentRun,
  CheckpointLease,
  NativeSdkMessage,
  PermissionDecision,
  PermissionRequest,
  RuntimeHooks,
  WorkerGatewayClient,
} from "@agent-platform/runtime-core";

import type { RuntimeResumePlan, WorkerCheckpointPort } from "./checkpoint.ts";
import { LEASE_SAFETY_MARGIN_MS, type WorkerTimeouts } from "./config.ts";
import type { EngineExitWatch } from "./engine-processes.ts";
import { EventPublisher } from "./event-publisher.ts";
import {
  isOwnershipLost,
  isRetryable,
  WorkerGatewayRequestError,
} from "./gateway-client.ts";
import { Heartbeat } from "./heartbeat.ts";
import { PendingRequestRegistry } from "./pending-requests.ts";
import {
  claimSecrets,
  SecretScrubber,
  scrubbingGateway,
} from "./secret-scrubber.ts";
import { type ProviderFailure, TurnAccounting } from "./turn-accounting.ts";
import type { WorkspacePreparer } from "./workspace.ts";

/** Where the claim's object store token goes (94S-251). */
export type ObjectStoreAccess = { useToken(token: string): void };

/** The gateway client plus the one thing a claim changes about it. */
export interface WorkerGatewaySession extends WorkerGatewayClient {
  /** Swaps the launch nonce for the credential bootstrapClaim issued. */
  useCredential(credential: string): void;
}

/**
 * `runtimeConfig` is the claim's: the server resolved it from the session's
 * profile. `principal` is the claim's too — the session's owner partition,
 * which the runtime hashes into every checkpoint fingerprint (94S-209). It
 * is never defaulted here: a worker that made one up would let two
 * partitions on one provider resume each other's checkpoints.
 */
export type RuntimeLaunch = RuntimeResumePlan & {
  /** The workspace's, read only when the profile lets the file in. */
  committedClaudeMd: () => string | null;
  correlationId: string;
  /** The claim's remaining_budget_usd: this run counts its spend from zero. */
  maxBudgetUsd: number;
  principal: ClaimPrincipal;
  runtimeConfig: RuntimeConfig;
};

export type RuntimeLauncher = {
  start(launch: RuntimeLaunch, hooks: RuntimeHooks): AgentRun;
};

export interface RuntimeRegistry {
  /** Throws when this worker cannot run what the session was created with. */
  launcherFor(runtime: SessionRuntime): RuntimeLauncher;
}

export type WorkerLogger = {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
};

/** A worker never cancels a turn; cancellation is the control plane's call. */
export type WorkerTerminalStatus = Exclude<TerminalTurnStatus, "cancelled">;

export type TurnOutcome = {
  turnId: string;
  status: WorkerTerminalStatus;
  reason: string | null;
};

export type WorkerRunSummary = {
  outcome:
    | "unclaimed"
    | "idle"
    | "drained"
    | "paused"
    | "lease_lost"
    | "failed";
  reason: string;
  turns: TurnOutcome[];
};

export type WorkerHostOptions = {
  checkpoints: WorkerCheckpointPort;
  execution: { bootstrapNonce: string; generation: number; id: string };
  gateway: WorkerGatewaySession;
  runtimes: RuntimeRegistry;
  timeouts: WorkerTimeouts;
  workspace: WorkspacePreparer;
  logger?: WorkerLogger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Absent for engines that spawn no process, like the fake. */
  engines?: EngineExitWatch;
  /** Absent when the checkpoint port is a fake that needs no token. */
  objectStoreAccess?: ObjectStoreAccess;
  /**
   * Secrets this process holds besides the ones the claim brings, kept out
   * of events by value (`SecretScrubber`): the object store key, say.
   */
  secrets?: readonly string[];
};

/**
 * `failed` winds down like a drain; only the reported outcome differs.
 * `paused` comes after the release that committed a pause, so the shutdown
 * that follows has nothing left to release.
 */
type Stop = {
  kind: "drain" | "failed" | "idle" | "lost" | "paused";
  reason: string;
  /**
   * A drain asked of this process from outside (`drain`), unlike the ones
   * it decides itself: a mirror error can end a startup as surely as a
   * failure does (94S-302).
   */
  requested?: true;
};

type Settlement = {
  /** What the engine says the turn cost; absent when it said nothing. */
  costUsd?: number;
  reason: string | null;
  result: unknown;
  status: WorkerTerminalStatus;
  /**
   * Decided here rather than reported by the engine: there is no engine
   * terminal a checkpoint could be consistent with, so none is taken.
   */
  synthetic?: true;
  usage: unknown;
};

type Turn = {
  /** Past its terminal: what the engine emits now belongs to no turn. */
  closed: boolean;
  /** An interrupt intent for this turn has been taken. */
  interrupting: boolean;
  /**
   * How the engine answered the interrupt sent for this turn, if one was.
   * The SDK ends every abort alike, so only an acknowledged interrupt makes
   * an aborted terminal an interrupted turn.
   */
  interruptReceipt?: "pending" | "acknowledged" | "refused";
  /** Settles once interruptReceipt is no longer pending. */
  interruptAnswered?: Promise<void>;
  /**
   * When the interrupt's grace runs out (performance.now()): it bounds the
   * whole way to a terminal, checkpoint capture included, not each step.
   */
  interruptDeadline?: number;
  /** The input went to the engine: an interrupt can only reach it from here. */
  sent: boolean;
  settled: Promise<Settlement>;
  settle: (settlement: Settlement | Promise<Settlement>) => void;
  /** The deadline fired: whatever terminal comes now is the timeout's. */
  timedOut: boolean;
  timers: ReturnType<typeof setTimeout>[];
  turnId: string;
  uuid: string;
};

const CLAIM_RETRY_MS = 1_000;
const GATEWAY_RETRY_MS = 500;
/** How long an interrupted engine gets to produce its terminal frame. */
const INTERRUPT_GRACE_MS = 5_000;
/** How long a closed engine gets to exit, and a killed one after that. */
const ENGINE_EXIT_GRACE_MS = 5_000;
/** Kept back from the stop grace for the release call. */
const RELEASE_RESERVE_MS = 2_000;
/** The default for `timeouts.toolUseFrameWaitMs`. */
const TOOL_USE_FRAME_WAIT_MS = 10_000;

/**
 * The worker process: one session, one attempt, however many turns the lease
 * lasts for.
 *
 * `runLoop` claims a session, opens one engine run and feeds it inputs one at
 * a time — turns for a session are serial, so there is at most one outstanding
 * input and a single frame pump can attribute every terminal to the turn that
 * is waiting for it. Ownership is the other axis: the heartbeat runs on its
 * own clock, and the moment it says this attempt no longer owns the session
 * the loop stops writing anything at all.
 */
export class WorkerHost {
  private readonly options: WorkerHostOptions;
  private readonly logger: WorkerLogger;
  private readonly turns: TurnOutcome[] = [];
  private readonly checkpoints: WorkerCheckpointPort;
  private engine: AgentRun | undefined;
  /**
   * The engine's answer to the last interrupt sent. The next input waits for
   * it: an interrupt still in flight when a turn ends on its own would
   * otherwise land on the one after.
   */
  private interruptAnswered: Promise<void> | undefined;
  private attemptState: AttemptState = "starting";
  private heartbeat: Heartbeat | undefined;
  private mirrorError: string | undefined;
  private pending: PendingRequestRegistry | undefined;
  private publisher: EventPublisher | undefined;
  private pumping: Promise<void> | undefined;
  /** The restore in flight or done, settled either way; see `shutdown`. */
  private restoring: Promise<void> | undefined;
  private scopeValue: WorkerScope | undefined;
  private scrubber: SecretScrubber | undefined;
  private stopping: Stop | undefined;
  /** Resolves when the current turn has to be given up unfinished. */
  private readonly abandoned: Promise<void>;
  private announceAbandon: () => void = () => {};
  private abandonedNow = false;
  /** When the drain under way gives the turn up, on the monotonic clock its timer runs on. */
  private abandonsAt: number | undefined;
  /** Aborted by any stop: a clone in progress is not worth finishing. */
  private readonly preparation = new AbortController();
  private stoppedAt: number | undefined;
  private readonly stopped: Promise<void>;
  private announceStop: () => void = () => {};
  private released = false;
  /**
   * The pause this attempt was asked for (its control id). Not a stop: the
   * turn in flight runs on with its questions and approvals, and only the
   * release that commits the pause ends the loop.
   */
  private pauseControl: string | undefined;
  private turn: Turn | undefined;
  private readonly accounting = new TurnAccounting();

  constructor(options: WorkerHostOptions) {
    this.options = options;
    this.checkpoints = options.checkpoints;
    this.logger = options.logger ?? consoleLogger;
    this.abandoned = new Promise<void>((resolve) => {
      this.announceAbandon = () => {
        this.abandonedNow = true;
        resolve();
      };
    });
    this.stopped = new Promise<void>((resolve) => {
      this.announceStop = resolve;
    });
  }

  /** Asks the loop to wind down at the next safe point; safe from a signal handler. */
  drain(reason: string): void {
    this.stop({ kind: "drain", reason, requested: true });
  }

  async runLoop(): Promise<WorkerRunSummary> {
    const claimed = await this.claim();
    if (claimed === null) {
      return {
        outcome: "unclaimed",
        reason:
          this.stopping?.reason ?? "No session was waiting for this worker",
        turns: [],
      };
    }
    const { claim } = claimed;
    this.options.gateway.useCredential(claim.session_credential);
    this.options.objectStoreAccess?.useToken(claim.object_store.access.token);
    this.scopeValue = {
      session_id: claim.session_id,
      turn_id: null,
      attempt_id: claim.attempt_id,
      lease_epoch: claim.lease_epoch,
      execution_generation: claim.execution_generation,
      auth_revision: claim.auth_revision,
    };
    this.logger.info("worker.claimed", {
      session_id: claim.session_id,
      attempt_id: claim.attempt_id,
      restore_revision: claim.restore?.revision ?? null,
    });

    // Everything this process holds that the engine's tools could print.
    this.scrubber = new SecretScrubber([
      ...claimSecrets(claim, this.options.execution.bootstrapNonce),
      ...(this.options.secrets ?? []),
    ]);
    const scrubbed = scrubbingGateway(this.options.gateway, this.scrubber);
    const publisher = new EventPublisher({
      gateway: scrubbed,
      scope: () => this.scope,
      now: this.options.now ?? (() => new Date()),
      onFailed: (error) => {
        if (isOwnershipLost(error)) {
          this.lose(describe(error));
          return;
        }
        // Nothing the engine does from here is recorded, so nothing waiting
        // on a person may be allowed to run.
        this.pending?.cancelAll("The session's events can no longer be stored");
        this.fail(`Events could not be stored: ${describe(error)}`);
      },
    });
    this.publisher = publisher;
    this.pending = new PendingRequestRegistry({
      gateway: scrubbed,
      eventsStored: (toolUseId) =>
        publisher.toolUseStored(
          toolUseId,
          this.options.timeouts.toolUseFrameWaitMs ?? TOOL_USE_FRAME_WAIT_MS,
        ),
      scope: () => this.scope,
      timeoutMs: this.options.timeouts.questionTimeoutMs,
      pollIntervalMs: this.options.timeouts.answerPollIntervalMs,
      onOwnershipLost: (error) => this.lose(describe(error)),
      onControl: (control) => this.onControl(control),
    });
    this.heartbeat = new Heartbeat({
      gateway: this.options.gateway,
      scope: () => this.scope,
      attemptState: () => this.attemptState,
      intervalMs: this.options.timeouts.heartbeatIntervalMs,
      lease: { remainingMs: claim.lease_remaining_ms, sentAt: claimed.sentAt },
      safetyMarginMs:
        this.options.timeouts.leaseSafetyMarginMs ?? LEASE_SAFETY_MARGIN_MS,
      onLost: (reason) => this.lose(reason),
      onControlPending: () => this.pending?.poll(true),
      transcript: () => this.transcriptReport(),
    });

    let run: AgentRun | undefined;
    try {
      const launcher = this.options.runtimes.launcherFor(claim.runtime);
      // From here on: a clone can take longer than the lease the claim gave.
      this.heartbeat.start();
      const startup = this.stageBudget(
        "Starting the session",
        this.options.timeouts.startupTimeoutMs,
      );
      let ready = false;
      try {
        const plan = await this.startUp(claim);
        if (plan !== undefined && this.stopping === undefined) {
          run = launcher.start(
            {
              ...plan,
              committedClaudeMd:
                plan.mode === "resume" && plan.committedClaudeMd !== undefined
                  ? plan.committedClaudeMd
                  : () => this.options.workspace.committedClaudeMd(),
              correlationId: `${claim.session_id}:${claim.attempt_id}`,
              maxBudgetUsd: claim.remaining_budget_usd,
              principal: claim.principal,
              runtimeConfig: claim.runtime_config,
            },
            { onPermission: (request) => this.onPermission(request) },
          );
          this.engine = run;
          this.attemptState = "running";
          this.pumping = this.pump(run);
          ready = await this.reportReady(run, plan, claim);
        }
      } finally {
        startup.disarm();
      }
      if (run !== undefined && ready) await this.turnLoop(run);
    } catch (error) {
      // A worker that failed but still owns the session gives it back, so
      // recovery does not have to wait for the lease to lapse.
      this.stop({
        kind: isOwnershipLost(error) ? "lost" : "failed",
        reason: describe(error),
      });
      this.logger.error("worker.failed", { reason: describe(error) });
      await this.shutdown(run);
      return {
        outcome: this.stopping?.kind === "lost" ? "lease_lost" : "failed",
        reason: describe(error),
        turns: this.turns,
      };
    }
    await this.shutdown(run);
    // Read after the shutdown: the lease can still be lost while it runs.
    const stop = this.stopping ?? { kind: "drain", reason: "loop ended" };
    return {
      outcome:
        stop.kind === "lost"
          ? "lease_lost"
          : stop.kind === "idle"
            ? "idle"
            : stop.kind === "failed"
              ? "failed"
              : stop.kind === "paused"
                ? "paused"
                : "drained",
      reason: stop.reason,
      turns: this.turns,
    };
  }

  /**
   * Prepares the workspace and resolves the restore plan, or gives up at the
   * first stop — the startup budget's included. Both are raced with it: a
   * preparation that ignores its abort, or a restore that never answers,
   * would otherwise hold a session the heartbeat keeps leased. Undefined
   * once stopped; whatever either answers after that is not used.
   */
  private async startUp(
    claim: BootstrapClaimResponse,
  ): Promise<RuntimeResumePlan | undefined> {
    const prepared = await this.untilStopped(
      this.options.workspace
        .prepare({
          descriptor: claim.workspace,
          restore: claim.restore,
          signal: this.preparation.signal,
        })
        .catch((error: unknown) => {
          // A stop aborts the preparation; that is the stop's outcome, not a
          // failure of its own.
          if (this.preparation.signal.aborted) return undefined;
          throw error;
        }),
    );
    if (prepared === undefined || this.stopping !== undefined) return;
    this.logger.info("worker.workspace.prepared", {
      action: prepared,
      repository_id: claim.workspace.repository.id,
      branch: claim.workspace.repository.branch,
    });
    const restoring = this.checkpoints
      .restorePlan(claim, this.preparation.signal)
      .catch((error: unknown) => {
        if (this.preparation.signal.aborted) return undefined;
        throw error;
      });
    this.restoring = restoring.then(
      () => {},
      () => {},
    );
    return this.untilStopped(restoring);
  }

  /**
   * Tells the gateway this attempt restored what its claim named and can
   * take input: a session resumed out of `paused` admits none until then
   * (94S-138). A resumed engine is waited on first — its transcript loaded,
   * the engine initialized — so a restore that fails there fails the resume
   * instead of reaching the first turn. The revision reported is the one the
   * restore loaded (the claim's, for a plan resuming this container's disk);
   * a plan that fell back to a fresh engine reports none, which the gateway
   * refuses for a resuming session. A
   * claim with nothing to restore has nothing to prove and sends no report,
   * so a worker ahead of its API still serves new sessions. Inside the
   * startup budget. False once stopped.
   */
  private async reportReady(
    run: AgentRun,
    plan: RuntimeResumePlan,
    claim: BootstrapClaimResponse,
  ): Promise<boolean> {
    if (claim.restore === null) return true;
    if (plan.mode === "resume") {
      const loaded = await this.untilStopped(run.ready().then(() => true));
      if (loaded === undefined || this.stopping !== undefined) return false;
    }
    const restored =
      plan.mode === "resume"
        ? (plan.restoredRevision ?? claim.restore.revision)
        : null;
    const answer = await this.untilStopped(
      this.withRetry(() =>
        this.options.gateway.ready({
          ...this.scope,
          restored_revision: restored,
        }),
      ),
    );
    if (answer === undefined || this.stopping !== undefined) return false;
    if (answer.activated) {
      this.logger.info("worker.resume.ready", { restore_revision: restored });
    }
    return true;
  }

  /** Read through getters: the field changes across awaits, which narrowing cannot see. */
  private get ownerLost(): boolean {
    return this.stopping?.kind === "lost";
  }

  private get stopKind(): Stop["kind"] | undefined {
    return this.stopping?.kind;
  }

  private get scope(): WorkerScope {
    if (this.scopeValue === undefined) {
      throw new Error("The worker has no claimed session");
    }
    return this.scopeValue;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private sleep(ms: number): Promise<void> {
    return (this.options.sleep ?? ((wait: number) => Bun.sleep(wait)))(ms);
  }

  private stop(stop: Stop): void {
    if (this.stopping !== undefined) return;
    this.stopping = stop;
    this.preparation.abort();
    if (stop.kind !== "lost") {
      this.attemptState = "draining";
      // The launcher's SIGKILL clock starts with its SIGTERM, not a lease loss.
      this.stoppedAt ??= this.now().getTime();
    }
    this.announceStop();
    this.logger.info("worker.stopping", {
      kind: stop.kind,
      reason: stop.reason,
    });
    // Tell the gateway now rather than at the next beat: a draining attempt
    // is handed no further input. A paused one has already released.
    if (stop.kind !== "lost" && stop.kind !== "paused") {
      this.heartbeat?.beatNow();
    }
    if (stop.kind === "lost") {
      this.announceAbandon();
      return;
    }
    // A drain lets the turn in flight finish and be finalized; only once that
    // budget is spent is it given up for the recovery path to retry.
    this.abandonsAt = performance.now() + this.options.timeouts.drainTimeoutMs;
    const timer = setTimeout(
      () => this.announceAbandon(),
      this.options.timeouts.drainTimeoutMs,
    );
    timer.unref?.();
  }

  /**
   * A failure that must show in the outcome even when a drain is already
   * under way: first-wins `stop` would report the session as cleanly drained
   * while events it owed were never stored.
   */
  private fail(reason: string): void {
    if (this.stopping === undefined) {
      this.stop({ kind: "failed", reason });
      return;
    }
    if (this.stopping.kind === "lost" || this.stopping.kind === "failed") {
      return;
    }
    this.stopping = { kind: "failed", reason };
    this.logger.error("worker.failed", { reason });
  }

  private lose(reason: string): void {
    // A poll still in flight when the session was given back comes home to
    // a fence that is gone; that is the release, not a lease loss.
    if (this.released) return;
    if (this.stopping?.kind === "lost") return;
    this.stopping = undefined;
    this.stop({ kind: "lost", reason });
    // Owner loss means no further durable writes from this attempt, so the
    // queued tail is dropped rather than retried against someone else's lease.
    this.publisher?.abandon(reason);
    this.pending?.cancelAll("This worker no longer owns the session");
    this.pending?.stop();
  }

  /** The claim, with the monotonic instant the request that won it went out. */
  private async claim(): Promise<{
    claim: BootstrapClaimResponse;
    sentAt: number;
  } | null> {
    const deadline =
      this.now().getTime() + this.options.timeouts.claimTimeoutMs;
    let retriedUnauthorized = false;
    for (;;) {
      if (this.stopping !== undefined) return null;
      const sentAt = performance.now();
      try {
        const claimed = await this.untilStopGraceSpent(
          this.options.gateway.bootstrapClaim({
            execution_id: this.options.execution.id,
            execution_generation: this.options.execution.generation,
            credential: {
              kind: "launch_nonce",
              nonce: this.options.execution.bootstrapNonce,
            },
          }),
        );
        if (claimed === undefined) {
          // Past this point the SIGKILL would take the release away anyway;
          // a claim that lands later is recovered when its lease lapses.
          this.logger.warn("worker.claim.abandoned", {
            reason: "The stop grace ran out before the gateway answered",
          });
          return null;
        }
        return { claim: claimed, sentAt };
      } catch (error) {
        if (!(error instanceof WorkerGatewayRequestError)) throw error;
        // Two claims racing leave one holding the revoked token; before this
        // attempt has used a credential, claiming again returns a working one.
        if (error.code === "UNAUTHORIZED" && !retriedUnauthorized) {
          retriedUnauthorized = true;
          continue;
        }
        // The session was waiting, but on an operator rather than a worker:
        // its turns have no checkpoint this worker could restore (94S-288).
        // Nothing went wrong here, so the worker leaves as one with nothing
        // to claim does.
        if (error.code === "RECOVERY_REQUIRED") {
          this.logger.info("worker.claim.refused", { reason: error.message });
          return null;
        }
        // The session this launch was for was failed on the spot; there is
        // nothing to wait for and nothing for anyone to resolve.
        if (error.code === "CATALOG_MISMATCH") {
          this.logger.warn("worker.claim.catalog_mismatch", {
            reason: error.message,
          });
          return null;
        }
        if (!error.retryable) throw error;
        if (this.now().getTime() >= deadline) {
          // Nothing was waiting for this worker: KEDA-style launchers must see
          // it leave rather than sit on a slot (DESIGN §6.2).
          if (error.code === "NOT_FOUND") return null;
          throw error;
        }
        await this.sleep(CLAIM_RETRY_MS);
      }
    }
  }

  private async turnLoop(run: AgentRun): Promise<void> {
    let lastInputAt = this.now().getTime();
    while (this.stopping === undefined) {
      // Before asking for input, not after: a delivered input the engine is
      // never given would be left for recovery as if it might have run.
      if (!(await this.interruptSettled())) return;
      if (this.mirrorError !== undefined) {
        // The next turn would run on a transcript that can no longer be
        // checkpointed; the gateway blocks new turns once the heartbeat
        // records it, and this stops the one that could slip in before.
        this.stop({ kind: "drain", reason: this.mirrorError });
        return;
      }
      // Between turns, the one safe boundary a pause waits for.
      if (this.pauseControl !== undefined) {
        if ((await this.commitPause(this.pauseControl)) !== "withdrawn") {
          return;
        }
        // The pause was cancelled: the same engine carries on, and the time
        // spent held is not idleness.
        lastInputAt = this.now().getTime();
        continue;
      }
      // Not raced with a drain: an input the gateway hands over is this
      // attempt's to finish, and one dropped here stays open until the
      // reconciler decides it. The draining heartbeat `stop` sends makes the
      // gateway answer the poll empty, so waiting costs one poll interval.
      const next = await this.untilAbandoned(this.nextInput());
      if (next === undefined || next === null || this.ownerLost) return;
      // Pausing hands out no input; the idle clock must not end the attempt
      // before the pause is committed or refused.
      if (next.input === null && this.pauseControl !== undefined) continue;
      if (next.input === null) {
        // Nothing will come however long this waits: give the slot back now
        // rather than at the idle timeout.
        if (next.reason === "BUDGET_EXCEEDED") {
          this.stop({
            kind: "idle",
            reason: "The session has spent its cost budget (BUDGET_EXCEEDED)",
          });
          return;
        }
        const idleFor = this.now().getTime() - lastInputAt;
        if (idleFor >= this.options.timeouts.idleTimeoutMs) {
          this.stop({
            kind: "idle",
            reason: `No input for ${Math.round(idleFor / 1000)}s`,
          });
          return;
        }
        continue;
      }
      await this.runTurn(run, next.input);
      // Idle is counted from the end of the last turn, not its start: a turn
      // longer than the idle timeout must not end the worker on the next poll.
      lastInputAt = this.now().getTime();
    }
  }

  private requestPause(control: ControlIntent): void {
    if (this.stopping !== undefined) return;
    if (this.pauseControl === control.control_id) return;
    this.pauseControl = control.control_id;
    this.logger.info("worker.pause.requested", {
      control_id: control.control_id,
      turn_id: this.turn?.closed === false ? this.turn.turnId : null,
    });
  }

  /**
   * The turn is finished and finalized with its checkpoint; asking the
   * coordinator to commit the pause is the release itself. Everything the
   * attempt owes goes out first, since nothing it writes lands afterwards.
   * A refusal for want of a safe checkpoint keeps the lease and the engine:
   * the session stays pausing and shows why, and the release is asked again
   * every heartbeat interval until it commits or something else stops this
   * attempt (terminate fences it, SIGTERM drains it). Once the pause is no
   * longer the open one — a resume cancelled it (94S-138), or a newer pause
   * replaced it — the answer is REQUEST_STALE and the attempt goes back to
   * its input loop as if it had never been asked.
   */
  private async commitPause(
    controlId: string,
  ): Promise<"committed" | "withdrawn" | "ended"> {
    const flushed = await settledWithin(
      this.publisher?.idle() ?? Promise.resolve(),
      this.options.timeouts.requestTimeoutMs,
    );
    if (!flushed || this.ownerLost) return "ended";
    await this.pending?.flush(this.options.timeouts.requestTimeoutMs);
    // A mirror error latched while flushing is already draining; the
    // shutdown releases only once the gateway has recorded it, which a pause
    // release would skip. One that lands during the release request itself
    // may go unrecorded, and costs nothing: the turn's checkpoint pinned only
    // writes that had already settled, so the failed batch came after it,
    // and a resume starts from that checkpoint rather than this engine.
    if (this.mirrorError !== undefined) return "ended";
    let held = false;
    for (;;) {
      try {
        const response = await this.withRetry(() =>
          this.options.gateway.release({
            ...this.scope,
            turn_id: null,
            reason: "pause",
            pause_control_id: controlId,
          }),
        );
        this.released = response.released;
        if (!response.released) {
          // Only a superseded epoch answers so; the heartbeat says the same.
          this.lose("The pause release found the binding already superseded");
          return "ended";
        }
        this.logger.info("worker.pause.committed", { control_id: controlId });
        this.stop({
          kind: "paused",
          reason: "Paused; the execution is released",
        });
        return "committed";
      } catch (error) {
        if (this.ownerLost) return "ended";
        const code =
          error instanceof WorkerGatewayRequestError ? error.code : null;
        if (code === "REQUEST_STALE") {
          // A newer pause the poll has since delivered is kept.
          if (this.pauseControl === controlId) this.pauseControl = undefined;
          this.logger.info("worker.pause.withdrawn", {
            control_id: controlId,
          });
          return "withdrawn";
        }
        if (code !== "CHECKPOINT_UNAVAILABLE") throw error;
        if (!held) {
          held = true;
          this.logger.warn("worker.pause.blocked", {
            control_id: controlId,
            reason: describe(error),
          });
        }
        await this.untilStopped(
          this.sleep(this.options.timeouts.heartbeatIntervalMs),
        );
        if (this.stopping !== undefined) return "ended";
      }
    }
  }

  /**
   * The server may have handed a turn over on a poll whose answer was lost,
   * so retrying is bounded: past the budget the worker fails and releases,
   * and the gateway closes that turn as unknown once the execution is gone.
   * A poll that answers after the budget is not used — its turn is the same
   * one, already given up.
   */
  private async nextInput(): Promise<NextInputResponse | null> {
    let budget: ReturnType<WorkerHost["stageBudget"]> | undefined;
    let expire: () => void = () => {};
    const expired = new Promise<undefined>((resolve) => {
      expire = () => resolve(undefined);
    });
    const poll = () =>
      this.options.gateway
        .nextInput({
          ...this.scope,
          wait_ms: this.options.timeouts.nextInputWaitMs,
        })
        .catch((error: unknown) => {
          if (budget === undefined && isRetryable(error)) {
            budget = this.stageBudget(
              "Retrying nextInput",
              this.options.timeouts.nextInputRetryTimeoutMs,
            );
            budget.expired.then(expire);
          }
          throw error;
        });
    const polling = this.withRetry(
      poll,
      () => budget?.hasExpired() === true || this.stopping !== undefined,
    );
    polling.catch(() => {});
    try {
      const answer = await Promise.race([polling, expired]);
      if (answer === undefined || budget?.hasExpired() === true) return null;
      return answer;
    } catch (error) {
      // Once winding down, a failed poll only means there is nothing more to
      // run; losing the lease is still a loss.
      if (this.stopping !== undefined && !isOwnershipLost(error)) return null;
      throw error;
    } finally {
      budget?.disarm();
    }
  }

  private async runTurn(
    run: AgentRun,
    input: { input_id: string; message: string; turn_id: string },
  ): Promise<void> {
    // Delivered while the engine was already gone, or to an attempt whose
    // lease is gone: either way nothing may run it here, so it is left open
    // for the reconciler. A drain still runs it: that attempt owns it —
    // unless the mirror lost a batch, as when the gateway answered the poll
    // before the draining beat: no checkpoint could cover what it did.
    if (
      this.stopKind === "failed" ||
      this.stopKind === "lost" ||
      this.mirrorError !== undefined
    ) {
      return;
    }
    this.scope.turn_id = input.turn_id;
    // The same input must carry the same uuid on every delivery: that is what
    // lets the engine deduplicate a turn it already saw after a crash.
    const uuid = inputUuid(
      this.scope.session_id,
      input.turn_id,
      input.input_id,
    );
    const turn = this.beginTurn(input.turn_id, uuid);
    this.logger.info("worker.turn.started", {
      turn_id: input.turn_id,
      input_id: input.input_id,
    });
    // Watched from before the send: an interrupt that comes while the input
    // is still being checked is applied as soon as it goes out.
    this.pending?.watch(true);
    // Armed before the delivery check, so a check that hangs spends the same
    // budget as an engine that does.
    this.armDeadline(run, turn);
    try {
      await this.deliver(run, turn, input.message);
      // The engine's terminal ends the turn; the deadline ends one it never
      // answers, which heartbeats alone would otherwise keep leased forever.
      const settlement = await Promise.race([
        turn.settled,
        this.abandoned.then(() => undefined),
      ]);
      try {
        // Owner loss forbids every further durable write, including this one.
        if (settlement === undefined || this.ownerLost) return;
        if (settlement.status === "outcome_unknown") {
          // The session is recovery's to decide now (the gateway holds the
          // input back as recovery_required); stopping first also bounds
          // the finalize below by the drain budget.
          this.stop({
            kind: "drain",
            reason: `Turn ${input.turn_id} needs a recovery decision`,
          });
        }
        await this.finalizeTurn(run, input.turn_id, settlement);
      } finally {
        // Whatever the engine said after the terminal goes out now, as session
        // events, whether or not the turn made it to a finalize.
        this.publisher?.release();
      }
    } finally {
      clearTurnTimers(turn);
    }
  }

  /**
   * Sends the input unless the engine session already holds its uuid. Such a
   * send is deduplicated and never answered (94S-242); regenerating the uuid
   * would make it a new turn and redo whatever the first delivery did. The
   * transcript the run resumed from is what says so, and when it holds the
   * input its outcome is unknown: it was recorded, not proven finished.
   */
  private async deliver(run: AgentRun, turn: Turn, message: string) {
    const check = run.holdsInput(turn.uuid).catch((error: unknown) => {
      // Past the deadline the timeout owns the terminal; a check failing
      // now must not unwind the turn before it is finalized.
      if (turn.timedOut) return undefined;
      throw error;
    });
    // Raced with the turn too: the deadline has to end a check that hangs.
    const held = await Promise.race([
      this.untilAbandoned(check),
      turn.settled.then(() => undefined),
    ]);
    // The check awaited: the deadline, the lease or the engine may be gone.
    // Past the deadline nothing is sent, even with the terminal still to
    // come: the interrupt has already been asked for and would miss it.
    if (held === undefined || turn.closed || turn.timedOut) return;
    if (this.stopKind === "failed" || this.stopKind === "lost") return;
    if (held) {
      this.logger.warn("worker.turn.already_consumed", {
        turn_id: turn.turnId,
      });
      this.settleTurn({
        status: "outcome_unknown",
        reason: "input_already_consumed",
        result: null,
        usage: null,
        synthetic: true,
      });
      return;
    }
    run.send({ message, uuid: turn.uuid });
    turn.sent = true;
    // An interrupt taken while the check ran reaches the engine now.
    if (turn.interrupting) this.sendInterrupt(run, turn);
  }

  /**
   * On expiry the turn is interrupted, and the worker winds down whatever
   * happens next: an engine that overran its budget is not handed another
   * input, and a late interrupt must not land on one. An engine that answers
   * within the grace ends the turn `failed`; one that does not leaves it
   * `outcome_unknown` for recovery, because the interrupt proves nothing
   * about what the engine did.
   */
  private armDeadline(run: AgentRun, turn: Turn): void {
    const budget = this.options.timeouts.maxTurnMs;
    const expire = () => {
      // An interrupt already has its own, shorter grace; the deadline taking
      // over would turn its `interrupted` into a timeout failure.
      if (turn.closed || turn.interrupting || this.ownerLost) return;
      turn.timedOut = true;
      const reason = `Turn ${turn.turnId} ran past its ${budget / 1000}s budget`;
      this.logger.warn("worker.turn.timeout", {
        turn_id: turn.turnId,
        max_turn_ms: budget,
      });
      this.stop({ kind: "drain", reason });
      this.pending?.cancelAll("The turn ran out of time");
      run.interrupt().catch((error) => {
        this.logger.warn("worker.interrupt.failed", {
          reason: describe(error),
        });
      });
      // Never more than half of what is left of the drain, which may have
      // begun well before the deadline: were the drain to give the turn up
      // first, it would end with no terminal at all.
      const left =
        (this.abandonsAt ?? Number.POSITIVE_INFINITY) - performance.now();
      const grace = Math.min(INTERRUPT_GRACE_MS, left / 2);
      const unanswered = `${reason}, and the engine did not answer the interrupt`;
      if (grace <= 0) {
        this.closeUnanswered(turn, unanswered);
        return;
      }
      turn.timers.push(
        setTimeout(() => this.closeUnanswered(turn, unanswered), grace),
      );
    };
    turn.timers.push(setTimeout(expire, budget));
  }

  /** A timed-out turn the engine gave no terminal for: unknown, and the engine is not trusted again. */
  private closeUnanswered(turn: Turn, reason: string): void {
    if (turn.closed) return;
    this.fail(reason);
    this.settleTurn({
      status: "outcome_unknown",
      reason: "turn_timeout",
      result: null,
      usage: null,
      synthetic: true,
    });
  }

  private async finalizeTurn(
    run: AgentRun,
    turnId: string,
    settlement: Settlement,
  ): Promise<void> {
    // The event tail has to be durable before the turn is declared over: a
    // finalize that overtakes its own events publishes a closed turn whose
    // stream is still arriving. Both waits end with the drain budget, so a
    // gateway that keeps failing cannot hold the process past it.
    const flushed = await this.untilAbandoned(
      (this.publisher?.idle() ?? Promise.resolve()).then(() => true),
    );
    if (flushed === undefined || this.ownerLost) return;
    // Where settleTurn cut the stream; idle() has made all of it durable.
    const finalSourceSequence = this.publisher?.hold() ?? 0;
    const interrupted = settlement.status === "interrupted";
    let captured: Captured | undefined;
    // What may still commit this turn's checkpoint. The lease is released
    // only once it has answered: untilAbandoned stops waiting for a request,
    // it does not stop the request, and a pointer CAS that lands after
    // writers were let back in would commit a capture they have changed.
    let outstanding: Promise<unknown> | undefined;
    // Set once any finalize attempt fails without an answer that decides it
    // (no answer, a 5xx): that request may still commit, whatever a later
    // retry is told, until one succeeds and the idempotent key settles both.
    let undecided = false;
    try {
      let checkpoint: CheckpointRef | null = null;
      if (settlement.synthetic !== true) {
        const capturing = this.capture(run);
        outstanding = capturing;
        // The heartbeat keeps the lease while a capture runs, so one that
        // never returns needs a bound of its own. It moves the workspace out
        // as the startup moved it in, and gets the same budget; a knob of its
        // own waits until the two need different bounds.
        const budget = interrupted
          ? undefined
          : this.stageBudget(
              "Checkpointing the turn",
              this.options.timeouts.startupTimeoutMs,
            );
        try {
          captured = await this.untilAbandoned(
            // Someone is waiting on an interrupt's receipt: a capture that
            // fails or hangs gives it an unknown outcome (below) instead of
            // none. Any other turn fails the worker, and its budget above
            // starts the drain that ends the wait.
            interrupted
              ? this.withinInterruptGrace(
                  capturing,
                  turnId,
                  this.turn?.interruptDeadline,
                )
              : capturing,
          );
        } finally {
          budget?.disarm();
        }
        if (captured === undefined) {
          capturing.then(
            ({ lease }) => lease?.release(),
            () => {},
          );
          return;
        }
        checkpoint = captured.ref;
      }
      if (this.ownerLost) return;
      // api.md: a turn is `interrupted` only when the engine's terminal comes
      // with a checkpoint consistent with it; without one nobody can say what
      // the transcript holds, and the turn goes to recovery instead.
      const unconfirmed: Settlement = {
        ...settlement,
        status: "outcome_unknown",
        reason: "interrupt_checkpoint_unavailable",
      };
      // The session goes to recovery with it, as runTurn arranges for an
      // unknown the engine reported itself.
      const unconfirm = (): Settlement => {
        this.stop({
          kind: "drain",
          reason: `Turn ${turnId} needs a recovery decision`,
        });
        return unconfirmed;
      };
      let terminal: Settlement =
        interrupted && checkpoint === null ? unconfirm() : settlement;
      const finalize = (outcome: Settlement, ref: CheckpointRef | null) => {
        const finalizing = this.withRetry(
          () =>
            this.options.gateway
              .finalize({
                ...this.scope,
                turn_id: turnId,
                finalize_key: `${this.scope.attempt_id}:${turnId}`,
                final_source_sequence: finalSourceSequence,
                terminal: {
                  status: outcome.status,
                  reason: outcome.reason,
                  result: outcome.result ?? null,
                  usage: outcome.usage ?? null,
                  cost_usd:
                    outcome.costUsd === undefined
                      ? null
                      : Math.min(outcome.costUsd, MAX_TURN_COST_USD),
                },
                checkpoint: ref,
              })
              .catch((error: unknown) => {
                // Only a request carrying the checkpoint can commit it.
                if (ref !== null && isRetryable(error)) undecided = true;
                throw error;
              }),
          () => this.abandonedNow,
        );
        outstanding = finalizing;
        return this.untilAbandoned(finalizing);
      };
      let finalized: Awaited<ReturnType<typeof finalize>>;
      try {
        finalized = await finalize(
          terminal,
          terminal === settlement ? checkpoint : null,
        );
      } catch (error) {
        // The gateway refused the manifest itself (only verification answers
        // CHECKPOINT_UNAVAILABLE to a finalize that carries one), so that
        // request committed nothing and the same key may carry another body.
        if (
          terminal !== settlement ||
          checkpoint === null ||
          !(error instanceof WorkerGatewayRequestError) ||
          error.code !== "CHECKPOINT_UNAVAILABLE"
        ) {
          throw error;
        }
        // Any other turn is recorded without the checkpoint, as it would have
        // been had the publish failed here — but only when no earlier attempt
        // is still out that might commit it under the first body.
        if (undecided) throw error;
        this.logger.warn("worker.checkpoint.failed", {
          stage: "finalize",
          reason: describe(error),
          revision: checkpoint.revision,
          manifest_ref: checkpoint.manifest_ref,
          turn_id: turnId,
        });
        // Nothing can commit the capture any more; the fallback carries no
        // checkpoint to wait on.
        captured?.lease?.release();
        await this.checkpoints.finalizeRefused?.(describe(error), {
          ...this.scope,
        });
        // An interrupted turn is `interrupted` only with its checkpoint.
        terminal = interrupted ? unconfirm() : settlement;
        finalized = await finalize(terminal, null);
      }
      if (finalized === undefined) return;
      outstanding = undefined;
      this.turns.push({
        turnId,
        status: terminal.status,
        reason: terminal.reason,
      });
      this.logger.info("worker.turn.finalized", {
        turn_id: turnId,
        status: terminal.status,
      });
      this.turn = undefined;
      this.scope.turn_id = null;
    } finally {
      const lease = captured?.lease;
      if (lease != null) {
        if (outstanding === undefined) lease.release();
        else
          outstanding.then(
            () => lease.release(),
            // Only a refusal of a request that was the only one out decides
            // the CAS; otherwise the run ends with the lease still held
            // rather than let a writer in ahead of a commit that may yet land.
            () => {
              if (!undecided) lease.release();
            },
          );
      }
    }
  }
  private beginTurn(turnId: string, uuid: string): Turn {
    let settle: (settlement: Settlement | Promise<Settlement>) => void =
      () => {};
    const settled = new Promise<Settlement>((resolve) => {
      settle = resolve;
    });
    const turn: Turn = {
      closed: false,
      interrupting: false,
      sent: false,
      settled,
      settle,
      timedOut: false,
      timers: [],
      turnId,
      uuid,
    };
    this.turn = turn;
    return turn;
  }

  /** A pending settlement still cuts the stream now, at the terminal frame. */
  private settleTurn(settlement: Settlement | Promise<Settlement>): void {
    const turn = this.turn;
    if (turn === undefined) return;
    // The stream is cut here, at the terminal frame, and not wherever it has
    // reached by the time finalize is sent: the engine keeps emitting after
    // its result, and the gateway closes the turn only at the exact end.
    turn.closed = true;
    clearTurnTimers(turn);
    // Nothing can interrupt a turn that has ended; the next one watches anew.
    this.pending?.watch(false);
    this.publisher?.hold();
    turn.settle(settlement);
  }

  /**
   * An interrupt reaches only the turn it names, and only while it runs: one
   * that arrives after its turn ended — the next may already be running — is
   * ignored here, and the gateway settles its receipt from how that turn
   * actually ended. The engine keeps its session; only this turn stops.
   */
  private onControl(control: ControlIntent): void {
    if (control.kind === "pause") {
      this.requestPause(control);
      return;
    }
    const turn = this.turn;
    const run = this.engine;
    if (control.kind !== "interrupt") return;
    if (turn === undefined || run === undefined || this.stopKind === "lost") {
      return;
    }
    // A timed-out turn is already being interrupted, on its own terms.
    if (
      turn.closed ||
      turn.interrupting ||
      turn.timedOut ||
      turn.turnId !== control.target_turn_id
    ) {
      return;
    }
    turn.interrupting = true;
    this.logger.info("worker.turn.interrupting", {
      turn_id: turn.turnId,
      control_id: control.control_id,
    });
    this.publisher?.publish(
      [
        {
          id: `control:${control.control_id}`,
          event: "status",
          data: { phase: "interrupting" },
        },
      ],
      turn.turnId,
    );
    // What the turn was waiting on is void: an answer landing now must not
    // let the engine carry the interrupted turn on.
    this.pending?.cancelAll("The turn was interrupted");
    // The grace runs from here, not from the send: an input check that
    // hangs must not hold the interrupt open until the turn budget ends.
    const graceMs = this.interruptGraceMs();
    turn.interruptDeadline = performance.now() + graceMs;
    turn.timers.push(
      setTimeout(() => {
        if (turn.closed) return;
        // An engine that ignores an interrupt is not handed the next input.
        this.fail(
          `Turn ${turn.turnId} gave no terminal within ${graceMs}ms of its interrupt`,
        );
        this.settleTurn({
          status: "outcome_unknown",
          reason: "interrupt_unanswered",
          result: null,
          usage: null,
          synthetic: true,
        });
      }, graceMs),
    );
    if (turn.sent) this.sendInterrupt(run, turn);
  }

  private sendInterrupt(run: AgentRun, turn: Turn): void {
    turn.interruptReceipt = "pending";
    const answered = run.interrupt().then(
      () => {
        turn.interruptReceipt = "acknowledged";
      },
      (error) => {
        turn.interruptReceipt = "refused";
        this.logger.warn("worker.interrupt.failed", {
          reason: describe(error),
        });
      },
    );
    turn.interruptAnswered = answered;
    this.interruptAnswered = answered;
  }

  /**
   * An aborted terminal that overtook its interrupt's receipt. The SDK writes
   * a clean interrupt's receipt first; a turn that crashed while handling it
   * may report first, so the receipt, awaited within what is left of the
   * grace, decides. None by then is an interrupt the engine never answered.
   */
  private onceAnswered(
    turn: Turn,
    decide: (acknowledged: boolean) => Settlement,
  ): Promise<Settlement> {
    const leftMs = Math.max(
      0,
      (turn.interruptDeadline ?? performance.now()) - performance.now(),
    );
    return settledWithin(
      turn.interruptAnswered ?? Promise.resolve(),
      leftMs,
    ).then((answered) => {
      if (answered) return decide(turn.interruptReceipt === "acknowledged");
      this.fail(
        `Turn ${turn.turnId} ended before its interrupt was answered, and no answer came`,
      );
      return {
        ...decide(false),
        status: "outcome_unknown",
        reason: "interrupt_unanswered",
        synthetic: true,
      };
    });
  }

  /**
   * A capture for an interrupted turn, bounded by what is left of the
   * interrupt's grace. One that fails or runs late counts as no checkpoint;
   * a lease it takes after that is let go as soon as it arrives, since
   * nothing will commit what it guards.
   */
  private withinInterruptGrace(
    capturing: Promise<Captured>,
    turnId: string,
    deadline: number | undefined,
  ): Promise<Captured> {
    const none: Captured = { lease: null, ref: null };
    const tolerant = capturing.catch((error: unknown): Captured => {
      this.logger.warn("worker.checkpoint.failed", {
        turn_id: turnId,
        reason: describe(error),
      });
      return none;
    });
    // An engine interrupted on its own (no intent taken) gets a grace of its own.
    const leftMs = Math.max(
      0,
      (deadline ?? performance.now() + this.interruptGraceMs()) -
        performance.now(),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Captured>((resolve) => {
      timer = setTimeout(() => {
        this.logger.warn("worker.checkpoint.late", {
          turn_id: turnId,
          left_ms: Math.round(leftMs),
        });
        tolerant.then(({ lease }) => lease?.release());
        resolve(none);
      }, leftMs);
    });
    return Promise.race([tolerant, late]).finally(() => clearTimeout(timer));
  }

  private interruptGraceMs(): number {
    return this.options.timeouts.interruptGraceMs ?? INTERRUPT_GRACE_MS;
  }

  /**
   * Waits, bounded by the interrupt grace, for the engine to have answered
   * the last interrupt. False when it never did: that engine is not handed
   * another input, and the worker winds down.
   */
  private async interruptSettled(): Promise<boolean> {
    const answered = this.interruptAnswered;
    if (answered === undefined) return true;
    const graceMs = this.interruptGraceMs();
    if (await settledWithin(answered, graceMs)) {
      if (this.interruptAnswered === answered)
        this.interruptAnswered = undefined;
      return true;
    }
    this.fail(
      `The engine did not acknowledge an interrupt within ${graceMs}ms`,
    );
    return false;
  }

  private pump(run: AgentRun): Promise<void> {
    return (async () => {
      try {
        for await (const frame of run.events()) {
          this.publisher?.publish(
            frame.events,
            this.turn?.closed === true ? null : this.scope.turn_id,
          );
          this.observe(frame.envelope.message);
        }
      } catch (error) {
        this.logger.warn("worker.stream.ended", { reason: describe(error) });
      } finally {
        const turn = this.turn;
        if (turn?.timedOut === true) {
          // The interrupt ended the stream rather than the turn: still the
          // timeout's outcome, and the drain it began becomes a failure.
          this.closeUnanswered(
            turn,
            "The engine stream ended after the turn ran out of time",
          );
        }
        // A stream that ended without a terminal leaves the turn's outcome
        // genuinely unknown; guessing either way would be a lie about the
        // transcript.
        this.settleTurn({
          status: "outcome_unknown",
          reason: "The engine stream ended before the turn settled",
          result: null,
          usage: null,
          synthetic: true,
        });
        // An engine that is gone accepts inputs it will never answer, so the
        // loop must not hand it another one. A no-op when shutdown closed it.
        this.stop({ kind: "failed", reason: "The engine stream ended" });
      }
    })();
  }

  /** Absent while the port binds no mirror, so such a worker beats unchanged. */
  private transcriptReport(): TranscriptReport | undefined {
    const mirror = this.checkpoints.mirror?.();
    if (mirror === undefined) return undefined;
    return {
      persisted_at: mirror.persistedAt?.toISOString() ?? null,
      mirror_error: this.mirrorError ?? null,
    };
  }

  private observe(native: NativeSdkMessage): void {
    this.accounting.observe(native);
    if (this.accounting.restarted) {
      // `/clear` starts the engine's count over, and the budget the claim
      // gave it with it: left running, the next turn could spend the whole
      // remainder again. The turn in flight is finalized; the next one waits
      // for a claim that brings what is really left.
      this.stop({
        kind: "drain",
        reason:
          "The engine started its cost count over, so its budget no longer bounds the session's",
      });
    }
    if (native.type === "system" && native.subtype === "mirror_error") {
      // Latched for the run like the ledger's own: the SDK has given up on a
      // batch, and no later write brings it back.
      if (this.mirrorError === undefined) {
        this.mirrorError = `Transcript mirror dropped a batch: ${
          typeof native.error === "string" && native.error.length > 0
            ? native.error
            : "unspecified error"
        }`;
        // Recorded now rather than at the next interval: until the gateway
        // holds it, a checkpoint-less completion is still accepted.
        this.heartbeat?.beatNow();
        // Draining from here, not from the next loop boundary: the beat
        // carries it, so a poll already waiting is answered empty rather than
        // handed a turn that could not be checkpointed. A turn in flight still
        // finishes and is finalized.
        this.stop({ kind: "drain", reason: this.mirrorError });
      }
    }
    if (native.type !== "result") return;
    const turn = this.turn;
    if (turn === undefined) return;
    const attributed = attributedUuids(native);
    // A result that names other inputs belongs to a batch this turn is not
    // part of; one that names nothing settles nothing on its own.
    if (attributed.length > 0 && !attributed.includes(turn.uuid)) return;
    if (turn.timedOut && attributed.length === 0) {
      // As unproven as no answer at all, and the engine as untrusted.
      this.fail(
        `Turn ${turn.turnId} ran out of time, and the engine answered for no input`,
      );
    }
    // A turn already closed takes nothing: its settlement is a no-op, and the
    // cost stays for the turn that can still carry it.
    const { costUsd, providerFailure } = turn.closed
      ? { costUsd: undefined, providerFailure: undefined }
      : this.accounting.settle();
    const cost = costUsd === undefined ? {} : { costUsd };
    if (
      attributed.includes(turn.uuid) &&
      !turn.closed &&
      !turn.timedOut &&
      turn.interruptReceipt === "pending" &&
      endedByAbort(native)
    ) {
      this.settleTurn(
        this.onceAnswered(turn, (acknowledged) => ({
          ...terminalOf(native, providerFailure, acknowledged),
          ...cost,
        })),
      );
      return;
    }
    this.settleTurn({
      ...(attributed.includes(turn.uuid)
        ? turn.timedOut
          ? // Whatever the engine says it ended with, the budget ended it.
            {
              ...terminalOf(native, providerFailure, false),
              status: "failed",
              reason: "turn_timeout",
            }
          : terminalOf(
              native,
              providerFailure,
              turn.interruptReceipt === "acknowledged",
            )
        : {
            status: "outcome_unknown",
            reason: turn.timedOut
              ? "turn_timeout"
              : "The engine reported a result it attributed to no input",
            result: resultPayload(native, providerFailure),
            usage: native.usage ?? null,
          }),
      ...cost,
    });
  }

  private async onPermission(
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    if (this.stopping !== undefined || this.pending === undefined) {
      return {
        behavior: "deny",
        message: "This worker is winding down and cannot ask for approval",
      };
    }
    // The interrupt voided the turn's callbacks; one raised after it is no
    // different, and asking would only hold the turn open again.
    if (this.turn?.interrupting === true || this.turn?.closed === true) {
      return { behavior: "deny", message: "The turn was interrupted" };
    }
    return this.pending.request(request);
  }

  /**
   * Takes the checkpoint lease with the verdict (DESIGN §6.3.1), so nothing
   * writes between the quiescence check and the pointer CAS. A capture that
   * fails or produces nothing to commit gives the lease back at once.
   */
  private async capture(run: AgentRun): Promise<Captured> {
    const { lease, preparation } = await run.leaseCheckpoint();
    if (preparation.status === "rejected") {
      this.logger.warn("worker.checkpoint.rejected", {
        reason: preparation.reason,
        detail: preparation.detail,
      });
    }
    let ref: CheckpointRef | null;
    try {
      ref = await this.checkpoints.capture(preparation, {
        scope: { ...this.scope },
        recheck: () => run.prepareCheckpoint(),
      });
    } catch (error) {
      lease?.release();
      throw error;
    }
    if (ref === null) lease?.release();
    return { lease, ref };
  }

  /**
   * Every decision below reads the current stop rather than the one this
   * began with: a heartbeat, a poll or an event write can each learn the
   * lease is gone while shutdown waits on something else.
   */
  private async shutdown(run: AgentRun | undefined): Promise<void> {
    this.pending?.cancelAll(
      this.ownerLost
        ? "This worker no longer owns the session"
        : "This worker is shutting down",
    );
    if (run !== undefined && this.turn !== undefined) {
      // Whatever is still open here has already used up its drain budget, or
      // belongs to a lease this attempt no longer holds.
      const settledInTime =
        !this.ownerLost && (await settledWithin(this.turn.settled, 0));
      if (!settledInTime) {
        // Not awaited: a wedged engine may never answer the interrupt, and
        // the terminal frame, bounded below, is what this is waiting for.
        run.interrupt().catch((error) => {
          this.logger.warn("worker.interrupt.failed", {
            reason: describe(error),
          });
        });
        await settledWithin(
          this.turn.settled,
          this.shutdownWait(INTERRUPT_GRACE_MS),
        );
      }
    }
    // No checkpoint is taken here. One only becomes durable riding a turn's
    // finalize, and a turn given up on the way out is not finalized; an idle
    // worker leaves the last committed checkpoint as the one to resume from.
    // A session-level checkpoint commit would change that, and alpha has none.
    run?.close();
    // Bounded for the same reason: a wedged engine may never end its stream,
    // and the exit check below is what deals with that.
    if (this.pumping !== undefined) {
      await settledWithin(
        this.pumping,
        this.shutdownWait(ENGINE_EXIT_GRACE_MS),
      );
    }
    await this.confirmEngineExit();
    // A restore still replacing the workspace should not outlive the
    // release: the next attempt restores into the same root. The abort
    // reaches it at its next step, and the port starts no file work after
    // it, so this waits out only a step already under way. One still out
    // past that is waiting on the network, not writing; the process exits
    // right after the release, which ends it either way.
    if (
      this.restoring !== undefined &&
      !(await settledWithin(
        this.restoring,
        this.withinGrace(this.options.timeouts.requestTimeoutMs),
      ))
    ) {
      this.logger.warn("worker.restore.unsettled", {
        reason: "the restore had not stopped by the release",
      });
    }
    if (this.heartbeat !== undefined) {
      await settledWithin(
        this.heartbeat.stop(),
        this.withinGrace(this.options.timeouts.requestTimeoutMs),
      );
    }
    // No durable write survives owner loss: not the event tail, not the
    // in-flight turn, not the release.
    if (this.reportedOwnerLost()) return;
    if (!(await this.mirrorErrorRecorded())) return;
    const flushed = await this.untilAbandoned(
      (this.publisher?.idle() ?? Promise.resolve()).then(
        () => true,
        (error) => {
          this.logger.warn("worker.events.undelivered", {
            reason: describe(error),
          });
          return false;
        },
      ),
    );
    if (flushed === undefined) {
      this.publisher?.abandon("The drain budget ran out");
      this.logger.warn("worker.events.undelivered", {
        reason: "The drain budget ran out",
      });
    }
    if (this.reportedOwnerLost()) return;
    // How each request ended decides its answer's receipt; once released,
    // the gateway can only call the undelivered ones unknown.
    await this.pending?.flush(
      this.withinGrace(this.options.timeouts.requestTimeoutMs),
    );
    // What did not land by now never will; nothing may keep retrying past
    // the release.
    this.pending?.stop();
    if (this.reportedOwnerLost()) return;
    // The pause commit was the release.
    if (this.released) return;
    this.released = true;
    const releasing = this.options.gateway
      .release({
        ...this.scope,
        turn_id: null,
        // The session shows it when a restore keeps failing (94S-345).
        reason:
          this.scrubber?.scrub(this.stopping?.reason ?? "loop ended") ??
          "loop ended",
        // A startup a signal cut short is not a failed one (94S-302).
        ...(this.stopping?.kind === "drain" && this.stopping.requested
          ? { stop_kind: "drain" as const }
          : {}),
      })
      .then((response) =>
        this.logger.info("worker.released", { released: response.released }),
      )
      .catch((error) =>
        this.logger.warn("worker.release.failed", { reason: describe(error) }),
      );
    // The release keeps its reserve; past the grace the SIGKILL ends it anyway.
    const releaseBudget = this.withinGrace(
      this.options.timeouts.requestTimeoutMs,
      0,
    );
    if (!(await settledWithin(releasing, releaseBudget))) {
      this.logger.warn("worker.release.failed", {
        reason: "The stop grace ran out before the gateway answered",
      });
    }
  }

  /**
   * A latched `mirror_error` is recorded before the session is handed back:
   * released without it, the next attempt resumes a checkpoint the gateway
   * still trusts, missing the batch that was lost. One more beat is tried;
   * failing that the lease is left to lapse rather than released as if this
   * attempt had left the session in order.
   */
  private async mirrorErrorRecorded(): Promise<boolean> {
    const heartbeat = this.heartbeat;
    if (this.mirrorError === undefined || heartbeat === undefined) return true;
    if (!heartbeat.mirrorErrorRecorded) {
      await settledWithin(
        heartbeat.beatOnce(),
        this.withinGrace(this.options.timeouts.requestTimeoutMs),
      );
    }
    if (heartbeat.mirrorErrorRecorded) return true;
    this.logger.error("worker.mirror_error.unrecorded", {
      reason: this.mirrorError,
    });
    return false;
  }

  private reportedOwnerLost(): boolean {
    if (this.stopping?.kind !== "lost") return false;
    this.logger.warn("worker.ownership.lost", { reason: this.stopping.reason });
    return true;
  }

  /**
   * The stream ending says the engine stopped talking, not that its process
   * is gone. Only the observed exit says that, so a straggler past the grace
   * period is killed rather than left running behind this process.
   */
  private async confirmEngineExit(): Promise<void> {
    const engines = this.options.engines;
    if (engines === undefined) return;
    if (await engines.exited(this.shutdownWait(ENGINE_EXIT_GRACE_MS))) {
      this.logger.info("worker.engine.exited", {});
      return;
    }
    const lingering = engines.running;
    this.logger.error("worker.engine.lingering", { pids: lingering });
    engines.kill();
    const killed = await engines.exited(this.withinGrace(ENGINE_EXIT_GRACE_MS));
    this.logger[killed ? "warn" : "error"]("worker.engine.killed", {
      pids: lingering,
      exited: killed,
    });
  }

  /**
   * How long the engine gets to wind down by itself. None once the lease is
   * gone: another attempt may already own the workspace, and whatever the
   * engine does meanwhile is unfenced, so it is killed rather than waited on.
   */
  private shutdownWait(ms: number): number {
    return this.ownerLost ? 0 : this.withinGrace(ms);
  }

  /**
   * A shutdown wait, cut to what the launcher's stop grace still allows so
   * the release at the end is not the part the SIGKILL takes away.
   */
  private withinGrace(ms: number, reserve = RELEASE_RESERVE_MS): number {
    const grace = this.options.timeouts.stopGraceMs;
    if (grace === undefined || this.stoppedAt === undefined) return ms;
    const left = this.stoppedAt + grace - reserve - this.now().getTime();
    return Math.max(0, Math.min(ms, left));
  }

  /**
   * Resolves with the value, or undefined once a stop has come and the
   * request still has not answered within what the grace leaves for it.
   * Waiting on a stop at all is deliberate: a claim that lands is one this
   * worker can still release, rather than one left to lapse.
   */
  private async untilStopGraceSpent<T>(
    work: Promise<T>,
  ): Promise<T | undefined> {
    work.catch(() => {});
    const cut = this.stopped.then(async () => {
      await settledWithin(
        work,
        this.withinGrace(this.options.timeouts.requestTimeoutMs),
      );
      return undefined;
    });
    return Promise.race([work, cut]);
  }

  /** Resolves with the value, or undefined once any stop has come. */
  private async untilStopped<T>(work: Promise<T>): Promise<T | undefined> {
    work.catch(() => {});
    return Promise.race([work, this.stopped.then(() => undefined)]);
  }

  /**
   * A budget for a stage the turn deadline does not cover. The heartbeat
   * extends the lease on its own clock whatever the stage is doing, so one
   * that never ends would hold the session forever (94S-269). Expiry fails
   * the worker, unless a stop is already under way: a drain keeps its outcome.
   */
  private stageBudget(stage: string, ms: number) {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        this.logger.error("worker.stage.timeout", { stage, budget_ms: ms });
        this.stop({
          kind: "failed",
          reason: `${stage} ran past its ${ms / 1000}s budget`,
        });
        resolve();
      }, ms);
    });
    return {
      disarm: () => clearTimeout(timer),
      expired,
      hasExpired: () => timedOut,
    };
  }

  /** Resolves with the value, or undefined once the turn has to be given up. */
  private async untilAbandoned<T>(work: Promise<T>): Promise<T | undefined> {
    work.catch(() => {});
    return Promise.race([work, this.abandoned.then(() => undefined)]);
  }

  /**
   * Retries a transient failure until `giveUp` says the result is no longer
   * wanted: by default any stop, but a finalize keeps trying for as long as
   * the drain budget lasts.
   */
  private async withRetry<T>(
    call: () => Promise<T>,
    giveUp: () => boolean = () => this.stopping !== undefined,
  ): Promise<T> {
    for (;;) {
      try {
        return await call();
      } catch (error) {
        if (isOwnershipLost(error)) {
          this.lose(describe(error));
          throw error;
        }
        if (!isRetryable(error) || giveUp()) throw error;
        this.logger.warn("worker.gateway.retry", { reason: describe(error) });
        await this.sleep(GATEWAY_RETRY_MS);
        // What gave up during the backoff sends nothing more.
        if (giveUp()) throw error;
      }
    }
  }
}

type Captured = { lease: CheckpointLease | null; ref: CheckpointRef | null };

/**
 * A stable UUID for one delivered input. Derived rather than random so the
 * same queue row always reaches the engine under the same identity.
 */
export function inputUuid(
  sessionId: string,
  turnId: string,
  inputId: string,
): string {
  const digest = createHash("sha256")
    .update(`${sessionId}:${turnId}:${inputId}`)
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  // Shaped like a name-based UUID so anything that validates the field accepts
  // it; the namespace is this function, not RFC 4122's.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The inputs a result says it consumed, the way TurnLedger reads them. */
function attributedUuids(native: NativeSdkMessage): string[] {
  const listed = Array.isArray(native.user_message_uuids)
    ? native.user_message_uuids.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const last =
    typeof native.user_message_uuid === "string"
      ? [native.user_message_uuid]
      : [];
  return [...new Set([...listed, ...last])];
}

/**
 * `interruptAcknowledged` is the worker's own fact that the engine took its
 * interrupt for this turn. An aborted terminal without it is some other
 * abort, and a turn that finished before the interrupt landed keeps the
 * outcome it reached.
 */
function terminalOf(
  native: NativeSdkMessage,
  providerFailure: ProviderFailure | undefined,
  interruptAcknowledged: boolean,
): Settlement {
  const subtype =
    typeof native.subtype === "string" ? native.subtype : "unknown";
  const interrupted = interruptAcknowledged && endedByAbort(native);
  const failed = native.is_error === true || subtype !== "success";
  const status: WorkerTerminalStatus = interrupted
    ? "interrupted"
    : failed
      ? "failed"
      : "completed";
  return {
    status,
    reason: status === "completed" ? null : failureReason(native, subtype),
    result: resultPayload(native, providerFailure),
    usage: native.usage ?? null,
  };
}

/**
 * A request the provider kept refusing ends as `success` with `is_error`, so
 * the subtype says nothing there and the engine's terminal reason
 * (`api_error`, …) is the cause.
 */
function failureReason(native: NativeSdkMessage, subtype: string): string {
  // The engine's budget is the session's remaining one, so this is the same
  // limit the gateway enforces between turns, reached inside one.
  if (subtype === "error_max_budget_usd") return TURN_BUDGET_EXCEEDED_REASON;
  if (subtype !== "success") return subtype;
  return typeof native.terminal_reason === "string" &&
    native.terminal_reason.length > 0
    ? native.terminal_reason
    : "error";
}

function resultPayload(
  native: NativeSdkMessage,
  providerFailure: ProviderFailure | undefined,
): unknown {
  return {
    subtype: native.subtype ?? null,
    is_error: native.is_error ?? null,
    stop_reason: native.stop_reason ?? null,
    terminal_reason: native.terminal_reason ?? null,
    ...(native.terminal_reason === "api_error"
      ? {
          api_error_status:
            typeof native.api_error_status === "number"
              ? native.api_error_status
              : null,
          provider_error: providerFailure?.error ?? null,
          last_retry_status: providerFailure?.status ?? null,
        }
      : {}),
  };
}

function clearTurnTimers(turn: Turn): void {
  for (const timer of turn.timers.splice(0)) clearTimeout(timer);
}

async function settledWithin(
  settled: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([settled.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const consoleLogger: WorkerLogger = {
  info: (event, fields) => log("info", event, fields),
  warn: (event, fields) => log("warn", event, fields),
  error: (event, fields) => log("error", event, fields),
};

function log(
  level: string,
  event: string,
  fields: Record<string, unknown> | undefined,
): void {
  console.log(JSON.stringify({ level, event, ...fields }));
}
