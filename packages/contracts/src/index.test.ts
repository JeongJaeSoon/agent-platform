import { describe, expect, test } from "bun:test";

import {
  ADMISSION_STATE_VALUES,
  API_ERROR_CODE_VALUES,
  apiErrorResponseSchema,
  appendEventsRequestSchema,
  bootstrapClaimRequestSchema,
  bootstrapClaimResponseSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  finalizeRequestSchema,
  finalizeResponseSchema,
  getSessionResponseSchema,
  heartbeatRequestSchema,
  listSessionsQuerySchema,
  nextInputRequestSchema,
  opaqueCursorSchema,
  PERMISSION_MODE_VALUES,
  pendingControlRequestSchema,
  pendingControlResponseSchema,
  pendingRequestSchema,
  postSessionAnswerRequestSchema,
  postSessionMessageRequestSchema,
  RECEIPT_STATUS_VALUES,
  receiptSchema,
  recoveryDecisionRequestSchema,
  releaseRequestSchema,
  SESSION_EVENT_NAMES,
  SESSION_STATUS_VALUES,
  sessionEventSchema,
  sessionMessageSchema,
  sessionStatusSchema,
  sseEventSchema,
  TURN_STATUS_VALUES,
  unassignedSessionSignalSchema,
  workerScopeSchema,
} from "./index.ts";

const SESSION_ID = "019a0000-0000-7000-8000-000000000001";
const RECEIPT_ID = "019a0000-0000-7000-8000-000000000002";
const AT = "2026-09-18T01:00:00Z";

describe("session contracts", () => {
  test("keeps the status projection and admission vocabularies separate", () => {
    expect(SESSION_STATUS_VALUES).toEqual([
      "queued",
      "running",
      "needs_input",
      "idle",
      "failed",
      "stopped",
    ]);
    expect(ADMISSION_STATE_VALUES).toEqual([
      "active",
      "pausing",
      "paused",
      "resuming",
      "stopping",
      "stopped",
      "recovery_required",
      "closed",
    ]);
    expect(TURN_STATUS_VALUES).toContain("outcome_unknown");
    expect(TURN_STATUS_VALUES).not.toContain("done");
    expect(sessionStatusSchema.safeParse("complete").success).toBe(false);
    expect(PERMISSION_MODE_VALUES).not.toContain("bypassPermissions");
  });

  test("accepts the api.md create example and rejects the legacy shape", () => {
    expect(
      createSessionRequestSchema.safeParse({
        profile_id: "claude-coding-v1",
        repository_id: "sample-app",
        message: "Inspect the failing unit test and propose a fix.",
      }).success,
    ).toBe(true);
    expect(
      createSessionRequestSchema.safeParse({
        repo_url: "https://github.com/acme/example.git",
        base_branch: "main",
        message: "Implement the health check.",
      }).success,
    ).toBe(false);
    expect(
      createSessionResponseSchema.safeParse({
        session_id: SESSION_ID,
        turn_id: "1",
        receipt_id: RECEIPT_ID,
        receipt_status: "accepted",
        status: "queued",
      }).success,
    ).toBe(true);
  });

  test("accepts the api.md detail example with durability", () => {
    const detail = getSessionResponseSchema.parse({
      id: SESSION_ID,
      revision: 12,
      admission_state: "active",
      status: "needs_input",
      runtime: {
        kind: "claude_agent_sdk",
        version: "0.3.270",
        profile_id: "claude-coding-v1",
      },
      repository_id: "sample-app",
      current_turn_id: "1",
      queued_turn_count: 1,
      last_event_at: AT,
      execution: { backend: "local_docker", state: "running", observed_at: AT },
      checkpoint_revision: 3,
      pending_request_count: 1,
      attention: null,
      durability: {
        last_transcript_persisted_at: null,
        checkpoint_committed_at: null,
        checkpoint_revision: null,
        last_completed_turn_id: null,
        last_checkpointed_turn_id: null,
        checkpoint_pending_reason: null,
      },
      created_at: AT,
      updated_at: AT,
    });
    expect(detail.execution?.backend).toBe("local_docker");
    expect(
      listSessionsQuerySchema.parse({ status: "idle", limit: "20" }),
    ).toEqual({ status: "idle", limit: 20 });
    expect(listSessionsQuerySchema.parse({}).limit).toBe(50);
    expect(listSessionsQuerySchema.safeParse({ limit: 101 }).success).toBe(
      false,
    );
  });

  test("keeps the queue message payload and the empty assignment signal", () => {
    expect(sessionMessageSchema.parse({ message: "Continue." })).toEqual({
      message: "Continue.",
    });
    expect(
      postSessionMessageRequestSchema.parse({ message: "Apply the fix." }),
    ).toEqual({ message: "Apply the fix.", mode: "enqueue" });
    expect(
      postSessionMessageRequestSchema.safeParse({
        message: "x",
        mode: "steer",
      }).success,
    ).toBe(false);
    // 32 KiB is a byte limit: 12k Hangul characters are 36 KB of UTF-8.
    expect(
      sessionMessageSchema.safeParse({ message: "가".repeat(12_000) }).success,
    ).toBe(false);
    expect(
      sessionMessageSchema.safeParse({ message: "a".repeat(32_768) }).success,
    ).toBe(true);
    expect(unassignedSessionSignalSchema.parse(undefined)).toBeUndefined();
    expect(
      unassignedSessionSignalSchema.safeParse({ session_id: "leaks" }).success,
    ).toBe(false);
  });
});

