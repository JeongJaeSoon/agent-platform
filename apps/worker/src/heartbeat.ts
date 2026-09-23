import type {
  AttemptState,
  TranscriptReport,
  WorkerScope,
} from "@agent-platform/contracts";
import type { WorkerGatewayClient } from "@agent-platform/runtime-core";

import {
  isOwnershipLost,
  isRetryable,
  WorkerGatewayRequestError,
} from "./gateway-client.ts";

/**
 * A lease as the gateway granted it: what was left of it on the database
 * clock, and the monotonic instant the request that won it was sent. The
 * gateway measured the remainder after that request arrived, so counting it
 * from the send can only end the lease early, never late — and no wall
 * clock, the worker's or the database's, enters the sum (94S-322).
 */
export type LeaseGrant = { remainingMs: number; sentAt: number };

export type HeartbeatOptions = {
  gateway: Pick<WorkerGatewayClient, "heartbeat">;
  scope: () => WorkerScope;
  attemptState: () => AttemptState;
  intervalMs: number;
  /** The lease the claim came back with; each beat pushes it out. */
  lease: LeaseGrant;
  /**
   * How long before the lease runs out an unrenewed one counts as lost: the
   * engine is killed then, so that it is gone by the time another attempt
   * may be handed the session.
   */
  safetyMarginMs: number;
  /** Called once, with why this attempt stopped owning the session. */
  onLost: (reason: string) => void;
  /** An answer or control intent is waiting to be fetched. */
  onControlPending?: () => void;
  /**
   * The transcript mirror as of this beat; undefined while the run has none.
   * A `mirror_error` here is what records the session's blocking pending
   * reason even when no checkpoint is asked for afterwards.
   */
  transcript?: () => TranscriptReport | undefined;
  /** Milliseconds on a clock that never jumps; `performance.now` by default. */
  monotonicNow?: () => number;
};

/**
 * The lease clock, deliberately on its own timer rather than inside the turn
 * loop: a turn that blocks for an hour on a model call must still be reporting
 * that it is alive, and a lease that lapses must be noticed even when no
 * gateway call is otherwise due.
 */
export class Heartbeat {
  private readonly options: HeartbeatOptions;
  private readonly clock: () => number;
  /** When the lease runs out, on `clock`. */
  private deadline: number;
  private readonly marginMs: number;
  private lost = false;
  private running: Promise<void> | undefined;
  private stopped = false;
  private wake: (() => void) | undefined;
  /** A beat asked for and not yet sent; the loop, or `stop`, owes it. */
  private owed = false;
  /** Whether a beat the gateway answered carried a `mirror_error`. */
  private mirrorErrorAnswered = false;

  constructor(options: HeartbeatOptions) {
    this.options = options;
    this.clock = options.monotonicNow ?? (() => performance.now());
    this.deadline = options.lease.sentAt + options.lease.remainingMs;
    // Not clamped to the grant: a margin the lease cannot cover loses the
    // attempt at its first beat and says so, rather than quietly running
    // with less safety than was configured.
    this.marginMs = options.safetyMarginMs;
    if (!(this.marginMs >= 0) || !Number.isFinite(this.deadline)) {
      throw new Error(
        `Heartbeat needs a finite lease and a non-negative margin, got ${options.lease.remainingMs}ms and ${options.safetyMarginMs}ms`,
      );
    }
  }

  /**
   * What is left before the lease is given up, as of now. Once it reaches
   * zero it is given up for good: a renewal that lands later does not bring
   * back an ownership this attempt already stopped acting on.
   */
  get leaseLeftMs(): number {
    return Math.max(0, this.deadline - this.marginMs - this.clock());
  }

  /**
   * True once the gateway answered a beat that reported the transcript
   * mirror's error, which is when it holds the session's pending reason.
   */
  get mirrorErrorRecorded(): boolean {
    return this.mirrorErrorAnswered;
  }

  start(): void {
    this.running ??= this.loop();
  }

