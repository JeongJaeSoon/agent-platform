import { expect, test } from "bun:test";
import {
  apiError,
  json,
  runSample,
  type Seen,
} from "../../testing/sample-server.ts";

const SAMPLE = `${import.meta.dir}/inventory.ts`;

function fakeInventory(options: { dropFromListing?: boolean } = {}) {
  const sessions: { id: string; title: string; closed: boolean }[] = [];
  const summary = (s: (typeof sessions)[number]) => ({
    id: s.id,
    title: s.title,
    status: "idle",
  });
  return ({ method, path, url, body }: Seen) => {
    if (method === "POST" && path === "/v1/sessions") {
      const { title } = body as { title: string };
      const id = `session-${sessions.length + 1}`;
      sessions.push({ id, title, closed: false });
      return json(
        { session_id: id, turn_id: "1", status: "queued", receipt_id: "r" },
        201,
      );
    }
    if (method === "GET" && path === "/v1/sessions") {
      const q = url.searchParams.get("q") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const matching = sessions
        .filter((s) => s.title.includes(q))
        .slice(options.dropFromListing ? 1 : 0);
      const items = matching.slice(start, start + limit).map(summary);
      const next =
        start + limit < matching.length ? String(start + limit) : null;
      return json({ items, next_cursor: next });
    }
    const [, , , id, rest, turn] = path.split("/");
    const session = sessions.find((s) => s.id === id);
    if (!session) return apiError(404, "NOT_FOUND");
    if (rest === "turns" && turn)
      return json({
        turn_id: turn,
        status: "completed",
        ended_at: "2026-10-29T00:00:00Z",
      });
    if (rest === "usage")
      return json({
        cost: { kind: "estimated", amount_usd: "0.000042", complete: true },
        token_count: 5,
        queued_input_count: 0,
        queued_input_limit: 20,
      });
    if (rest === "share") return json({ scope: "workspace", revision: 0 });
    if (rest === "close") {
      session.closed = true;
      return json(
        { receipt_id: `close-${id}`, receipt_status: "accepted" },
        202,
      );
    }
    if (rest === undefined)
      return json({
        ...summary(session),
        revision: 1,
        admission_state: session.closed ? "closed" : "active",
        runtime: { model: "claude-sonnet-5" },
        repository: { full_name: "agent/sample-app" },
      });
    return apiError(404, "NOT_FOUND");
  };
}

function withReceipts(route: (request: Seen) => Response) {
  return (request: Seen) =>
    request.path.startsWith("/v1/receipts/")
      ? json({ status: "succeeded", operation: "close", result: null })
      : route(request);
}

test("pages, walks and filters this run's sessions, then closes them", async () => {
  const { exit, stdout, stderr, seen } = await runSample(
    SAMPLE,
    withReceipts(fakeInventory()),
  );
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  for (const line of [
    "limit=2: 2 item(s), more after it",
    "page 2: 1 item(s), last page",
    "page 3: null",
    "for await, relation=started limit=1: 3 sessions",
    "status=idle: 3 sessions",
    "usage: estimated $0.000042 (complete true), 5 tokens, 0/20 queued",
    "share: workspace, revision 0",
    "3 sessions: closed",
  ])
    expect(stdout).toContain(line);
  const listed = seen.filter(
    (r) => r.method === "GET" && r.path === "/v1/sessions",
  );
  expect(listed.map((r) => r.url.searchParams.get("relation"))).toContain(
    "started",
  );
  expect(listed.map((r) => r.url.searchParams.get("status"))).toContain("idle");
  expect(seen.filter((r) => r.path.endsWith("/close"))).toHaveLength(3);
});

test("fails when the listing misses one of the sessions it made", async () => {
  const { exit, stderr } = await runSample(
    SAMPLE,
    withReceipts(fakeInventory({ dropFromListing: true })),
  );
  expect(exit).toBe(1);
  expect(stderr).toContain("expected a second page");
});
