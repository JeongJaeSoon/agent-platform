import { expect, test } from "bun:test";
import {
  apiError,
  frame,
  json,
  runSample,
  type Seen,
  sse,
} from "../../testing/sample-server.ts";

const SAMPLE = `${import.meta.dir}/events.ts`;
const SESSION = "fake-session";

const FIRST = [
  frame("e1", "status", "1", { status: "running" }),
  frame("e2", "assistant", "1", { text: "first turn" }),
  frame("e3", "result", "1", { subtype: "success" }),
];
const SECOND = [
  frame("e4", "status", "2", { status: "running" }),
  frame("e5", "result", "2", { subtype: "success" }),
];

function fakeEvents(options: { honourCursor: boolean }) {
  let turn1Reads = 0;
  return (request: Seen) => {
    const { method, path } = request;
    if (method === "POST" && path === "/v1/sessions") {
      expect(request.body).toMatchObject({
        agent_release_id: "sha256:fake-release",
      });
      return json({ session_id: SESSION, turn_id: "1", status: "queued" }, 201);
    }
    if (path === `/v1/sessions/${SESSION}/events`) {
      const after = options.honourCursor
        ? request.headers.get("last-event-id")
        : null;
      if (after === "e3") return sse(SECOND, request);
      if (after === "e5") return sse([], request);
      return sse([...FIRST, ...(options.honourCursor ? [] : SECOND)], request);
    }
    if (path.endsWith("/events")) return apiError(404, "NOT_FOUND");
    if (method === "POST" && path.endsWith("/messages"))
      return json({ turn_id: "2", status: "queued" }, 202);
    if (path === `/v1/sessions/${SESSION}/turns/1`)
      return json(
        ++turn1Reads === 1
          ? { turn_id: "1", status: "running", ended_at: null }
          : {
              turn_id: "1",
              status: "completed",
              ended_at: "2026-10-29T00:00:00Z",
            },
      );
    if (path === `/v1/sessions/${SESSION}/turns/2`)
      return json({
        turn_id: "2",
        status: "completed",
        ended_at: "2026-10-29T00:00:00Z",
      });
    if (path === `/v1/sessions/${SESSION}/turns`) {
      const all = [
        { turn_id: "1", status: "completed" },
        { turn_id: "2", status: "completed" },
      ];
      if (request.url.searchParams.get("limit") !== "1")
        return json({ items: all, next_cursor: null });
      const at = Number(request.url.searchParams.get("cursor") ?? 0);
      return json({
        items: all.slice(at, at + 1),
        next_cursor: at === 0 ? "1" : null,
      });
    }
    if (path.endsWith("/close"))
      return json(
        { receipt_id: "close-receipt", receipt_status: "accepted" },
        202,
      );
    if (path === "/v1/receipts/close-receipt")
      return json({ status: "succeeded", operation: "close", result: null });
    if (path === `/v1/sessions/${SESSION}`)
      return json({ revision: 2, admission_state: "active", status: "idle" });
    return apiError(404, "NOT_FOUND");
  };
}

const env = { WERFT_AGENT_RELEASE_ID: "sha256:fake-release" };

test("resumes from the saved cursor and reads turns page by page", async () => {
  const { exit, stdout, stderr, seen } = await runSample(
    SAMPLE,
    fakeEvents({ honourCursor: true }),
    env,
  );
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  for (const line of [
    "stream 1 assistant (turn 1): first turn",
    "stream 1: 3 events; turn 1 was running at its result event, then completed",
    "stream 2: 2 events after the saved cursor, none repeated",
    "stream 3: ended by its signal after 0 new events",
    "turns page 1: turn 1, page 2: turn 2, then null",
    "all turns: 1:completed, 2:completed",
    "stream of an unknown session: 404 NOT_FOUND",
    "close: receipt succeeded",
  ])
    expect(stdout).toContain(line);
  const cursors = seen
    .filter((r) => r.path === `/v1/sessions/${SESSION}/events`)
    .map((r) => r.headers.get("last-event-id"));
  expect(cursors).toEqual([null, "e3", "e5"]);
}, 15_000);

test("fails when a resumed stream repeats an event", async () => {
  const { exit, stderr } = await runSample(
    SAMPLE,
    fakeEvents({ honourCursor: false }),
    env,
  );
  expect(exit).toBe(1);
  expect(stderr).toContain("stream 2 repeated e1");
}, 15_000);
