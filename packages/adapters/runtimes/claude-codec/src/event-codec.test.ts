import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  presentTurnEvent,
  type SessionEventPayload,
  sessionEventPayloadSchema,
} from "@werft-ai/contracts";

import { claudeEventCodec } from "./event-codec.ts";

// What the worker publishes for a scripted Claude engine (worker-host
// golden tests): the v1 events this codec reads.
const GOLDEN = join(
  import.meta.dir,
  "../../../../../tests/fixtures/golden/worker",
);
const published: SessionEventPayload[] = readdirSync(GOLDEN)
  .filter((name) => name.endsWith(".json"))
  .flatMap((name) => {
    const golden = JSON.parse(readFileSync(join(GOLDEN, name), "utf8")) as {
      events?: { event: string; data: unknown }[];
    };
    return (golden.events ?? []).map(({ event, data }) =>
      sessionEventPayloadSchema.parse({ event, data }),
    );
  });

const neutral = (event: string, data: Record<string, unknown>) =>
  claudeEventCodec.withNeutralFields(
    sessionEventPayloadSchema.parse({ event, data }),
  ).data as Record<string, unknown>;

describe("claudeEventCodec", () => {
  test("every event the worker publishes stays in the contract, its v1 fields untouched", () => {
    expect(published.length).toBeGreaterThan(20);
    for (const event of published) {
      const out = claudeEventCodec.withNeutralFields(event);
      expect(sessionEventPayloadSchema.parse(out)).toEqual(out);
      expect(out.data).toMatchObject(event.data as Record<string, unknown>);
    }
  });

  test("a call, a text, a thought and a result each get their neutral field", () => {
    expect(
      neutral("tool_use", {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { a: 1 } },
          ],
        },
        parent_tool_use_id: null,
      }),
    ).toMatchObject({
      tool_call: { id: "toolu_1", name: "Bash", input: { a: 1 } },
    });
    expect(
      neutral("assistant", {
        type: "assistant",
        message: { content: [{ type: "text", text: "an answer" }] },
      }),
    ).toMatchObject({ text: "an answer" });
    expect(
      neutral("assistant", {
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "hm" }] },
      }),
    ).toMatchObject({ thinking: "hm" });
    expect(
      neutral("tool_result", {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
        is_error: true,
      }),
    ).toMatchObject({
      tool_result: { tool_call_id: "toolu_1", is_error: true, text: "a\nb" },
    });
  });

  test("is_error reads absent as false and anything not boolean as unknown", () => {
    const result = (fields: Record<string, unknown>) =>
      neutral("tool_result", {
        type: "tool_result",
        tool_use_id: "t",
        ...fields,
      }).tool_result;
    expect(result({})).toMatchObject({ is_error: false });
    expect(result({ is_error: false })).toMatchObject({ is_error: false });
    expect(result({ is_error: "true" })).toMatchObject({ is_error: null });
    expect(
      neutral("tool_result", { type: "tool_result", content: "no id" }),
    ).not.toHaveProperty("tool_result");
  });

  test("a turn end carries its outcome and the engine's session as a ref", () => {
    expect(
      neutral("result", {
        type: "result",
        subtype: "error_max_turns",
        session_id: "fake-session",
        usage: { input_tokens: 3, output_tokens: 5 },
        is_error: true,
        terminal_reason: "max_turns",
      }),
    ).toMatchObject({
      turn: {
        outcome: "error_max_turns",
        is_error: true,
        terminal_reason: "max_turns",
        tokens: 8,
      },
      runtime: { kind: "claude_agent_sdk", session_ref: "fake-session" },
    });
    expect(
      neutral("result", {
        type: "result",
        subtype: "success",
        session_id: "unknown-session",
      }),
    ).toMatchObject({
      turn: {
        outcome: "success",
        is_error: false,
        terminal_reason: null,
        tokens: null,
      },
      runtime: { session_ref: null },
    });
  });

  test("an engine system event says what it is; the platform's own get nothing", () => {
    const engine = (data: Record<string, unknown>) =>
      neutral("system", { type: "system", ...data }).engine_event;
    expect(engine({ subtype: "init", tools: [] })).toEqual({
      name: "init",
      category: "started",
    });
    expect(engine({ subtype: "thinking_tokens" })).toEqual({
      name: "thinking_tokens",
      category: "thinking",
    });
    expect(engine({ subtype: "vcs_state_changed" })).toEqual({
      name: "vcs_state_changed",
      category: "workspace",
    });
    expect(
      engine({ subtype: "sdk_event", native_type: "rate_limit_event" }),
    ).toEqual({ name: "rate_limit_event", category: "internal" });
    expect(engine({ subtype: "api_retry" })).toEqual({
      name: "api_retry",
      category: "other",
    });
    expect(engine({ subtype: "input_wait" })).toBeUndefined();
    expect(engine({ subtype: "session_closed" })).toBeUndefined();
  });

  test("fields already there are kept and nothing more is added", () => {
    const event = sessionEventPayloadSchema.parse({
      event: "assistant",
      data: {
        type: "assistant",
        text: "kept",
        message: { content: [{ type: "text", text: "from the engine" }] },
      },
    });
    expect(claudeEventCodec.withNeutralFields(event)).toBe(event);
    const status = sessionEventPayloadSchema.parse({
      event: "status",
      data: { phase: "running" },
    });
    expect(claudeEventCodec.withNeutralFields(status)).toBe(status);
  });

  test("a reader shows what the worker published as before", () => {
    // Every engine event is read as something, not as the generic line a
    // reader shows for what it cannot read.
    const lines = published
      .filter((event) => event.event !== "status")
      .map((event) =>
        presentTurnEvent(claudeEventCodec.withNeutralFields(event), {
          toolName: "Read",
        }),
      );
    const said = (event: SessionEventPayload) =>
      presentTurnEvent(claudeEventCodec.withNeutralFields(event)).summary;
    expect(
      said(
        sessionEventPayloadSchema.parse({
          event: "assistant",
          data: {
            type: "assistant",
            message: { content: [{ type: "text", text: "an answer" }] },
          },
        }),
      ),
    ).toEqual([{ text: "an answer" }]);
    expect(
      lines.filter(
        (line) =>
          line.label.key === "sessions.status.running" &&
          line.summary.length === 0,
      ),
    ).toEqual([]);
  });
});
