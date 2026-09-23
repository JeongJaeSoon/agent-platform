import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createLogger, MemoryLogSink } from "@agent-platform/observability";
import type { Client } from "pg";
import {
  PostgresSessionNotifier,
  SESSION_EVENTS_CHANNEL,
} from "./notifications.ts";

// Enough of pg.Client for LISTEN: connect, one query, events, end.
class FakeClient extends EventEmitter {
  queries: string[] = [];
  ended = false;
  constructor(private readonly failConnect = false) {
    super();
  }
  async connect() {
    if (this.failConnect) throw new Error("ECONNREFUSED");
  }
  async query(text: string) {
    this.queries.push(text);
    return { rows: [] };
  }
  async end() {
    this.ended = true;
  }
  notify(payload: string, channel = SESSION_EVENTS_CHANNEL) {
    this.emit("notification", { channel, payload, processId: 1 });
  }
}

function notifier(clients: FakeClient[], reconnectDelayMs = 10) {
  let index = 0;
  const sink = new MemoryLogSink();
  const instance = new PostgresSessionNotifier(
    "postgresql://unused",
    createLogger({ sinks: [sink], level: "debug" }),
    {
      reconnectDelayMs,
      connect: () => {
        const client = clients[index] ?? clients[clients.length - 1];
        index += 1;
        if (!client) throw new Error("no client");
        return client as unknown as Client;
      },
    },
  );
  return { instance, sink };
}

async function settled(promise: Promise<void>, withinMs = 200) {
  const result = await Promise.race([
    promise.then(() => "settled" as const),
    Bun.sleep(withinMs).then(() => "pending" as const),
  ]);
  return result === "settled";
}

describe("PostgresSessionNotifier", () => {
  test("LISTENs on one connection and wakes only the notified session", async () => {
    const client = new FakeClient();
    const { instance } = notifier([client]);
    await instance.start();
    expect(client.queries).toEqual([`LISTEN ${SESSION_EVENTS_CHANNEL}`]);
    expect(instance.listening).toBe(true);

    const a = instance.wait("session-a", new AbortController().signal);
    const b = instance.wait("session-b", new AbortController().signal);
    client.notify("session-a");
    expect(await settled(a)).toBe(true);
    expect(await settled(b, 30)).toBe(false);
    client.notify("session-b", "other_channel");
    expect(await settled(b, 30)).toBe(false);
    await instance.close();
    expect(await settled(b)).toBe(true);
    expect(client.ended).toBe(true);
  });

  test("an aborted wait leaves no waiter behind", async () => {
    const client = new FakeClient();
    const { instance } = notifier([client]);
    await instance.start();
    const controller = new AbortController();
    const waiting = instance.wait("session-a", controller.signal);
    controller.abort();
    expect(await settled(waiting)).toBe(true);
    // A later NOTIFY has nothing to resolve; nothing throws.
    client.notify("session-a");
    await instance.close();
  });

  test("reconnects after a drop and wakes waiters once listening again", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const { instance, sink } = notifier([first, second]);
    await instance.start();
    const waiting = instance.wait("session-a", new AbortController().signal);
    first.emit("error", new Error("server closed the connection"));
    expect(instance.listening).toBe(false);
    // Down is not "resolve at once" (that would make idle streams hot-poll);
    // the waiter is released by the reconnect, so it re-reads what the gap
    // may have hidden.
    expect(await settled(waiting, 5)).toBe(false);
    for (let i = 0; i < 50 && !instance.listening; i += 1) await Bun.sleep(5);
    expect(instance.listening).toBe(true);
    expect(await settled(waiting)).toBe(true);
    expect(second.queries).toEqual([`LISTEN ${SESSION_EVENTS_CHANNEL}`]);
    expect(first.ended).toBe(true);
    expect(
      sink.records.some((record) =>
        record.message.includes("disconnected; reconnecting"),
      ),
    ).toBe(true);
    await instance.close();
  });

  test("retries a failed first connection in the background", async () => {
    const failing = new FakeClient(true);
    const healthy = new FakeClient();
    const { instance } = notifier([failing, healthy]);
    await instance.start();
    expect(instance.listening).toBe(false);
    for (let i = 0; i < 50 && !instance.listening; i += 1) await Bun.sleep(5);
    expect(instance.listening).toBe(true);
    await instance.close();
  });

  test("close stops the reconnect loop", async () => {
    const failing = new FakeClient(true);
    const { instance } = notifier([failing], 5);
    await instance.start();
    await instance.close();
    await Bun.sleep(30);
    expect(instance.listening).toBe(false);
  });
});
