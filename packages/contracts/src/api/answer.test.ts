import { describe, expect, test } from "bun:test";
import {
  type PostSessionAnswerInput,
  postSessionAnswerInputSchema,
  storedAnswer,
} from "./answer.ts";

const base = { request_id: "perm_01", kind: "permission" } as const;

describe("a permission answer from the API", () => {
  test("action, or the deprecated decision, is stored as decision", () => {
    for (const body of [
      { ...base, action: "deny", reason: "no" },
      { ...base, decision: "deny", reason: "no" },
    ]) {
      expect(storedAnswer(postSessionAnswerInputSchema.parse(body))).toEqual({
        ...base,
        decision: "deny",
        reason: "no",
      });
    }
  });

  test("both names, or neither, is refused", () => {
    for (const body of [
      { ...base, action: "allow", decision: "allow" },
      { ...base, action: "allow", decision: "deny" },
      base,
    ]) {
      expect(postSessionAnswerInputSchema.safeParse(body).success).toBe(false);
    }
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
