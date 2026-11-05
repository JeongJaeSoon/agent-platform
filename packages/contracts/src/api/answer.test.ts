import { describe, expect, test } from "bun:test";
import {
  type PostSessionAnswerInput,
  postSessionAnswerInputSchema,
  postSessionAnswerRequestSchema,
  storedAnswer,
} from "./answer.ts";

const base = { request_id: "perm_01", kind: "permission" } as const;

describe("a permission answer from the API", () => {
  test("action is stored as decision", () => {
    expect(
      storedAnswer(
        postSessionAnswerInputSchema.parse({
          ...base,
          action: "deny",
          reason: "no",
        }),
      ),
    ).toEqual({ ...base, decision: "deny", reason: "no" });
  });

  test("the old decision name, both names, or neither is refused", () => {
    for (const body of [
      { ...base, decision: "allow" },
      { ...base, action: "allow", decision: "allow" },
      base,
    ]) {
      expect(postSessionAnswerInputSchema.safeParse(body).success).toBe(false);
    }
  });

  test("remember keeps an allow for the session and is stored beside the decision", () => {
    const body = { ...base, action: "allow", remember: "session" };
    expect(storedAnswer(postSessionAnswerInputSchema.parse(body))).toEqual({
      ...base,
      decision: "allow",
      remember: "session",
    });
  });

  test("remember with a deny, or with another scope, is refused on both schemas", () => {
    for (const body of [
      { ...base, action: "deny", remember: "session" },
      { ...base, action: "allow", remember: "always" },
    ]) {
      expect(postSessionAnswerInputSchema.safeParse(body).success).toBe(false);
    }
    for (const body of [
      { ...base, decision: "deny", remember: "session" },
      { ...base, decision: "allow", remember: "always" },
    ]) {
      expect(postSessionAnswerRequestSchema.safeParse(body).success).toBe(
        false,
      );
    }
  });

  test("an answer without remember still parses on the stored schema", () => {
    expect(
      postSessionAnswerRequestSchema.safeParse({ ...base, decision: "allow" })
        .success,
    ).toBe(true);
  });

  test("a question answer passes through unchanged", () => {
    const body: PostSessionAnswerInput = {
      request_id: "q_01",
      kind: "question",
      answers: [{ question_id: "q1", selected_option_ids: ["a"] }],
    };
    expect(storedAnswer(postSessionAnswerInputSchema.parse(body))).toEqual(
      body,
    );
  });
});