describe("receipt and error contracts", () => {
  test("uses the design status and error code vocabularies", () => {
    expect(RECEIPT_STATUS_VALUES).toEqual([
      "accepted",
      "succeeded",
      "failed",
      "unknown",
    ]);
    for (const code of [
      "IDEMPOTENCY_CONFLICT",
      "REQUEST_EXPIRED",
      "REQUEST_STALE",
      "SESSION_PAUSED",
      "SESSION_RESUMING",
      "SESSION_CLOSED",
      "SESSION_STOPPED",
      "RECOVERY_REQUIRED",
      "CHECKPOINT_UNAVAILABLE",
      "PAUSE_COMMITTING",
      "PAUSE_CANCELLED",
      "CONTROL_SUPERSEDED",
      "BACKEND_UNAVAILABLE",
      "NOT_READY",
      "CURSOR_EXPIRED",
    ]) {
      expect(API_ERROR_CODE_VALUES as readonly string[]).toContain(code);
    }
    expect(
      apiErrorResponseSchema.parse({
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "Payload differs from the first accepted request",
          retryable: false,
          request_id: "req_01",
          details: null,
        },
      }).error.code,
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      apiErrorResponseSchema.safeParse({
        error: { code: "not_found", message: "x" },
      }).success,
    ).toBe(false);
    expect(
      receiptSchema.safeParse({
        id: RECEIPT_ID,
        operation: "pause",
        target_ref: { session_id: SESSION_ID, turn_id: null, request_id: null },
        status: "failed",
        result: null,
        error: { code: "PAUSE_CANCELLED", message: "Resume cancelled pause" },
        created_at: AT,
        updated_at: AT,
      }).success,
    ).toBe(true);
  });
});

