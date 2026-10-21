import { describe, expect, test } from "bun:test";

import * as contracts from "../index.ts";
import {
  SESSION_EVENT_NAMES,
  type SessionEventName,
  STATUS_EVENT_PHASE_VALUES,
  sseEventSchema,
} from "./event.ts";
import {
  presentTurnEvent,
  type TurnEventPresentation,
} from "./present-turn-event.ts";

const AT = "2026-10-21T02:54:00.000Z";

// One readable payload per event name; status gets one per phase below.
const PAYLOADS: Record<SessionEventName, unknown[]> = {
  system: [
    { type: "system", subtype: "init" },
    { type: "system", subtype: "vcs_state_changed" },
    { type: "system", subtype: "compact_boundary" },
    { type: "system", subtype: "thinking_tokens" },
    { type: "system", subtype: "sdk_event", native_type: "command_lifecycle" },
    { type: "system" },
    // Loose system payloads: the web folds only on an exact subtype string.
    { type: "system", subtype: ["thinking_tokens"] },
    { type: "system", subtype: ["sdk_event"] },
    { type: "system", subtype: ["init"] },
  ],
  assistant: [
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Listing files" }] },
    },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "x".repeat(300) }] },
    },
    {
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "Read it first." }] },
    },
    { type: "assistant", message: { content: [{ type: "thinking" }] } },
    { type: "assistant", message: { content: [] } },
    { type: "assistant", message: "not blocks" },
  ],
  tool_use: [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "Bash",
            input: { command: "rm -rf build", description: "Clean" },
          },
          {
            type: "tool_use",
            id: "tu_2",
            name: "Bash",
            input: { command: `echo ${"x".repeat(200)}\nsecond` },
          },
          { type: "tool_use", id: "tu_3", name: "TodoWrite", input: {} },
        ],
      },
    },
  ],
  tool_result: [
    { type: "tool_result", tool_use_id: "tu_1", content: "a.txt" },
    {
      type: "tool_result",
      tool_use_id: "tu_1",
      is_error: true,
      content: [{ type: "text", text: "make: *** No rule\nline 2\nline 3" }],
    },
    { type: "tool_result", tool_use_id: "tu_1", content: "" },
    "plain text result",
  ],
  question: [
    {
      request_id: "req_1",
      tool_use_id: "tu_1",
      kind: "permission",
      tool: "Edit",
      input: { file_path: "/repo/a.ts" },
    },
    {
      request_id: "req_1",
      tool_use_id: "tu_1",
      kind: "question",
      tool: "AskUserQuestion",
      input: { questions: [{ question: "Which branch?" }, { question: "?" }] },
    },
    {
      request_id: "req_1",
      tool_use_id: "tu_1",
      kind: "question",
      input: { path: "/repo" },
    },
    {
      request_id: "req_1",
      tool_use_id: "tu_1",
      kind: "question",
      input: {},
    },
  ],
  result: [
    {
      type: "result",
      subtype: "success",
      session_id: "s",
      usage: { input_tokens: 120, output_tokens: 30 },
    },
    {
      type: "result",
      subtype: "error_max_turns",
      session_id: "s",
      is_error: true,
    },
  ],
  status: STATUS_EVENT_PHASE_VALUES.map((phase) => ({ phase })),
  error: [{ message: "engine crashed", code: "ENGINE" }],
};

// Every fixture is a frame the public SSE contract accepts, unwrapped the way
// a reader holds it.
const FIXTURES = SESSION_EVENT_NAMES.flatMap((name) =>
  PAYLOADS[name].map((data, index) => {
    const frame = sseEventSchema.parse({
      id: `${name}_${index}`,
      event: name,
      data: {
        schema_version: 1,
        session_id: "6f1c2b5e-8a4d-4c3f-9e2a-1b7d5c9e0a42",
        turn_id: "turn_1",
        attempt_id: null,
        occurred_at: AT,
        data,
      },
    });
    return { id: frame.id, event: frame.event, data: frame.data.data };
  }),
);

describe("presentTurnEvent", () => {
  test("is exported from the package", () => {
    expect(contracts.presentTurnEvent).toBe(presentTurnEvent);
  });

  test("every event name × status phase gets a label", () => {
    for (const name of SESSION_EVENT_NAMES) {
      expect(FIXTURES.some((fixture) => fixture.event === name)).toBe(true);
      for (const phase of STATUS_EVENT_PHASE_VALUES) {
        const presented = presentTurnEvent({ event: name, data: { phase } });
        expect(presented.label.key).toBeString();
        expect(presented.label.key).not.toBe("");
      }
    }
    for (const phase of STATUS_EVENT_PHASE_VALUES) {
      const presented = presentTurnEvent({ event: "status", data: { phase } });
      expect(presented.label).toEqual({ key: "session.event.kind.status" });
      expect(presented.summary).toEqual([
        {
          key:
            phase === "interrupting" || phase === "engine_stopped"
              ? `session.event.phase.${phase}`
              : `sessions.status.${phase}`,
        },
      ]);
    }
  });

  test("an event it cannot read gets the generic label and does not throw", () => {
    const generic: TurnEventPresentation = {
      label: { key: "sessions.status.running" },
      summary: [],
    };
    const unreadable: { event: string; data?: unknown }[] = [
      { event: "heartbeat", data: {} },
      { event: "", data: null },
      { event: "status" },
      { event: "status", data: { phase: "warming_up" } },
      { event: "status", data: { phase: 3 } },
      { event: "status", data: [] },
      { event: "error", data: { message: { nested: true } } },
      { event: "result", data: { type: "result" } },
      { event: "assistant", data: "text" },
      { event: "question", data: 42 },
      { event: "system", data: null },
    ];
    for (const event of unreadable) {
      expect(presentTurnEvent(event)).toEqual(generic);
    }
    const throwing = [
      null,
      {
        event: "status",
        get data(): unknown {
          throw new Error("getter");
        },
      },
      JSON.parse(
        '{"event":"assistant","data":{"type":"assistant","message":{"content":[{"type":"text","text":{"toString":null}}]}}}',
      ),
      JSON.parse('{"event":"system","data":{"subtype":{"toString":null}}}'),
    ];
    for (const event of throwing) {
      expect(presentTurnEvent(event)).toEqual(generic);
    }
    const hostile = {
      event: "assistant",
      data: { message: { content: [null, 1, [], { type: "text" }] } },
    };
    expect(() => presentTurnEvent(hostile)).not.toThrow();
  });

  test("returns keys and event text, never wording of its own", () => {
    expect(
      presentTurnEvent(
        { event: "tool_result", data: PAYLOADS.tool_result[1] },
        { toolName: "Bash" },
      ),
    ).toEqual({
      label: { key: "session.event.kind.toolResult" },
      summary: [
        { key: "session.event.toolResult", params: { tool: "Bash" } },
        { key: "session.event.toolResult.error" },
        { text: "make: *** No rule" },
        { key: "session.event.toolResult.lines", params: { count: 3 } },
      ],
      error: true,
    });
    expect(
      presentTurnEvent({ event: "system", data: PAYLOADS.system[3] }),
    ).toMatchObject({ fold: "thinking_tick" });
    expect(
      presentTurnEvent({ event: "system", data: PAYLOADS.system[4] }),
    ).toMatchObject({ fold: "debug" });
  });
});
