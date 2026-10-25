import { describe, expect, test } from "bun:test";

import { readableReason } from "./session-timeline.tsx";

type Translate = Parameters<typeof readableReason>[1];
const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key) as unknown as Translate;

describe("readableReason", () => {
  test("worker가 멈춘 이유 네 가지는 사람 말로, 나머지는 그대로 둔다", () => {
    expect(
      [
        "No input for 1802s",
        "No answer arrived within 1800s",
        "Turn turn_1 ran past its 600s budget, and the engine did not answer the interrupt",
        "checkpoint capture ran past its 45s budget",
        "The turn ran out of time",
        "engine crashed",
      ].map((text) => readableReason(text, t, "en")),
    ).toEqual([
      'session.reason.idle {"duration":"30 minutes"}',
      'session.reason.noAnswer {"duration":"30 minutes"}',
      'session.reason.turnBudget {"duration":"10 minutes"}',
      'session.reason.stageBudget {"duration":"45 seconds"}',
      "session.reason.turnOver",
      null,
    ]);
  });
});
