import { expect, test } from "bun:test";
import {
  apiError,
  json,
  runSample,
  type Seen,
} from "../../testing/sample-server.ts";

const SAMPLE = `${import.meta.dir}/push.ts`;
const SESSION = "fake-session";
const AGENT = "Bearer sample-agent-key";
const APPROVER = "Bearer sample-approver-key";
const COMMANDS = [
  'echo "written by the SDK push sample" > sdk-sample.txt',
  'git add sdk-sample.txt && git commit -m "Add sdk-sample.txt"',
];

type Outcome = "pushed" | "no_push_credential" | "push_failed";

function fakePush(outcome: Outcome) {
  const answered = new Set<string>();
  const pushes: Record<string, unknown>[] = [];
  let pullRequest = false;
  const pushed = outcome === "pushed";

  const route = ({ method, path, headers, body }: Seen) => {
    const auth = headers.get("authorization");
    const approverOnly = /\/(answers|decision|pull-request(\/comments)?)$/.test(
      path,
    );
    if (approverOnly) expect(auth).toBe(APPROVER);
    if (method === "POST" && path === "/v1/sessions") {
      expect(auth).toBe(AGENT);
      expect(body).toMatchObject({ agent_release_id: "sha256:fake-release" });
      return json({ session_id: SESSION, turn_id: "1", status: "queued" }, 201);
    }
    if (path.endsWith("/pending-requests")) {
      const next = COMMANDS.findIndex((_, i) => !answered.has(`req-${i + 1}`));
      return json({
        items:
          next < 0
            ? []
            : [
                {
                  request_id: `req-${next + 1}`,
                  turn_id: "1",
                  kind: "permission",
                  tool: "Bash",
                  input: { command: COMMANDS[next] },
                  created_at: `2026-10-29T00:00:0${next}Z`,
                },
              ],
        answerable: true,
      });
    }
    if (method === "POST" && path.endsWith("/answers")) {
      expect(body).toMatchObject({ decision: "allow" });
      answered.add((body as { request_id: string }).request_id);
      return json(
        { receipt_id: "answer-receipt", receipt_status: "accepted" },
        202,
      );
    }
    if (path.endsWith("/turns/1")) {
      const done = answered.size === COMMANDS.length;
      return json({
        turn_id: "1",
        status: done ? "completed" : "running",
        ended_at: done ? "2026-10-29T00:01:00Z" : null,
      });
    }
    if (method === "POST" && path.endsWith("/push-requests")) {
      expect(auth).toBe(AGENT);
      const push = {
        id: `push-${pushes.length + 1}`,
        state: "requested",
        git_commit: "c0ffee0123456789abcdef0123456789abcdef01",
        target_branch: `agent/${SESSION}`,
        checkpoint_revision: 1,
        decision_reason: null,
        push_receipt_id: null,
      };
      pushes.unshift(push);
      return json(push, 201);
    }
    const id = path.match(/\/push-requests\/([\w-]+)/)?.[1];
    const push = pushes.find((p) => p.id === id);
    if (path.endsWith("/decision") && push) {
      const { decision, reason } = body as {
        decision: string;
        reason?: string;
      };
      if (push.state !== "requested")
        return apiError(409, "PUSH_REQUEST_DECIDED");
      Object.assign(
        push,
        decision === "approve"
          ? { state: "approved" }
          : { state: "rejected", decision_reason: reason },
      );
      return json(push);
    }
    if (path.endsWith("/pull-request/comments"))
      return !pushed
        ? apiError(409, "PUSH_NOT_PUSHED", { refusal: "not_pushed" })
        : pullRequest
          ? json({
              comment_id: 11,
              created: true,
              url: "https://github.com/acme/app/pull/7#c11",
            })
          : apiError(409, "PULL_REQUEST_MISSING", {
              refusal: "no_pull_request",
            });
    if (path.endsWith("/pull-request")) {
      if (!pushed)
        return apiError(409, "PUSH_NOT_PUSHED", { refusal: "not_pushed" });
      pullRequest = true;
      return json(
        { number: 7, url: "https://github.com/acme/app/pull/7", created: true },
        201,
      );
    }
    if (method === "GET" && push) {
      if (push.state === "approved")
        Object.assign(push, {
          state: pushed ? "pushed" : "failed",
          push_receipt_id: "push-receipt",
        });
      return json(push);
    }
    if (path.endsWith("/push-requests")) return json({ items: pushes });
    if (path === "/v1/receipts/push-receipt")
      return json(
        pushed
          ? {
              status: "succeeded",
              operation: "push",
              result: { remote_ref: `refs/heads/agent/${SESSION}` },
            }
          : {
              status: "failed",
              operation: "push",
              result: { refusal: outcome },
            },
      );
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
  return route;
}

const env = {
  WERFT_APPROVER_API_KEY: "sample-approver-key",
  WERFT_AGENT_RELEASE_ID: "sha256:fake-release",
};

test("pushes the approved commit and opens a pull request on GitHub", async () => {
  const { exit, stdout, stderr } = await runSample(
    SAMPLE,
    fakePush("pushed"),
    env,
  );
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  for (const line of [
    `permission req-1: allow "${COMMANDS[0]}"`,
    `permission req-2: allow "${COMMANDS[1]}"`,
    "push push-1: requested, c0ffee012345 -> agent/fake-session (checkpoint 1)",
    'push push-1: rejected, c0ffee012345 -> agent/fake-session (checkpoint 1), reason "review the diff first"',
    "approve after the reject: 409 PUSH_REQUEST_DECIDED",
    "push push-2: pushed",
    "push receipt: succeeded, refs/heads/agent/fake-session",
    "push requests: pushed, rejected",
    "comment before a pull request: 409 PULL_REQUEST_MISSING no_pull_request",
    "https://github.com/acme/app/pull/7",
    "close: receipt succeeded",
  ])
    expect(stdout).toContain(line);
}, 20_000);

test("a repository with no push credential ends the push and refuses the pull request", async () => {
  const { exit, stdout, stderr } = await runSample(
    SAMPLE,
    fakePush("no_push_credential"),
    env,
  );
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("push receipt: failed, no_push_credential");
  expect(stdout).toContain("pull request: 409 PUSH_NOT_PUSHED not_pushed");
}, 20_000);

test("any other failed push fails the sample", async () => {
  const { exit, stderr } = await runSample(
    SAMPLE,
    fakePush("push_failed"),
    env,
  );
  expect(exit).toBe(1);
  expect(stderr).toContain("push failed: push_failed");
}, 20_000);
