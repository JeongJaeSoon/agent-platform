/**
 * In-flight accounting for the spike's S3 traffic.
 *
 * A stalled S3 request is invisible in this suite: the AWS SDK client is built
 * with no request or connection timeout, so a request the peer never answers
 * never settles and never retries. All bun reports is `timed out after
 * 30000ms` with no indication of which await was stuck. This module names it.
 */

type PendingCall = {
  readonly label: string;
  readonly startedAt: number;
};

export type S3ClientLike = {
  send(command: never, ...rest: never[]): Promise<unknown>;
};

export class S3CallTracker {
  readonly #pending = new Map<number, PendingCall>();
  #nextId = 0;
  #completed = 0;

  /** Wraps `send` so every call is accounted for. Returns the same client. */
  instrument<T extends S3ClientLike>(client: T): T {
    const original = client.send.bind(client) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const tracker = this;
    Object.defineProperty(client, "send", {
      configurable: true,
      value: function instrumentedSend(...args: unknown[]) {
        const done = tracker.begin(describeCommand(args[0]));
        return original(...args).finally(done);
      },
      writable: true,
    });
    return client;
  }

  begin(label: string): () => void {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#pending.set(id, { label, startedAt: Date.now() });
    return () => {
      if (this.#pending.delete(id)) this.#completed += 1;
    };
  }

  /** Calls still unsettled after `stallMs`, oldest first. */
  stalled(stallMs: number): string[] {
    const now = Date.now();
    return [...this.#pending.values()]
      .filter((call) => now - call.startedAt >= stallMs)
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((call) => `${call.label} pending ${now - call.startedAt}ms`);
  }

  describe(): string {
    const now = Date.now();
    const pending = [...this.#pending.values()]
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((call) => `${call.label}@${now - call.startedAt}ms`);
    return `completed=${this.#completed} pending=${pending.length}${
      pending.length === 0 ? "" : ` [${pending.join(", ")}]`
    }`;
  }
}

/**
 * Reports S3 calls that outlive `stallMs` to stderr while the suite is still
 * running, so the line lands in the log before bun's own timeout kills the
 * test and discards everything the test would have printed.
 */
export function startStallReporter(
  label: string,
  tracker: S3CallTracker,
  options: { intervalMs?: number; stallMs?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 2_000;
  const stallMs = options.stallMs ?? 5_000;
  const reported = new Set<string>();
  const timer = setInterval(() => {
    for (const entry of tracker.stalled(stallMs)) {
      const key = entry.replace(/ pending \d+ms$/, "");
      if (reported.has(key)) continue;
      reported.add(key);
      process.stderr.write(`S3_STALL[${label}] ${entry}\n`);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function describeCommand(command: unknown): string {
  const name = (command as { constructor?: { name?: string } })?.constructor
    ?.name;
  const input = (command as { input?: Record<string, unknown> })?.input ?? {};
  const target = input.Key ?? input.Prefix ?? input.Bucket;
  return `${name ?? "UnknownCommand"}(${typeof target === "string" ? target : "?"})`;
}
