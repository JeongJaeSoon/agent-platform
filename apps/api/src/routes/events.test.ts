import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  SSE_SCHEMA_VERSION,
  type SseEvent,
} from "@agent-platform/contracts";
import { InvalidCursorError } from "@agent-platform/db";
import {
  createSessionService,
  ownerScopedPolicy,
  type ReadEventsQuery,
  type SessionReader,
} from "@agent-platform/platform";
import { createApiApp } from "../app.ts";
import type { SessionEventWakeup } from "../events/notifications.ts";
import { registerEventRoutes } from "./events.ts";

const SESSION = "019a0000-0000-7000-8000-000000000001";
const OWNER = "owner-a";

function event(id: number, phase = "running"): SseEvent {
  return {
    id: `ev_${id.toString(36)}`,
    event: "status",
    data: {
      schema_version: SSE_SCHEMA_VERSION,
      session_id: SESSION,
      turn_id: "1",
      attempt_id: "a1",
      occurred_at: "2026-09-23T00:00:00.000Z",
      data: { phase },
    },
  } as SseEvent;
}

// An in-memory events table: readEvents pages by id like the Postgres reader.
class FakeStore {
  events: SseEvent[] = [];
  reads: ReadEventsQuery[] = [];
  owner = OWNER;
  // Runs after a page is computed and before it is returned: a commit that
  // lands while the read is in flight.
  onRead: ((query: ReadEventsQuery) => void) | undefined;

  append(...items: SseEvent[]) {
    this.events.push(...items);
  }

  reader(): SessionReader["readEvents"] {
    return async (ownerId, sessionId, query) => {
      this.reads.push(query);
      if (ownerId !== this.owner || sessionId !== SESSION) return null;
      if (query.after !== undefined && !/^ev_[0-9a-z]+$/.test(query.after)) {
        throw new InvalidCursorError();
      }
      const afterId = query.after
        ? Number.parseInt(query.after.slice(3), 36)
        : 0;
      const page = this.events
        .filter((item) => Number.parseInt(item.id.slice(3), 36) > afterId)
        .slice(0, query.limit);
      this.onRead?.(query);
      return page;
    };
  }
}

class FakeWakeup implements SessionEventWakeup {
  waiters: Array<{ sessionId: string; resolve: () => void }> = [];

  wait(sessionId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const entry = { sessionId, resolve };
      this.waiters.push(entry);
      signal.addEventListener(
        "abort",
        () => {
          this.waiters = this.waiters.filter((item) => item !== entry);
          resolve();
        },
        { once: true },
      );
    });
  }

  async armed(): Promise<void> {
    for (let i = 0; i < 50 && this.waiters.length === 0; i += 1) {
      await Bun.sleep(5);
    }
    expect(this.waiters.length).toBeGreaterThan(0);
  }

  notify(sessionId = SESSION) {
    const due = this.waiters.filter((item) => item.sessionId === sessionId);
    this.waiters = this.waiters.filter((item) => item.sessionId !== sessionId);
    for (const item of due) item.resolve();
  }
}

function harness(options: { keepaliveMs?: number; batchSize?: number } = {}) {
  const store = new FakeStore();
  const wakeup = new FakeWakeup();
  const service = createSessionService({
    authorization: ownerScopedPolicy,
    catalog: { profiles: {}, repositories: {} },
    inputs: {
      acceptInputAtomic: async () => {
        throw new Error("not reached");
      },
      appendInputAtomic: async () => {
        throw new Error("not reached");
      },
    },
    reader: {
      listSessions: async () => ({ items: [], next_cursor: null }),
      getSession: async () => null,
      listTurns: async () => null,
      getTurn: async () => null,
      getReceipt: async () => null,
      readEvents: store.reader(),
    },
  });
  let handle: ReturnType<typeof registerEventRoutes> | undefined;
  const app = createApiApp({
    authMode: "none",
    registerRoutes: (router) => {
      handle = registerEventRoutes(router, service, {
        wakeup,
        logger: { info() {}, warn() {} },
        ...options,
      });
    },
  });
  if (!handle) throw new Error("routes not registered");
  return { app, store, wakeup, handle };
}

