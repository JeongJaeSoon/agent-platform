import { describe, expect, test } from "bun:test";

import { pushReceiptResultSchema, pushRequestSchema } from "./push-request.ts";

const COMMIT = "a".repeat(40);
const ACTOR = {
  principal: { kind: "api_key", id: "key-1" },
  actor_user_id: null,
  agent_id: null,
};
const OLD_SERVER = {
  id: "019a0000-0000-7000-8000-000000000201",
  session_id: "019a0000-0000-7000-8000-000000000202",
  repository_id: "sample-app",
  checkpoint_revision: 1,
  git_commit: COMMIT,
  target_branch: "agent/019a0000-0000-7000-8000-000000000202",
  state: "approved",
  requested_by: ACTOR,
  requested_at: "2026-11-01T00:00:00.000Z",
  decided_by: ACTOR,
  decided_at: "2026-11-01T00:01:00.000Z",
  decision_reason: null,
  request_receipt_id: "019a0000-0000-7000-8000-000000000203",
  decision_receipt_id: "019a0000-0000-7000-8000-000000000204",
  finished_at: null,
  push_receipt_id: null,
};

describe("push request names during the rename", () => {
  test("a response from a server without the resolution fields still parses", () => {
    expect(pushRequestSchema.safeParse(OLD_SERVER).success).toBe(true);
    expect(
      pushRequestSchema.safeParse({
        ...OLD_SERVER,
        resolved_by: ACTOR,
        resolved_at: OLD_SERVER.decided_at,
        resolution_reason: null,
        resolution_receipt_id: OLD_SERVER.decision_receipt_id,
      }).success,
    ).toBe(true);
  });

  test("a receipt result with the old or the new names parses", () => {
    const result = {
      push_request_id: OLD_SERVER.id,
      verdict: "refuse",
      repository_id: "sample-app",
      checkpoint_revision: 1,
      git_commit: COMMIT,
      target_branch: OLD_SERVER.target_branch,
    };
    for (const names of [
      { decision: "reject", refusal: "already_decided" },
      { action: "reject", refusal: "already_resolved" },
    ]) {
      expect(
        pushReceiptResultSchema.safeParse({ ...result, ...names }).success,
      ).toBe(true);
    }
  });
});
