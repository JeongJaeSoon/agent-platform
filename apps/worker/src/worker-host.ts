import { createHash } from "node:crypto";
import type {
  AttemptState,
  BootstrapClaimResponse,
  CheckpointRef,
  NextInputResponse,
  RuntimeConfig,
  SessionRuntime,
  TerminalTurnStatus,
  WorkerScope,
} from "@agent-platform/contracts";
import type {
  AgentRun,
  NativeSdkMessage,
  PermissionDecision,
  PermissionRequest,
  RuntimeHooks,
  WorkerGatewayClient,
} from "@agent-platform/runtime-core";

import type { RuntimeResumePlan, WorkerCheckpointPort } from "./checkpoint.ts";
import type { WorkerTimeouts } from "./config.ts";
import type { EngineExitWatch } from "./engine-processes.ts";
import { EventPublisher } from "./event-publisher.ts";
import {
  isOwnershipLost,
  isRetryable,
  WorkerGatewayRequestError,
} from "./gateway-client.ts";
import { Heartbeat } from "./heartbeat.ts";
import { PendingRequestRegistry } from "./pending-requests.ts";
import type { WorkspacePreparer } from "./workspace.ts";

/** The gateway client plus the one thing a claim changes about it. */
export interface WorkerGatewaySession extends WorkerGatewayClient {
  /** Swaps the launch nonce for the credential bootstrapClaim issued. */
  useCredential(credential: string): void;
}

/** `runtimeConfig` is the claim's: the server resolved it from the session's profile. */
export type RuntimeLaunch = RuntimeResumePlan & {
  correlationId: string;
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
  outcome: "unclaimed" | "idle" | "drained" | "lease_lost" | "failed";
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
};

/** `failed` winds down like a drain; only the reported outcome differs. */
type Stop = { kind: "drain" | "failed" | "idle" | "lost"; reason: string };

type Settlement = {
  reason: string | null;
  result: unknown;
  status: WorkerTerminalStatus;
  usage: unknown;
};