type Frame = { id?: string; event?: string; data?: string; comment?: string };

// Reads SSE frames off the body as they arrive; a frame ends at a blank line.
class FrameReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer = "";
  #frames: Frame[] = [];
  #done = false;

  constructor(response: Response) {
    if (!response.body) throw new Error("no body");
    this.#reader = response.body.getReader();
  }

  async next(timeoutMs = 2_000): Promise<Frame | null> {
    const deadline = Date.now() + timeoutMs;
    while (this.#frames.length === 0 && !this.#done) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out waiting for a frame");
      const chunk = await Promise.race([
        this.#reader.read(),
        Bun.sleep(remaining).then(() => ({ done: false, value: undefined })),
      ]);
      if (chunk.done) {
        this.#done = true;
        break;
      }
      if (!chunk.value) continue;
      this.#buffer += new TextDecoder().decode(chunk.value);
      let end = this.#buffer.indexOf("\n\n");
      while (end !== -1) {
        this.#frames.push(parseFrame(this.#buffer.slice(0, end)));
        this.#buffer = this.#buffer.slice(end + 2);
        end = this.#buffer.indexOf("\n\n");
      }
    }
    return this.#frames.shift() ?? null;
  }

  async ended(timeoutMs = 2_000): Promise<boolean> {
    const frame = await this.next(timeoutMs);
    return frame === null && this.#done;
  }

  cancel() {
    return this.#reader.cancel();
  }
}

function parseFrame(raw: string): Frame {
  const frame: Frame = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) {
      frame.comment = line.slice(1).trim();
    } else {
      const separator = line.indexOf(":");
      const field = line.slice(0, separator);
      const value = line.slice(separator + 1).trimStart();
      if (field === "id" || field === "event" || field === "data") {
        frame[field] = value;
      }
    }
  }
  return frame;
}

function open(
  app: ReturnType<typeof createApiApp>,
  headers: Record<string, string> = {},
  init: RequestInit = {},
) {
  return app.request(`/v1/sessions/${SESSION}/events`, {
    headers: { "X-Owner-Id": OWNER, ...headers },
    ...init,
  });
}