  /**
   * Beats at once instead of waiting out the interval. Asked mid-beat, the
   * next beat follows that one directly: the beat already on the wire may
   * carry the state from before the change this call is announcing.
   */
  beatNow(): void {
    this.owed = true;
    this.wake?.();
  }

  /**
   * Ends the loop, then sends a beat that was asked for and never sent: a
   * stop that lands between `beatNow` and the beat must not drop what that
   * beat was announcing.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.running;
    if (this.owed && !this.lost) await this.beatOnce();
  }

  /** One beat now, outside the loop; for a caller that must see it land. */
  async beatOnce(): Promise<void> {
    this.owed = false;
    await this.beat();
  }

  private async loop(): Promise<void> {
    while (!this.stopped && !this.lost) {
      // Wakes by halfway to the point the lease is given up at: one granted
      // with less left than the interval (a slow answer, a long interval)
      // must still be beaten while a renewal can land, and one that runs
      // out between beats noticed when it does.
      if (!this.owed) {
        await this.pause(
          Math.min(this.options.intervalMs, Math.floor(this.leaseLeftMs / 2)),
        );
      }
      if (this.stopped || this.lost) return;
      this.owed = false;
      await this.beat();
    }
  }

  private async beat(): Promise<void> {
    const scope = this.options.scope();
    const transcript = this.options.transcript?.();
    if (this.leaseLeftMs <= 0) {
      this.giveUp("no beat renewed it in time");
      return;
    }
    const sentAt = this.clock();
    try {
      const response = await this.beforeLeaseRunsOut(
        this.options.gateway.heartbeat({
          ...scope,
          attempt_state: this.options.attemptState(),
          ...(transcript === undefined ? {} : { transcript }),
        }),
      );
      // The request timeout can be longer than what is left of the lease,
      // and a stalled event loop can fire the race's timer late: an answer
      // is taken only if it came back before the lease was given up. The
      // lease is judged as it stands now — an overlapping beat may have
      // renewed it while this one was waiting.
      if (this.leaseLeftMs <= 0) {
        this.giveUp("the gateway had not answered the beat renewing it");
        return;
      }
      if (response === undefined) return;
      // Overlapping beats can answer out of order; neither shortens the
      // lease the other already granted, as on the database side.
      this.deadline = Math.max(
        this.deadline,
        sentAt + response.lease_remaining_ms,
      );
      if (transcript?.mirror_error != null) this.mirrorErrorAnswered = true;
      if (response.control_pending) this.options.onControlPending?.();
      if (response.auth_revision !== scope.auth_revision) {
        // The session's authorization moved on, so this token's binding is
        // already behind and every write it makes would be fenced out.
        this.declareLost(`auth_revision advanced to ${response.auth_revision}`);
      }
    } catch (error) {
      if (isOwnershipLost(error)) {
        this.declareLost(message(error));
        return;
      }
      if (!isRetryable(error)) {
        this.declareLost(message(error));
        return;
      }
      // A gateway that is merely unreachable is survivable right up to the
      // point where the lease it granted is given up.
      if (this.leaseLeftMs <= 0) this.giveUp("the gateway is unreachable");
    }
  }

  private async beforeLeaseRunsOut<T>(
    request: Promise<T>,
  ): Promise<T | undefined> {
    request.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.leaseLeftMs);
    });
    try {
      return await Promise.race([request, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Gives the lease up a margin before the database would end it, so the
   * engine is gone by the time another attempt may be handed the session.
   * It goes the way of any loss — no release, no further writes — even
   * though a release might still land: recovery then waits out the margin.
   */
  private giveUp(why: string): void {
    this.declareLost(
      `lease given up ${this.marginMs}ms before it runs out: ${why}`,
    );
  }

  private declareLost(reason: string): void {
    if (this.lost) return;
    this.lost = true;
    this.options.onLost(reason);
  }

  private pause(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}

function message(error: unknown): string {
  if (error instanceof WorkerGatewayRequestError && error.code !== null) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
