import { AsyncLocalStorage } from "node:async_hooks";

// A deadline that the pool enforces on everything done inside it, whoever
// does it: the auth key lookup, a drizzle transaction, a service several
// calls deep. Carried by async context so nothing between the HTTP layer and
// pg has to thread a signal through.
export class RequestDeadline {
  private live = true;
  private expired = false;
  private readonly held = new Set<() => void>();

  // `at` is a performance.now() instant.
  constructor(readonly at: number) {}

  get active(): boolean {
    return this.live;
  }

  remainingMs(): number {
    const remaining = this.at - performance.now();
    // The expiry timer runs on the event loop's clock, not performance.now(),
    // and can fire a millisecond before `at`; once it has, nothing is left.
    return this.expired ? Math.min(0, remaining) : remaining;
  }

  // Registers a checked-out client's eviction; the returned function
  // unregisters it when the client goes back to the pool.
  hold(evict: () => void): () => void {
    this.held.add(evict);
    return () => this.held.delete(evict);
  }

  // The request answered without its handler: every client the handler still
  // holds is evicted now, even one idle between two statements of an open
  // transaction whose next statement may never come. The deadline stays in
  // force, so the abandoned handler's next statement fails at once.
  expire(): void {
    this.expired = true;
    for (const evict of [...this.held]) {
      evict();
    }
    this.held.clear();
  }

  // The request answered in time: work that outlives the handler on purpose
  // (an SSE stream's reads) is no longer bounded by it.
  finish(): void {
    this.live = false;
  }
}

const current = new AsyncLocalStorage<RequestDeadline>();

export class RequestDeadlineExceededError extends Error {
  constructor() {
    super("Request deadline exceeded");
    this.name = "RequestDeadlineExceededError";
  }
}

export function runWithDeadline<T>(deadline: RequestDeadline, fn: () => T): T {
  return current.run(deadline, fn);
}

export function currentDeadline(): RequestDeadline | undefined {
  const deadline = current.getStore();
  return deadline?.active ? deadline : undefined;
}