describe("GET /v1/sessions/{id}/events", () => {
  test("replays from the beginning as text/event-stream frames", async () => {
    const { app, store } = harness();
    store.append(event(1, "queued"), event(2, "running"));
    const response = await open(app);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");

    const frames = new FrameReader(response);
    const first = await frames.next();
    expect(first).toEqual({
      id: "ev_1",
      event: "status",
      data: JSON.stringify(event(1, "queued").data),
    });
    const second = await frames.next();
    expect(second?.id).toBe("ev_2");
    expect(JSON.parse(second?.data ?? "{}").data).toEqual({
      phase: "running",
    });
    expect(store.reads[0]).toEqual({ limit: 100 });
    await frames.cancel();
  });

  test("resumes after Last-Event-ID and pages through the backlog", async () => {
    const { app, store } = harness({ batchSize: 2 });
    store.append(event(1), event(2), event(3), event(4), event(5));
    const response = await open(app, { "Last-Event-ID": "ev_1" });
    const frames = new FrameReader(response);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push((await frames.next())?.id ?? "");
    expect(ids).toEqual(["ev_2", "ev_3", "ev_4", "ev_5"]);
    for (let i = 0; i < 50 && store.reads.length < 3; i += 1) {
      await Bun.sleep(5);
    }
    // Three pages: after ev_1, after ev_3 (full), after ev_5 (short, then wait).
    expect(store.reads.map((read) => read.after)).toEqual([
      "ev_1",
      "ev_3",
      "ev_5",
    ]);
    await frames.cancel();
  });

  test("a NOTIFY that lands during a read is not lost", async () => {
    const { app, store, wakeup } = harness({ keepaliveMs: 5_000 });
    store.append(event(1));
    // The commit fires while the caught-up read is in flight: the waiter
    // must already exist, or the stream idles until the keepalive.
    store.onRead = (query) => {
      if (query.after === "ev_1" && store.events.length === 1) {
        store.append(event(2));
        expect(wakeup.waiters).toHaveLength(1);
        wakeup.notify();
      }
    };
    const response = await open(app);
    const frames = new FrameReader(response);
    expect((await frames.next())?.id).toBe("ev_1");
    await wakeup.armed();
    wakeup.notify();
    // Read after ev_1 returns a short page, but the mid-read notify already
    // resolved the armed waiter, so ev_2 arrives well before the keepalive.
    expect((await frames.next(1_000))?.id).toBe("ev_2");
    await frames.cancel();
  });

  test("a revoked credential ends a stream that is still replaying", async () => {
    const store = new FakeStore();
    const wakeup = new FakeWakeup();
    // Every page is full: the backlog never drains, so the only chance to
    // notice the revocation is the clock check during replay.
    for (let i = 1; i <= 5_000; i += 1) store.append(event(i));
    let valid = true;
    const service = createSessionService({
      authorization: ownerScopedPolicy,
      catalog: { profiles: {}, repositories: {} },
      inputs: {
        acceptInputAtomic: async () => {
          throw new Error("not reached");
        },
        appendInputAtomic: async () => {
          throw new Error("not reached");
        },
      },
      reader: {
        listSessions: async () => ({ items: [], next_cursor: null }),
        getSession: async () => null,
        listTurns: async () => null,
        getTurn: async () => null,
        getReceipt: async () => null,
        readEvents: async (ownerId, sessionId, query) => {
          await Bun.sleep(2);
          return store.reader()(ownerId, sessionId, query);
        },
      },
    });
    const app = createApiApp({
      authMode: "api-key",
      keyStore: {
        async findOwner() {
          return valid ? OWNER : null;
        },
      },
      registerRoutes: (router) => {
        registerEventRoutes(router, service, {
          wakeup,
          keepaliveMs: 20,
          batchSize: 10,
          logger: { info() {}, warn() {} },
        });
      },
    });
    const response = await open(app, { Authorization: "Bearer csp_test" });
    const frames = new FrameReader(response);
    expect((await frames.next())?.id).toBe("ev_1");
    valid = false;
    let received = 1;
    for (;;) {
      const frame = await frames.next();
      if (frame === null) break;
      received += 1;
    }
    expect(received).toBeLessThan(5_000);
    expect(await frames.ended()).toBe(true);
  });

  test("switches to live on NOTIFY without skipping or repeating", async () => {
    const { app, store, wakeup } = harness();
    store.append(event(1));
    const response = await open(app);
    const frames = new FrameReader(response);
    expect((await frames.next())?.id).toBe("ev_1");

    await wakeup.armed();
    store.append(event(2), event(3));
    wakeup.notify();
    expect((await frames.next())?.id).toBe("ev_2");
    expect((await frames.next())?.id).toBe("ev_3");
    // A NOTIFY for another session does not wake this stream.
    await wakeup.armed();
    const reads = store.reads.length;
    wakeup.notify("019a0000-0000-7000-8000-00000000ffff");
    await Bun.sleep(20);
    expect(store.reads).toHaveLength(reads);
    expect(wakeup.waiters).toHaveLength(1);
    // Its own NOTIFY re-reads from the last id sent.
    wakeup.notify();
    for (let i = 0; i < 50 && store.reads.length === reads; i += 1) {
      await Bun.sleep(5);
    }
    expect(store.reads.at(-1)?.after).toBe("ev_3");
    await frames.cancel();
  });

  test("sends a keepalive comment on the clock while idle", async () => {
    const { app } = harness({ keepaliveMs: 40 });
    const response = await open(app);
    const frames = new FrameReader(response);
    const started = Date.now();
    expect((await frames.next())?.comment).toBe("keepalive");
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect((await frames.next())?.comment).toBe("keepalive");
    await frames.cancel();
  });

  test("ends the stream once the credential no longer authenticates", async () => {
    const { store, wakeup } = harness();
    let valid = true;
    const service = createSessionService({
      authorization: ownerScopedPolicy,
      catalog: { profiles: {}, repositories: {} },
      inputs: {
        acceptInputAtomic: async () => {
          throw new Error("not reached");
        },
        appendInputAtomic: async () => {
          throw new Error("not reached");
        },
      },
      reader: {
        listSessions: async () => ({ items: [], next_cursor: null }),
        getSession: async () => null,
        listTurns: async () => null,
        getTurn: async () => null,
        getReceipt: async () => null,
        readEvents: store.reader(),
      },
    });
    const app = createApiApp({
      authMode: "api-key",
      keyStore: {
        async findOwner() {
          return valid ? OWNER : null;
        },
      },
      registerRoutes: (router) => {
        registerEventRoutes(router, service, {
          wakeup,
          keepaliveMs: 30,
          logger: { info() {}, warn() {} },
        });
      },
    });
    const response = await open(app, { Authorization: "Bearer csp_test" });
    expect(response.status).toBe(200);
    const frames = new FrameReader(response);
    expect((await frames.next())?.comment).toBe("keepalive");
    valid = false;
    // The next tick re-checks the key and closes; nothing else is written.
    expect(await frames.ended()).toBe(true);
  });

  test("a revoked credential ends a stream whose writes are blocked", async () => {
    const store = new FakeStore();
    const wakeup = new FakeWakeup();
    for (let i = 1; i <= 300; i += 1) store.append(event(i));
    let valid = true;
    const service = createSessionService({
      authorization: ownerScopedPolicy,
      catalog: { profiles: {}, repositories: {} },
      inputs: {
        acceptInputAtomic: async () => {
          throw new Error("not reached");
        },
        appendInputAtomic: async () => {
          throw new Error("not reached");
        },
      },
      reader: {
        listSessions: async () => ({ items: [], next_cursor: null }),
        getSession: async () => null,
        listTurns: async () => null,
        getTurn: async () => null,
        getReceipt: async () => null,
        readEvents: store.reader(),
      },
    });
    let handle: ReturnType<typeof registerEventRoutes> | undefined;
    const app = createApiApp({
      authMode: "api-key",
      keyStore: {
        async findOwner() {
          return valid ? OWNER : null;
        },
      },
      registerRoutes: (router) => {
        handle = registerEventRoutes(router, service, {
          wakeup,
          keepaliveMs: 50,
          logger: { info() {}, warn() {} },
        });
      },
    });
    // Nobody reads the body: backpressure blocks the writes mid-page.
    const response = await open(app, { Authorization: "Bearer csp_test" });
    expect(response.status).toBe(200);
    await Bun.sleep(30);
    expect(handle?.activeStreams()).toBe(1);
    valid = false;
    for (let i = 0; i < 100 && handle?.activeStreams() !== 0; i += 1) {
      await Bun.sleep(10);
    }
    // Two keepalives at most: one for the stalled write, one for the check.
    expect(handle?.activeStreams()).toBe(0);
    await response.body?.cancel().catch(() => {});
  });

  test("releases its handle when the client disconnects", async () => {
    const { app, wakeup, handle } = harness();
    const controller = new AbortController();
    const response = await open(app, {}, { signal: controller.signal });
    const frames = new FrameReader(response);
    await wakeup.armed();
    expect(handle.activeStreams()).toBe(1);
    controller.abort();
    for (let i = 0; i < 100 && handle.activeStreams() > 0; i += 1) {
      await Bun.sleep(5);
    }
    expect(handle.activeStreams()).toBe(0);
    expect(wakeup.waiters).toHaveLength(0);
    await frames.cancel().catch(() => {});
  });

  test("answers 404 for a session of another owner", async () => {
    const { app, store } = harness();
    store.append(event(1));
    const response = await open(app, { "X-Owner-Id": "owner-b" });
    expect(response.status).toBe(404);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "NOT_FOUND",
    );
  });

  test("answers 400 for a malformed cursor before streaming", async () => {
    const { app } = harness();
    const response = await open(app, { "Last-Event-ID": "not-a-cursor" });
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "BAD_REQUEST",
    );
  });

  test("treats an empty Last-Event-ID as absent", async () => {
    const { app, store } = harness();
    store.append(event(1));
    const response = await open(app, { "Last-Event-ID": "" });
    expect(response.status).toBe(200);
    const frames = new FrameReader(response);
    expect((await frames.next())?.id).toBe("ev_1");
    await frames.cancel();
  });
});
