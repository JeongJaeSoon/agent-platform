import { expect, test } from "bun:test";
import {
  apiError,
  json,
  runSample,
  type Seen,
} from "../../testing/sample-server.ts";

const SAMPLE = `${import.meta.dir}/reliability.ts`;

/** Stores each keyed command's answer and replays it, as the API does. */
function fakeApi(options: { replay: boolean }) {
  const stored = new Map<
    string,
    { body: string; response: unknown; status: number }
  >();
  const turns: string[] = [];
  let sessions = 0;
  const keyed = (
    request: Seen,
    run: () => { response: unknown; status: number },
  ) => {
    const key = request.headers.get("idempotency-key") ?? "";
    const body = JSON.stringify(request.body);
    const hit = options.replay ? stored.get(key) : undefined;
    if (hit && hit.body !== body) return apiError(409, "IDEMPOTENCY_CONFLICT");
    const answer = hit ?? { body, ...run() };
    stored.set(key, answer);
    return json(answer.response, answer.status);
  };
  return (request: Seen) => {
    const { method, path } = request;
    expect(request.headers.get("x-werft-sample")).toBe("sdk-reliability");
    if (method === "POST" && path === "/v1/sessions")
      return keyed(request, () => {
        turns.push("1");
        return {
          response: {
            session_id: `session-${++sessions}`,
            turn_id: "1",
            status: "queued",
          },
          status: 201,
        };
      });
    if (method === "POST" && path.endsWith("/messages"))
      return keyed(request, () => {
        turns.push(String(turns.length + 1));
        return {
          response: { turn_id: String(turns.length), status: "queued" },
          status: 202,
        };
      });
    if (method === "POST" && path.endsWith("/close"))
      return json(
        { receipt_id: "close-receipt", receipt_status: "accepted" },
        202,
      );
    if (path === "/v1/receipts/close-receipt")
      return json({ status: "succeeded", operation: "close", result: null });
    if (path.endsWith("/turns"))
      return json({
        items: turns.map((turn_id) => ({ turn_id, status: "completed" })),
        next_cursor: null,
      });
    const turn = path.match(/\/turns\/(\w+)$/)?.[1];
    if (turn)
      return json({
        turn_id: turn,
        status: "completed",
        ended_at: "2026-10-29T00:00:00Z",
      });
    if (method === "GET" && path.startsWith("/v1/sessions/"))
      return json({ revision: 3, admission_state: "active", status: "idle" });
    return apiError(404, "NOT_FOUND");
  };
}

test("replays keyed commands, keeps keys on failures and names each failure", async () => {
  const { exit, stdout, stderr, seen } = await runSample(
    SAMPLE,
    fakeApi({ replay: true }),
  );
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  for (const line of [
    "create twice with one key: same session session-1",
    "same key, other body: 409 IDEMPOTENCY_CONFLICT, retryable false, request id present, error key is ours",
    "lost response: 2 attempts, 1 key, turn 2",
    "timeout: TimeoutError TIMEOUT, attempts 1, key kept",
    "resent with the saved key: turn 3, again: turn 3",
    "turns: 1, 2, 3",
    "no listener: ConnectionError NETWORK_ERROR, attempts 2",
    'aborted: AbortError ABORTED, cause "cancelled by the operator"',
    "reserved header: headers cannot set Idempotency-Key",
    "close: receipt succeeded",
  ])
    expect(stdout).toContain(line);
  const sends = seen.filter((r) => r.path.endsWith("/messages"));
  // Two tries for the lost response, then the resend and its repeat; the
  // timed-out attempt never reached the server.
  expect(sends).toHaveLength(4);
  expect(sends[0]?.headers.get("idempotency-key")).toBe(
    sends[1]?.headers.get("idempotency-key") ?? "",
  );
});

test("fails when the server runs a repeated command twice", async () => {
  const { exit, stderr } = await runSample(SAMPLE, fakeApi({ replay: false }));
  expect(exit).toBe(1);
  expect(stderr).toContain("the repeat made a second session");
});