type Turn = {
  /** Past its terminal: what the engine emits now belongs to no turn. */
  closed: boolean;
  settled: Promise<Settlement>;
  settle: (settlement: Settlement) => void;
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
  private attemptState: AttemptState = "starting";
  private heartbeat: Heartbeat | undefined;
  private pending: PendingRequestRegistry | undefined;
  private publisher: EventPublisher | undefined;
  private pumping: Promise<void> | undefined;
  private scopeValue: WorkerScope | undefined;
  private stopping: Stop | undefined;
  /** Resolves when the current turn has to be given up unfinished. */
  private readonly abandoned: Promise<void>;
  private announceAbandon: () => void = () => {};
  private abandonedNow = false;
  /** Aborted by any stop: a clone in progress is not worth finishing. */
  private readonly preparation = new AbortController();
  private stoppedAt: number | undefined;
  private released = false;
  private turn: Turn | undefined;

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
  }

  /** Asks the loop to wind down at the next safe point; safe from a signal handler. */
  drain(reason: string): void {
    this.stop({ kind: "drain", reason });
  }

  async runLoop(): Promise<WorkerRunSummary> {
    const claim = await this.claim();
    if (claim === null) {
      return {
        outcome: "unclaimed",
        reason:
          this.stopping?.reason ?? "No session was waiting for this worker",
        turns: [],
      };
    }
    this.options.gateway.useCredential(claim.session_credential);
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

    const publisher = new EventPublisher({
      gateway: this.options.gateway,
      scope: () => this.scope,
      now: this.options.now ?? (() => new Date()),
      onFailed: (error) =>
        isOwnershipLost(error)
          ? this.lose(describe(error))
          : this.fail(`Events could not be stored: ${describe(error)}`),
    });
    this.publisher = publisher;
    this.pending = new PendingRequestRegistry({
      gateway: this.options.gateway,
      publish: (event) => publisher.publish([event], this.scope.turn_id),
      scope: () => this.scope,
      timeoutMs: this.options.timeouts.questionTimeoutMs,
      pollIntervalMs: this.options.timeouts.answerPollIntervalMs,
      onOwnershipLost: (error) => this.lose(describe(error)),
    });
    this.heartbeat = new Heartbeat({
      gateway: this.options.gateway,
      scope: () => this.scope,
      attemptState: () => this.attemptState,
      intervalMs: this.options.timeouts.heartbeatIntervalMs,
      leaseExpiresAt: new Date(claim.lease_expires_at),
      onLost: (reason) => this.lose(reason),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    });

    let run: AgentRun | undefined;
    try {
      const launcher = this.options.runtimes.launcherFor(claim.runtime);
      // From here on: a clone can take longer than the lease the claim gave.
      this.heartbeat.start();
      const prepared = await this.options.workspace
        .prepare({
          descriptor: claim.workspace,
          restore: claim.restore,
          signal: this.preparation.signal,
        })
        .catch((error: unknown) => {
          // A stop aborts the preparation; that is the stop's outcome, not a
          // failure of its own.
          if (this.preparation.signal.aborted) return null;
          throw error;
        });
      if (prepared !== null) {
        this.logger.info("worker.workspace.prepared", {
          action: prepared,
          repository_id: claim.workspace.repository.id,
          branch: claim.workspace.repository.branch,
        });
      }
      const plan =
        prepared === null
          ? null
          : await this.checkpoints.restorePlan(claim.restore);
      if (plan !== null && this.stopping === undefined) {
        run = launcher.start(
          {
            ...plan,
            correlationId: `${claim.session_id}:${claim.attempt_id}`,
            runtimeConfig: claim.runtime_config,
          },
          { onPermission: (request) => this.onPermission(request) },
        );
        this.attemptState = "running";
        this.pumping = this.pump(run);
        await this.turnLoop(run);
      }
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
    const stop = this.stopping ?? { kind: "drain", reason: "loop ended" };
    await this.shutdown(run);
    return {
      outcome:
        stop.kind === "lost"
          ? "lease_lost"
          : stop.kind === "idle"
            ? "idle"
            : stop.kind === "failed"
              ? "failed"
              : "drained",
      reason: stop.reason,
      turns: this.turns,
    };
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
    this.logger.info("worker.stopping", {
      kind: stop.kind,
      reason: stop.reason,
    });
    // Tell the gateway now rather than at the next beat: a draining attempt
    // is handed no further input.
    if (stop.kind !== "lost") this.heartbeat?.beatNow();
    if (stop.kind === "lost") {
      this.announceAbandon();
      return;
    }
    // A drain lets the turn in flight finish and be finalized; only once that
    // budget is spent is it given up for the recovery path to retry.
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
  }

  private async claim(): Promise<BootstrapClaimResponse | null> {
    const deadline =
      this.now().getTime() + this.options.timeouts.claimTimeoutMs;
    let retriedUnauthorized = false;
    for (;;) {
      if (this.stopping !== undefined) return null;
      try {
        return await this.options.gateway.bootstrapClaim({
          execution_id: this.options.execution.id,
          execution_generation: this.options.execution.generation,
          credential: {
            kind: "launch_nonce",
            nonce: this.options.execution.bootstrapNonce,
          },
        });
      } catch (error) {
        if (!(error instanceof WorkerGatewayRequestError)) throw error;
        // Two claims racing leave one holding the revoked token; before this
        // attempt has used a credential, claiming again returns a working one.
        if (error.code === "UNAUTHORIZED" && !retriedUnauthorized) {
          retriedUnauthorized = true;
          continue;
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
      // Not raced with a drain: an input the gateway hands over is this
      // attempt's to finish, and one dropped here stays open until the
      // reconciler decides it. The draining heartbeat `stop` sends makes the
      // gateway answer the poll empty, so waiting costs one poll interval.
      const next = await this.untilAbandoned(this.nextInput());
      if (next === undefined || next === null) return;
      if (next.input === null) {
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
      lastInputAt = this.now().getTime();
      await this.runTurn(run, next.input);
    }
  }

  private async nextInput(): Promise<NextInputResponse | null> {
    try {
      return await this.withRetry(() =>
        this.options.gateway.nextInput({
          ...this.scope,
          wait_ms: this.options.timeouts.nextInputWaitMs,
        }),
      );
    } catch (error) {
      // Once winding down, a failed poll only means there is nothing more to
      // run; losing the lease is still a loss.
      if (this.stopping !== undefined && !isOwnershipLost(error)) return null;
      throw error;
    }
  }

  private async runTurn(
    run: AgentRun,
    input: { input_id: string; message: string; turn_id: string },
  ): Promise<void> {
    // Delivered while the engine was already gone: nothing can run it, so it
    // is left open for the reconciler rather than sent into the void.
    if (this.stopKind === "failed") return;
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
    run.send({ message: input.message, uuid });

    // No timer bounds this: a turn may legitimately run for hours, and the
    // engine answering is the only thing that ends one. The case that has no
    // answer is a redelivered input the engine already consumed, which it
    // deduplicates by uuid and never produces a result for — unreachable
    // while every attempt opens a fresh engine session, and to be closed
    // with the resume path in 94S-242.
    const settlement = await Promise.race([
      turn.settled,
      this.abandoned.then(() => undefined),
    ]);
    try {
      // Owner loss forbids every further durable write, including this one.
      if (settlement === undefined || this.ownerLost) return;
      await this.finalizeTurn(run, input.turn_id, settlement);
    } finally {
      // Whatever the engine said after the terminal goes out now, as session
      // events, whether or not the turn made it to a finalize.
      this.publisher?.release();
    }
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
    const checkpoint = await this.capture(run);
    if (this.ownerLost) return;
    const finalized = await this.untilAbandoned(
      this.withRetry(
        () =>
          this.options.gateway.finalize({
            ...this.scope,
            turn_id: turnId,
            finalize_key: `${this.scope.attempt_id}:${turnId}`,
            final_source_sequence: finalSourceSequence,
            terminal: {
              status: settlement.status,
              reason: settlement.reason,
              result: settlement.result ?? null,
              usage: settlement.usage ?? null,
            },
            checkpoint,
          }),
        () => this.abandonedNow,
      ),
    );
    if (finalized === undefined) return;
    this.turns.push({
      turnId,
      status: settlement.status,
      reason: settlement.reason,
    });
    this.logger.info("worker.turn.finalized", {
      turn_id: turnId,
      status: settlement.status,
    });
    this.turn = undefined;
    this.scope.turn_id = null;
  }

  private beginTurn(turnId: string, uuid: string): Turn {
    let settle: (settlement: Settlement) => void = () => {};
    const settled = new Promise<Settlement>((resolve) => {
      settle = resolve;
    });
    const turn: Turn = { closed: false, settled, settle, turnId, uuid };
    this.turn = turn;
    return turn;
  }

  private settleTurn(settlement: Settlement): void {
    const turn = this.turn;
    if (turn === undefined) return;
    // The stream is cut here, at the terminal frame, and not wherever it has
    // reached by the time finalize is sent: the engine keeps emitting after
    // its result, and the gateway closes the turn only at the exact end.
    turn.closed = true;
    this.publisher?.hold();
    turn.settle(settlement);
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
        // A stream that ended without a terminal leaves the turn's outcome
        // genuinely unknown; guessing either way would be a lie about the
        // transcript.
        this.settleTurn({
          status: "outcome_unknown",
          reason: "The engine stream ended before the turn settled",
          result: null,
          usage: null,
        });
        // An engine that is gone accepts inputs it will never answer, so the
        // loop must not hand it another one. A no-op when shutdown closed it.
        this.stop({ kind: "failed", reason: "The engine stream ended" });
      }
    })();
  }

  private observe(native: NativeSdkMessage): void {
    if (native.type !== "result") return;
    const turn = this.turn;
    if (turn === undefined) return;
    const attributed = attributedUuids(native);
    // A result that names other inputs belongs to a batch this turn is not
    // part of; one that names nothing settles nothing on its own.
    if (attributed.length > 0 && !attributed.includes(turn.uuid)) return;
    this.settleTurn(
      attributed.includes(turn.uuid)
        ? terminalOf(native)
        : {
            status: "outcome_unknown",
            reason: "The engine reported a result it attributed to no input",
            result: resultPayload(native),
            usage: native.usage ?? null,
          },
    );
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
    return this.pending.request(request);
  }

  private async capture(run: AgentRun): Promise<CheckpointRef | null> {
    const preparation = await run.prepareCheckpoint();
    if (preparation.status === "rejected") {
      this.logger.warn("worker.checkpoint.rejected", {
        reason: preparation.reason,
        detail: preparation.detail,
      });
    }
    return this.checkpoints.capture(preparation);
  }

  private async shutdown(run: AgentRun | undefined): Promise<void> {
    const stop = this.stopping ?? { kind: "drain", reason: "loop ended" };
    this.pending?.cancelAll(
      stop.kind === "lost"
        ? "This worker no longer owns the session"
        : "This worker is shutting down",
    );
    if (run !== undefined && this.turn !== undefined) {
      // Whatever is still open here has already used up its drain budget, or
      // belongs to a lease this attempt no longer holds.
      const settledInTime =
        stop.kind !== "lost" && (await settledWithin(this.turn.settled, 0));
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
          this.withinGrace(INTERRUPT_GRACE_MS),
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
      await settledWithin(this.pumping, this.withinGrace(ENGINE_EXIT_GRACE_MS));
    }
    await this.confirmEngineExit();
    if (this.heartbeat !== undefined) {
      await settledWithin(
        this.heartbeat.stop(),
        this.withinGrace(this.options.timeouts.requestTimeoutMs),
      );
    }
    if (stop.kind === "lost") {
      // No durable write survives owner loss: not the event tail, not the
      // in-flight turn, not the release.
      this.logger.warn("worker.ownership.lost", { reason: stop.reason });
      return;
    }
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
    this.released = true;
    const releasing = this.options.gateway
      .release({ ...this.scope, turn_id: null, reason: stop.reason })
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
   * The stream ending says the engine stopped talking, not that its process
   * is gone. Only the observed exit says that, so a straggler past the grace
   * period is killed rather than left running behind this process.
   */
  private async confirmEngineExit(): Promise<void> {
    const engines = this.options.engines;
    if (engines === undefined) return;
    if (await engines.exited(this.withinGrace(ENGINE_EXIT_GRACE_MS))) {
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
   * A shutdown wait, cut to what the launcher's stop grace still allows so
   * the release at the end is not the part the SIGKILL takes away.
   */
  private withinGrace(ms: number, reserve = RELEASE_RESERVE_MS): number {
    const grace = this.options.timeouts.stopGraceMs;
    if (grace === undefined || this.stoppedAt === undefined) return ms;
    const left = this.stoppedAt + grace - reserve - this.now().getTime();
    return Math.max(0, Math.min(ms, left));
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
      }
    }
  }
}

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

function terminalOf(native: NativeSdkMessage): Settlement {
  const subtype =
    typeof native.subtype === "string" ? native.subtype : "unknown";
  const interrupted = native.terminal_reason === "interrupted";
  const failed = native.is_error === true || subtype !== "success";
  const status: WorkerTerminalStatus = interrupted
    ? "interrupted"
    : failed
      ? "failed"
      : "completed";
  return {
    status,
    reason: status === "completed" ? null : subtype,
    result: resultPayload(native),
    usage: native.usage ?? null,
  };
}

function resultPayload(native: NativeSdkMessage): unknown {
  return {
    subtype: native.subtype ?? null,
    is_error: native.is_error ?? null,
    stop_reason: native.stop_reason ?? null,
    terminal_reason: native.terminal_reason ?? null,
  };
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

const consoleLogger: WorkerLogger = {
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
