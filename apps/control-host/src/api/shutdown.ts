import type { StructuredLogger } from "@agent-platform/observability";
import { REQUEST_DEADLINE_MS } from "./deadline.ts";
import type { ReadinessProbe } from "./readiness.ts";

// Past the request deadline, so every /v1 request that is still running gets
// to answer (its own 503 at the deadline at worst) before connections are
// cut. SSE streams never finish on their own, so an open stream holds
// shutdown to this bound; the client reconnects with Last-Event-ID either
// way. Ending streams at drain start is left out until restart latency
// matters (rolling deploys with many replicas).
export const SHUTDOWN_DRAIN_MS = REQUEST_DEADLINE_MS + 5_000;
// Cutting connections and closing the pools after the drain. A handler cut
// mid-query still holds its client until the query returns (up to the pool's
// 20s read timeout), and pool.end() waits for it; past this the process exits
// with those closes unfinished rather than be SIGKILLed mid-log.
export const SHUTDOWN_CLOSE_MS = 5_000;
// The process's stop grace (compose stop_grace_period) must stay above
// SHUTDOWN_DRAIN_MS + SHUTDOWN_CLOSE_MS.

/** What `Bun.serve` returns, as far as shutdown needs it. */
export interface Listener {
  // Without `true` it stops accepting and resolves once in-flight requests
  // have finished; with it, it also closes the connections still open.
  stop(closeActiveConnections?: boolean): Promise<void>;
  readonly pendingRequests: number;
}

export interface Resource {
  readonly name: string;
  close(): Promise<void>;
}

export interface ShutdownOptions {
  readonly logger: Pick<StructuredLogger, "info" | "warn" | "error">;
  readonly drainMs?: number;
  readonly closeMs?: number;
  readonly exit?: (code: number) => void;
}

export interface Shutdown {
  /** Answers not-ready from the moment shutdown starts, ahead of `probe`. */
  readiness(probe: ReadinessProbe): ReadinessProbe;
  /**
   * readiness withdrawn → listeners stop accepting → in-flight requests
   * drain (bounded) → `resources` close in the order given (bounded) →
   * exit, non-zero when a close failed or ran out of time. A second
   * call exits at once: an operator asking twice means now.
   */
  run(
    signal: string,
    listeners: readonly Listener[],
    resources: readonly Resource[],
  ): Promise<void>;
}

// Resolves to false when `work` is still running after `ms`; the work itself
// is abandoned, not cancelled.
async function within(ms: number, work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

export function createShutdown(options: ShutdownOptions): Shutdown {
  const { logger } = options;
  const drainMs = options.drainMs ?? SHUTDOWN_DRAIN_MS;
  const closeMs = options.closeMs ?? SHUTDOWN_CLOSE_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;

  return {
    readiness(probe) {
      return async () =>
        started
          ? { ready: false, check: "shutdown", reason: "shutting down" }
          : probe();
    },

    async run(signal, listeners, resources) {
      if (started) {
        logger.warn("Shutdown signal repeated; exiting without draining", {
          signal,
        });
        exit(1);
        return;
      }
      started = true;
      // With no load balancer in front (compose) nothing reads readiness
      // between these two steps. A deployment whose endpoints follow
      // readiness needs a pause here (or a preStop sleep) before the
      // listener closes; add it with those manifests.
      logger.info("Shutdown started; readiness withdrawn", { signal });

      const drained = listeners.map((listener) => listener.stop());
      logger.info("Stopped accepting connections", {
        in_flight: listeners.reduce((sum, l) => sum + l.pendingRequests, 0),
      });

      const cut = await within(drainMs, Promise.allSettled(drained)).then(
        (finished) => !finished,
      );
      const closeBy = Date.now() + closeMs;
      const remaining = () => Math.max(closeBy - Date.now(), 0);
      if (cut) {
        logger.warn("Drain deadline passed; closing open connections", {
          drain_ms: drainMs,
          in_flight: listeners.reduce((sum, l) => sum + l.pendingRequests, 0),
        });
        await within(
          remaining(),
          Promise.allSettled(listeners.map((l) => l.stop(true))),
        );
      } else {
        logger.info("In-flight requests drained", {});
      }

      let failed = false;
      let closing: string | undefined;
      const closed = (async () => {
        for (const resource of resources) {
          closing = resource.name;
          try {
            await resource.close();
          } catch (error) {
            failed = true;
            logger.error("Closing a resource failed during shutdown", {
              resource: resource.name,
              error_name: error instanceof Error ? error.name : "Error",
            });
          }
        }
        closing = undefined;
      })();
      if (!(await within(remaining(), closed))) {
        logger.error("Closing resources ran out of time; exiting anyway", {
          close_ms: closeMs,
          resource: closing,
        });
        exit(1);
        return;
      }
      logger.info("Connections closed; exiting", {
        resources: resources.map((resource) => resource.name),
      });
      exit(failed ? 1 : 0);
    },
  };
}