describe("answers, pending requests and control", () => {
  test("accepts api.md typed answers and rejects the legacy shape", () => {
    expect(
      postSessionAnswerRequestSchema.parse({
        request_id: "perm_01",
        kind: "permission",
        decision: "deny",
        reason: "Not in this repository",
      }).kind,
    ).toBe("permission");
    expect(
      postSessionAnswerRequestSchema.safeParse({
        request_id: "q_01",
        kind: "question",
        answers: [
          { question_id: "single", selected_option_ids: ["a"] },
          { question_id: "free", selected_option_ids: [], free_text: "typed" },
        ],
      }).success,
    ).toBe(true);
    expect(
      postSessionAnswerRequestSchema.safeParse({
        request_id: "q_02",
        kind: "question",
        answers: [
          { question_id: "dup", selected_option_ids: ["a"] },
          { question_id: "dup", selected_option_ids: ["b"] },
        ],
      }).success,
    ).toBe(false);
    expect(
      postSessionAnswerRequestSchema.safeParse({
        request_id: "q_03",
        kind: "question",
        answers: [{ question_id: "empty", selected_option_ids: [] }],
      }).success,
    ).toBe(false);
    expect(
      postSessionAnswerRequestSchema.safeParse({
        request_id: "perm_02",
        answer: { kind: "permission", behavior: "allow" },
      }).success,
    ).toBe(false);
    expect(
      postSessionAnswerRequestSchema.safeParse({
        request_id: "perm_03",
        kind: "permission",
        decision: "deny",
      }).success,
    ).toBe(false);
  });

  test("types pending requests by kind", () => {
    const base = {
      request_id: "req_01",
      turn_id: "1",
      attempt_id: "a1",
      created_at: AT,
      expires_at: AT,
    };
    expect(
      pendingRequestSchema.safeParse({
        ...base,
        kind: "permission",
        tool: "Bash",
        input: { command: "pwd" },
      }).success,
    ).toBe(true);
    expect(
      pendingRequestSchema.safeParse({
        ...base,
        kind: "question",
        questions: [
          {
            question_id: "q1",
            prompt: "Which one?",
            options: [{ option_id: "a", label: "A" }],
            multi_select: false,
            allow_free_text: true,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      pendingRequestSchema.safeParse({ ...base, kind: "question" }).success,
    ).toBe(false);
  });

  test("requires evidence for confirm_completed and a target unless closing", () => {
    const base = { expected_revision: 12, reason: "operator checked" };
    expect(
      recoveryDecisionRequestSchema.safeParse({ ...base, decision: "close" })
        .success,
    ).toBe(true);
    expect(
      recoveryDecisionRequestSchema.safeParse({ ...base, decision: "abandon" })
        .success,
    ).toBe(false);
    expect(
      recoveryDecisionRequestSchema.safeParse({
        ...base,
        decision: "confirm_completed",
        target_turn_id: "3",
      }).success,
    ).toBe(false);
    expect(
      recoveryDecisionRequestSchema.safeParse({
        ...base,
        decision: "confirm_completed",
        target_turn_id: "3",
        evidence_ref: "s3://audit/3",
      }).success,
    ).toBe(true);
  });
});

describe("event contracts", () => {
  const eventData = {
    system: { type: "system" },
    assistant: { type: "assistant", message: { content: [] } },
    tool_use: { type: "assistant", message: { content: [] } },
    tool_result: { type: "tool_result" },
    question: {
      request_id: "q_01",
      tool_use_id: "toolu_01",
      kind: "permission",
      tool: "Bash",
      input: { command: "pwd" },
    },
    result: { type: "result", subtype: "success", session_id: "sdk-session" },
    status: { phase: "running" },
    error: { message: "Worker disconnected" },
  } as const;

  test("uses opaque cursors and supports every documented event kind", () => {
    expect(opaqueCursorSchema.parse("ev_01J8X2K4M9")).toBe("ev_01J8X2K4M9");
    expect(opaqueCursorSchema.safeParse("").success).toBe(false);
    expect(Object.keys(eventData)).toEqual([...SESSION_EVENT_NAMES]);
    for (const [event, data] of Object.entries(eventData)) {
      expect(
        sessionEventSchema.safeParse({ id: `ev_${event}`, event, data })
          .success,
      ).toBe(true);
    }
  });

  test("wraps SSE frames in the versioned envelope", () => {
    const frame = sseEventSchema.parse({
      id: "ev_1",
      event: "status",
      data: {
        schema_version: 1,
        session_id: SESSION_ID,
        turn_id: "1",
        attempt_id: "a1",
        occurred_at: AT,
        data: { phase: "needs_input" },
      },
    });
    expect(Object.keys(frame.data)).toEqual([
      "schema_version",
      "session_id",
      "turn_id",
      "attempt_id",
      "occurred_at",
      "data",
    ]);
    expect(
      sseEventSchema.safeParse({
        id: "ev_1",
        event: "status",
        data: { phase: "needs_input" },
      }).success,
    ).toBe(false);
  });
});

describe("worker protocol", () => {
  const scope = {
    session_id: SESSION_ID,
    turn_id: "1",
    attempt_id: "a1",
    lease_epoch: 4,
    execution_generation: 2,
    auth_revision: 1,
  };

  test("fences every post-claim request with the same identity", () => {
    expect(workerScopeSchema.parse(scope)).toEqual(scope);
    expect(nextInputRequestSchema.safeParse(scope).success).toBe(true);
    expect(
      heartbeatRequestSchema.safeParse({ ...scope, attempt_state: "running" })
        .success,
    ).toBe(true);
    expect(
      pendingControlRequestSchema.safeParse({ ...scope, answers_after: 0 })
        .success,
    ).toBe(true);
    expect(
      pendingControlResponseSchema.parse({
        control: null,
        answers: [
          {
            sequence: 1,
            answer: {
              request_id: "perm_01",
              kind: "permission",
              decision: "allow",
            },
          },
        ],
      }).answers[0]?.sequence,
    ).toBe(1);
    expect(
      finalizeResponseSchema.safeParse({
        turn_id: "1",
        status: "running",
        checkpoint_revision: null,
      }).success,
    ).toBe(false);
    expect(
      releaseRequestSchema.safeParse({ ...scope, reason: "drain" }).success,
    ).toBe(true);
    expect(
      appendEventsRequestSchema.safeParse({
        ...scope,
        batch_key: "b1",
        events: [
          {
            source_sequence: 1,
            occurred_at: AT,
            event: "status",
            data: { phase: "running" },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      finalizeRequestSchema.safeParse({
        ...scope,
        finalize_key: "f1",
        terminal: {
          status: "completed",
          reason: null,
          result: { ok: true },
          usage: null,
        },
        checkpoint: {
          revision: 4,
          manifest_ref: "s3://bucket/manifest",
          manifest_sha256: "a".repeat(64),
        },
      }).success,
    ).toBe(true);
    expect(
      finalizeRequestSchema.safeParse({
        ...scope,
        finalize_key: "f1",
        terminal: { status: "queued", reason: null, result: null, usage: null },
        checkpoint: null,
      }).success,
    ).toBe(false);
    const { lease_epoch, ...unfenced } = scope;
    expect(lease_epoch).toBe(4);
    expect(nextInputRequestSchema.safeParse(unfenced).success).toBe(false);
  });

  test("binds bootstrap claims to a launch nonce or workload identity", () => {
    expect(
      bootstrapClaimRequestSchema.safeParse({
        execution_id: "exec_1",
        execution_generation: 2,
        credential: { kind: "launch_nonce", nonce: "one-time" },
      }).success,
    ).toBe(true);
    expect(
      bootstrapClaimResponseSchema.safeParse({
        ...scope,
        session_credential: "short-lived",
        lease_expires_at: AT,
        runtime: {
          kind: "claude_agent_sdk",
          version: "0.3.270",
          profile_id: "claude-coding-v1",
        },
        restore: null,
      }).success,
    ).toBe(true);
  });
});
