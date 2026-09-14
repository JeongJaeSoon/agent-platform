import { describe, expect, test } from "bun:test";

import {
  createSessionRequestSchema,
  opaqueCursorSchema,
  postSessionAnswerRequestSchema,
  SESSION_STATUS_VALUES,
  sessionMessageSchema,
  sessionStatusSchema,
  sseEventSchema,
  unassignedSessionSignalSchema,
} from "./index.ts";

describe("session contracts", () => {
  test("keeps the database session status vocabulary", () => {
    expect(SESSION_STATUS_VALUES).toEqual([
      "queued",
      "running",
      "needs_input",
      "idle",
      "failed",
      "stopped",
    ]);
    expect(sessionStatusSchema.safeParse("idle").success).toBe(true);
    expect(sessionStatusSchema.safeParse("complete").success).toBe(false);
  });

  test("accepts only a valid create-session request", () => {
    expect(
      createSessionRequestSchema.parse({
        repo_url: "https://github.com/acme/example.git",
        base_branch: "main",
        message: "Implement the health check.",
        permission_mode: "acceptEdits",
      }),
    ).toMatchObject({ base_branch: "main", permission_mode: "acceptEdits" });
    expect(
      createSessionRequestSchema.safeParse({
        repo_url: "not a URL",
        base_branch: "",
        message: "",
      }).success,
    ).toBe(false);
  });

  test("correlates answers with a non-empty request id", () => {
    expect(
      postSessionAnswerRequestSchema.safeParse({
        request_id: "permission-01",
        answer: { allow: true },
      }).success,
    ).toBe(true);
    expect(
      postSessionAnswerRequestSchema.safeParse({
        request_id: "",
        answer: { allow: true },
      }).success,
    ).toBe(false);
    expect(
      postSessionAnswerRequestSchema.safeParse({ request_id: "q_01" }).success,
    ).toBe(false);
  });

  test("keeps the only session queue payload and an empty assignment signal", () => {
    expect(sessionMessageSchema.parse({ message: "Continue." })).toEqual({
      message: "Continue.",
    });
    expect(sessionMessageSchema.safeParse({ message: "" }).success).toBe(false);
    expect(unassignedSessionSignalSchema.parse(undefined)).toBeUndefined();
    expect(
      unassignedSessionSignalSchema.safeParse({ session_id: "leaks-payload" })
        .success,
    ).toBe(false);
  });
});

describe("SSE contracts", () => {
  test("uses opaque cursors without prescribing a backend id format", () => {
    expect(opaqueCursorSchema.parse("ev_01J8X2K4M9")).toBe("ev_01J8X2K4M9");
    expect(opaqueCursorSchema.safeParse("").success).toBe(false);
  });

  test("supports every documented event kind", () => {
    const eventData = {
      system: { type: "system" },
      assistant: { type: "assistant", message: { content: [] } },
      tool_use: { type: "assistant", message: { content: [] } },
      tool_result: { type: "tool_result" },
      question: {
        request_id: "q_01",
        kind: "permission",
        tool: "Bash",
        input: { command: "pwd" },
      },
      result: { type: "result", subtype: "success", session_id: "sdk-session" },
      status: { status: "running" },
      error: { message: "Worker disconnected" },
    } as const;

    for (const [event, data] of Object.entries(eventData)) {
      expect(
        sseEventSchema.safeParse({ id: `ev_${event}`, event, data }).success,
      ).toBe(true);
    }
  });
});
