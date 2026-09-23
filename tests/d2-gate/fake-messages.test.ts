import { describe, expect, test } from "bun:test";
import { planOf } from "../../scripts/d2-gate/fake-messages.ts";
import { prompt, write } from "./harness.ts";

const text = (value: string) => ({ type: "text", text: value });
const toolResult = (id: string) => ({
  type: "tool_result",
  tool_use_id: id,
  content: "ok",
});

describe("the gate's scripted Messages API", () => {
  test("a spec that carries a subagent's spec is read as the outer one", () => {
    const inner = prompt("Write the file.", {
      id: "inner",
      steps: [write("/workspace/sub.txt", "sub\n")],
      final: "SUB DONE",
    });
    const outer = prompt("Turn one.", {
      id: "outer",
      steps: [
        {
          tool: "Agent",
          input: { prompt: inner, subagent_type: "general-purpose" },
        },
      ],
      final: "DONE",
    });
    expect(planOf([{ role: "user", content: [text(outer)] }])?.spec.id).toBe(
      "outer",
    );
    // The subagent's own conversation opens with the inner prompt.
    expect(planOf([{ role: "user", content: inner }])?.spec.id).toBe("inner");
  });

  test("the step is the number of tool results after the latest spec", () => {
    const first = prompt("One.", { id: "one", steps: [], final: "1" });
    const second = prompt("Two.", {
      id: "two",
      steps: [write("/a", "a"), write("/b", "b"), write("/c", "c")],
      final: "2",
    });
    const plan = planOf([
      { role: "user", content: [text(first)] },
      { role: "assistant", content: [text("1")] },
      { role: "user", content: [text(second)] },
      { role: "assistant", content: [{ type: "tool_use" }] },
      { role: "user", content: [toolResult("x")] },
      { role: "assistant", content: [{ type: "tool_use" }] },
      { role: "user", content: [toolResult("y"), text("reminder")] },
    ]);
    expect(plan).toMatchObject({ spec: { id: "two" }, step: 2 });
  });

  test("a conversation without a spec has no plan", () => {
    expect(planOf([{ role: "user", content: "hello" }])).toBeNull();
  });
});
