import { describe, expect, test } from "bun:test";
import { APIError, type SessionEvent, type WerftError } from "../index.ts";
import { apiError, fakeApi, werft } from "../testing/fake-api.ts";
import { MAX_BUFFERED_EVENTS } from "./stream.ts";

function frame(id: string, event: string, data: unknown): string {
  const envelope = {
    schema_version: 1,
    session_id: "s1",
    occurred_at: "2026-10-21T00:00:00.000Z",
    turn_id: "t1",
    attempt_id: null,
    data,
  };
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/**
 * An SSE body; with `open` it stays open, as a live stream does, until the
 * request aborts.
 */
function sse(text: string, open?: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      if (!open) return controller.close();
      open.addEventListener("abort", () => controller.error(open.reason), {
        once: true,
      });
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("events.stream", () => {
  test("delivers events with snake_case envelope fields and resumes with Last-Event-ID", async () => {
    let connection = 0;
    const api = fakeApi(({ signal }) =>
      ++connection === 1
        ? sse(frame("e1", "status", { phase: "running" }))
        : sse(frame("e2", "result", { subtype: "success" }), signal),
    );
    const stream = werft(api.fetch).sessions.events.stream("s1", {
      lastEventId: "e0",
    });
    const events: SessionEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (events.length === 2) stream.close();
    }
    expect(events.map((e) => [e.id, e.kind, e.turn_id])).toEqual([
      ["e1", "status", "t1"],
      ["e2", "result", "t1"],
    ]);
    expect(events[0]?.payload).toEqual({ phase: "running" });
    expect(stream.lastEventId).toBe("e2");
    expect(api.seen.map((r) => r.headers.get("last-event-id"))).toEqual([
      "e0",
      "e1",
    ]);
    expect(api.seen[0]?.headers.get("authorization")).toBe("Bearer test-key");
  });

  test("throws the error a stream does not recover from", async () => {
    const api = fakeApi(() => apiError(403, "FORBIDDEN"));
    const stream = werft(api.fetch).sessions.events.stream("s1");
    const error = await (async () => {
      for await (const _ of stream) {
      }
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).code).toBe("FORBIDDEN");
  });

  test("a reader too far behind gets every buffered event, then STREAM_OVERFLOW to resume from", async () => {
    const total = MAX_BUFFERED_EVENTS + 5;
    let text = "";
    for (let i = 1; i <= total; i++) text += frame(`e${i}`, "status", {});
    const api = fakeApi(({ signal }) => sse(text, signal));
    const stream = werft(api.fetch).sessions.events.stream("s1");
    const ids: string[] = [];
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (!first.done) ids.push(first.value.id);
    // Let the rest of the body arrive while this reader does nothing.
    await Bun.sleep(200);
    const error = await (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done) return undefined;
        ids.push(next.value.id);
      }
    })().catch((e: unknown) => e);
    expect((error as WerftError).code).toBe("STREAM_OVERFLOW");
    // A gap-free prefix, so resuming from lastEventId loses nothing.
    expect(ids.length).toBeGreaterThanOrEqual(MAX_BUFFERED_EVENTS);
    expect(ids.length).toBeLessThan(total);
    expect(ids).toEqual(ids.map((_, i) => `e${i + 1}`));
    expect(stream.lastEventId).toBe(ids.at(-1) ?? "");
  });

  test("ends quietly on the caller's signal", async () => {
    const controller = new AbortController();
    const api = fakeApi(({ signal }) => sse(frame("e1", "status", {}), signal));
    const stream = werft(api.fetch).sessions.events.stream("s1", {
      signal: controller.signal,
    });
    const seen: string[] = [];
    for await (const event of stream) {
      seen.push(event.id);
      controller.abort();
    }
    expect(seen).toEqual(["e1"]);
  });
});
