import { expect, test } from "bun:test";
import {
  apiError,
  json,
  runSample,
  type Seen,
} from "../../testing/sample-server.ts";

const SAMPLE = `${import.meta.dir}/close-drain.ts`;
const SESSION = "fake-session";

const QUESTION = {
  request_id: "req-1",
  turn_id: "1",
  kind: "question",
  created_at: "2026-10-29T00:00:01Z",
  expires_at: "2026-10-29T00:30:01Z",
  questions: [
    {
      question_id: "q-1",
      prompt: "Ship the release notes now?",
      options: [
        { option_id: "opt-yes", label: "yes" },
        { option_id: "opt-no", label: "no" },
      ],
      multi_select: false,
      allow_free_text: false,
    },
  ],
};

function fakeClose(options: { receipt: "succeeded" | "failed" }) {
  let closing = false;
  let answered = false;
  let readsWhileClosing = 0;
  const route = ({ method, path }: Seen) => {
    if (method === "POST" && path === "/v1/sessions")
      return json({ session_id: SESSION, turn_id: "1", status: "queued" }, 201);
    if (method === "POST" && path.endsWith("/messages"))
      return closing
        ? apiError(409, "SESSION_CLOSING")
        : json({ turn_id: "2", status: "queued" }, 202);
    if (method === "POST" && path.endsWith("/close")) {
      closing = true;
      return json(
        { receipt_id: "close-receipt", receipt_status: "accepted" },
        202,
      );
    }
    if (path.endsWith("/pending-requests"))
      return json({ items: answered ? [] : [QUESTION], answerable: true });
    if (method === "POST" && path.endsWith("/answers")) {
      answered = true;
      return json(
        { receipt_id: "answer-receipt", receipt_status: "accepted" },
        202,
      );
    }
    if (path === "/v1/receipts/close-receipt")
      return json(
        answered
          ? {
              status: options.receipt,
              operation: "close",
              result:
                options.receipt === "succeeded"
                  ? {
                      checkpoint_revision: 0,
                      cancelled_turn_count: 1,
                      resulting_admission_state: "closed",
                    }
                  : null,
            }
          : { status: "accepted", operation: "close", result: null },
      );
    if (path.endsWith("/turns/2"))
      return json({ turn_id: "2", status: answered ? "cancelled" : "queued" });
    if (path === `/v1/sessions/${SESSION}`) {
      if (!closing)
        return json({
          revision: 1,
          admission_state: "active",
          status: "needs_input",
          attention: null,
        });
      if (answered)
        return json({
          revision: 2,
          admission_state: "closed",
          status: "stopped",
          attention: null,
        });
      return json({
        revision: 2,
        admission_state: "closing",
        status: "needs_input",
        attention:
          ++readsWhileClosing > 1
            ? { code: "CLOSE_BLOCKED", reason: "pending_request" }
            : null,
      });
    }
    return apiError(404, "NOT_FOUND");
  };
  return route;
}

test("a close waits on an open question, says so, and ends once it is answered", async () => {
  const { exit, stdout, stderr, seen } = await runSample(
    SAMPLE,
    fakeClose({ receipt: "succeeded" }),
  );
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  for (const line of [
    "turn 1: waiting on a question, turn 2 queued",
    "close: receipt accepted, admission closing (closing: true)",
    "message while closing: 409 SESSION_CLOSING",
    "attention: CLOSE_BLOCKED",
    'question req-1: "Ship the release notes now?" -> no',
    "cancelled_turn_count: 1",
    "session: admission closed, status stopped, attention none; turn 2 cancelled",
  ])
    expect(stdout).toContain(line);
  expect(seen.find((r) => r.path.endsWith("/close"))?.body).toEqual({
    expected_revision: 1,
    reason: "close sample",
  });
  expect(seen.find((r) => r.path.endsWith("/answers"))?.body).toEqual({
    request_id: "req-1",
    kind: "question",
    answers: [{ question_id: "q-1", selected_option_ids: ["opt-no"] }],
  });
}, 20_000);

test("fails when the close receipt fails", async () => {
  const { exit, stderr } = await runSample(
    SAMPLE,
    fakeClose({ receipt: "failed" }),
  );
  expect(exit).toBe(1);
  expect(stderr).toContain("close did not succeed");
}, 20_000);
