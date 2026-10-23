/**
 * Fixed-window request counters held in this process. Each key has its own
 * window; the map is bounded, dropping the oldest window when full, so a
 * stream of made-up keys costs memory up to `maxKeys` and no more.
 */
export class WindowRateLimiter {
  readonly #windows = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly options: {
      limit: number;
      windowMs: number;
      maxKeys: number;
    },
  ) {}

  /** Counts one request; false when the key is over its limit. */
  take(key: string, now: number): boolean {
    let window = this.#windows.get(key);
    if (
      window === undefined ||
      now - window.startedAt >= this.options.windowMs
    ) {
      this.#windows.delete(key);
      if (this.#windows.size >= this.options.maxKeys) {
        const oldest = this.#windows.keys().next().value;
        if (oldest !== undefined) this.#windows.delete(oldest);
      }
      window = { startedAt: now, count: 0 };
      this.#windows.set(key, window);
    }
    window.count += 1;
    return window.count <= this.options.limit;
  }

  /** Whole seconds until the key's window ends. */
  retryAfterSeconds(key: string, now: number): number {
    const window = this.#windows.get(key);
    if (window === undefined) return 1;
    return Math.max(
      1,
      Math.ceil((window.startedAt + this.options.windowMs - now) / 1000),
    );
  }
}

/**
 * The events route's two limits, both checked before any database read:
 * all requests together, and requests per path agent id. Slack sends at
 * most ~30,000 events an hour per app (500 a minute), so neither is near
 * what a real workspace sends.
 */
export const SLACK_EVENTS_GLOBAL_LIMIT_PER_MINUTE = 1000;
export const SLACK_EVENTS_AGENT_LIMIT_PER_MINUTE = 600;

export function createSlackEventsLimiter(options?: {
  globalPerMinute?: number;
  agentPerMinute?: number;
}) {
  const global = new WindowRateLimiter({
    limit: options?.globalPerMinute ?? SLACK_EVENTS_GLOBAL_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    maxKeys: 1,
  });
  const perAgent = new WindowRateLimiter({
    limit: options?.agentPerMinute ?? SLACK_EVENTS_AGENT_LIMIT_PER_MINUTE,
    windowMs: 60_000,
    maxKeys: 4096,
  });
  return {
    /** Null when the request may go on, else the seconds to wait. */
    admit(agentId: string, now = Date.now()): number | null {
      if (!global.take("global", now)) {
        return global.retryAfterSeconds("global", now);
      }
      const key = agentId.toLowerCase();
      if (!perAgent.take(key, now)) {
        return perAgent.retryAfterSeconds(key, now);
      }
      return null;
    },
  };
}

export type SlackEventsLimiter = ReturnType<typeof createSlackEventsLimiter>;
