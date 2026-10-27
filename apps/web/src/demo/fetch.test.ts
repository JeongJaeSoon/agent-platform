import { describe, expect, test } from "bun:test";
import { isApiError, unwrap } from "@werft-ai/client";
import { createApiClient } from "../api/client.ts";
import { errorKey } from "../i18n/i18n.tsx";
import {
  createDemoFetch,
  DEMO_READ_ONLY,
  type DemoFixtures,
  fixtureKey,
  shiftTimes,
} from "./fetch.ts";

const RECORDED = "2026-10-27T12:00:00.000Z";
const DAY = 86_400_000;

const fixtures: DemoFixtures = {
  recorded_at: RECORDED,
  responses: {
    "/v1/teams": { status: 200, json: { items: [{ id: "t1" }] } },
    "/v1/usage?days=7&scope=me": { status: 200, json: { days: 7 } },
    "/v1/usage?days=30&scope=me": { status: 200, json: { days: 30 } },
    "/v1/keys": {
      status: 200,
      json: { expires_at: "2026-10-30T12:00:00.000Z", day: "2026-10-27" },
    },
    "/v1/sessions/s1/events": {
      status: 200,
      sse: "id: 1\ndata: {}\n\nid: 2\ndata: {}\n\nid: 3\ndata: {}\n\n",
    },
  },
};

const at = (time: number) => () => time;

describe("demo fetch", () => {
  test("a GET answers from the recording through the real client", async () => {
    const client = createApiClient({
      baseUrl: "https://demo.example.test",
      fetch: createDemoFetch(fixtures),
    });

    const data = await unwrap(client.GET("/v1/teams", {}));

    expect(data).toEqual({ items: [{ id: "t1" }] } as never);
  });

  test("a write is refused with DEMO_READ_ONLY, reported, and has its own copy", async () => {
    const writes: string[] = [];
    const client = createApiClient({
      baseUrl: "https://demo.example.test",
      fetch: createDemoFetch(fixtures, {
        onWrite: (method, path) => writes.push(`${method} ${path}`),
      }),
    });

    const error = await unwrap(
      client.POST("/v1/teams", { body: { name: "x" } as never }),
    ).catch((caught: unknown) => caught);

    expect(isApiError(error, DEMO_READ_ONLY)).toBe(true);
    expect(writes).toEqual(["POST /v1/teams"]);
    expect(errorKey(DEMO_READ_ONLY)).toBe("error.DEMO_READ_ONLY");
  });

  test("query order does not matter, and an unrecorded query takes the closest recording", async () => {
    const demoFetch = createDemoFetch(fixtures, {
      now: at(Date.parse(RECORDED)),
    });

    const reordered = await demoFetch(
      "https://d.test/v1/usage?scope=me&days=30",
    );
    const other = await demoFetch(
      "https://d.test/v1/usage?days=30&scope=installation",
    );
    const missing = await demoFetch("https://d.test/v1/nothing");

    expect(await reordered.json()).toEqual({ days: 30 });
    expect(await other.json()).toEqual({ days: 30 });
    expect(missing.status).toBe(404);
    expect(fixtureKey(new URL("https://d.test/a?b=2&a=1"))).toBe("/a?a=1&b=2");
  });

  test("timestamps move forward by the time since the recording", async () => {
    const demoFetch = createDemoFetch(fixtures, {
      now: at(Date.parse(RECORDED) + 10 * DAY),
    });

    const body = await (await demoFetch("https://d.test/v1/keys")).json();

    expect(body).toEqual({
      expires_at: "2026-11-09T12:00:00.000Z",
      day: "2026-11-06",
    });
    expect(shiftTimes('"2026-10-27T00:00:00+09:00"', DAY)).toBe(
      '"2026-10-27T15:00:00.000Z"',
    );
    expect(shiftTimes('"not-2026-10-27"', DAY)).toBe('"not-2026-10-27"');
  });

  test("a stream replays after Last-Event-ID, stays open, and ends on abort", async () => {
    const demoFetch = createDemoFetch(fixtures);
    const stop = new AbortController();

    const response = await demoFetch("https://d.test/v1/sessions/s1/events", {
      headers: { "last-event-id": "1" },
      signal: stop.signal,
    });
    const reader = response.body?.getReader();
    const first = await reader?.read();
    const pending = reader?.read();
    stop.abort();

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(new TextDecoder().decode(first?.value)).toBe(
      "id: 2\ndata: {}\n\nid: 3\ndata: {}\n\n",
    );
    await expect(pending).rejects.toBeDefined();
  });
});
