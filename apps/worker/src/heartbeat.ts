import type { AttemptState, WorkerScope } from "@agent-platform/contracts";
import type { WorkerGatewayClient } from "@agent-platform/runtime-core";

import {
  isOwnershipLost,
  isRetryable,
  WorkerGatewayRequestError,
} from "./gateway-client.ts";

export type HeartbeatOptions = {
  gateway: Pick<WorkerGatewayClient, "heartbeat">;
  scope: () => WorkerScope;
  attemptState: () => AttemptState;
  intervalMs: number;
  /** The lease the claim came back with; each beat pushes it out. */
  leaseExpiresAt: Date;
  /** Called once, with why this attempt stopped owning the session. */
  onLost: (reason: string) => void;
  now?: () => Date;
};

/**
 * The lease clock, deliberately on its own timer rather than inside the turn
 * loop: a turn that blocks for an hour on a model call must still be reporting
 * that it is alive, and a lease that lapses must be noticed even when no
 * gateway call is otherwise due.
 */
export class Heartbeat {
  private readonly options: HeartbeatOptions;
  private lease: Date;
  private lost = false;
  private running: Promise<void> | undefined;
  private stopped = false;
  private wake: (() => void) | undefined;

  constructor(options: HeartbeatOptions) {
    this.options = options;
    this.lease = options.leaseExpiresAt;
  }

  get leaseExpiresAt(): Date {
    return this.lease;
  }

  start(): void {
    this.running ??= this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopped && !this.lost) {
      await this.pause(this.options.intervalMs);
      if (this.stopped || this.lost) return;
      await this.beat();
    }
  }

  private async beat(): Promise<void> {
    const scope = this.options.scope();
    try {
      const response = await this.options.gateway.heartbeat({
        ...scope,
        attempt_state: this.options.attemptState(),
      });
      this.lease = new Date(response.lease_expires_at);
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
      // point where the lease it granted runs out.
      const now = (this.options.now ?? (() => new Date()))();
      if (now.getTime() >= this.lease.getTime()) {
        this.declareLost(
          `lease expired at ${this.lease.toISOString()} with the gateway unreachable`,
        );
      }
    }
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
