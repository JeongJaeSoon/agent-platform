import { describe, expect, test } from "bun:test";
import {
  type PostSessionAnswerInput,
  postSessionAnswerInputSchema,
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
