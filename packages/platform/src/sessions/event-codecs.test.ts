import { describe, expect, test } from "bun:test";
import {
  presentTurnEvent,
  type SessionEventPayload,
  sessionEventPayloadSchema,
} from "@werft-ai/contracts";
import type { EventCodec } from "@werft-ai/runtime-core";
import { finalReplyText } from "../musterrolle/slack-outbox.ts";
import type { CatalogProfileView } from "./catalog.ts";
import { createNeutralizer } from "./event-codecs.ts";

// A second engine with an event shape of its own: its codec reads `item`,
// which no consumer outside it knows.
const secondEngine: EventCodec = {
  kind: "codex_app_server",
  withNeutralFields(event) {
    const data = event.data as Record<string, unknown>;
    const item = data.item as Record<string, unknown> | undefined;
    if (item === undefined) return event;
    const added =
      event.event === "assistant"
        ? { text: item.said }
        : event.event === "tool_use"
          ? { tool_call: { id: item.call, name: item.tool, input: item.args } }
          : event.event === "tool_result"
            ? {
                tool_result: {
                  tool_call_id: item.call,
                  is_error: item.failed,
                  text: item.output,
                },
              }
            : event.event === "result"
              ? {
                  turn: {
                    outcome: item.outcome,
                    is_error: false,
                    terminal_reason: null,
                    tokens: item.tokens,
                  },
                  runtime: {
                    kind: "codex_app_server",
                    session_ref: item.thread,
                  },
                }
              : {};
    return { ...event, data: { ...data, ...added } } as SessionEventPayload;
  },
};

const catalog = {
  profiles: {
    second: { runtime_kind: "codex_app_server" } as CatalogProfileView,
    other: { runtime_kind: "pi_coding_agent" } as CatalogProfileView,
  },
};

const stream: SessionEventPayload[] = [
  {
    event: "assistant",
    data: { type: "assistant", item: { said: "Looking." } },
  },
  {
    event: "tool_use",
    data: {
      type: "assistant",
      item: { call: "c1", tool: "shell", args: { command: "ls" } },
    },
  },
  {
    event: "tool_result",
    data: {
      type: "tool_result",
      item: { call: "c1", failed: false, output: "README.md" },
    },
  },
  { event: "assistant", data: { type: "assistant", item: { said: "Done." } } },
  {
    event: "result",
    data: {
      type: "result",
      item: { outcome: "completed", tokens: 12, thread: "th_1" },
    },
  },
] as SessionEventPayload[];

describe("createNeutralizer", () => {
  test("picks the codec the session profile's runtime kind names", () => {
    const unknown: Array<string | null> = [];
    const neutralize = createNeutralizer([secondEngine], catalog, (id) =>
      unknown.push(id),
    );
    const [said] = stream;
    expect(
      neutralize("second", said as SessionEventPayload).data,
    ).toMatchObject({ text: "Looking." });
    // No profile, a profile gone from the catalog, a kind with no codec.
    for (const id of [null, "gone", "other"]) {
      expect(neutralize(id, said as SessionEventPayload)).toBe(
        said as SessionEventPayload,
      );
    }
    expect(unknown).toEqual([null, "gone", "other"]);
  });

  test("fields the contract refuses are not added", () => {
    const broken: EventCodec = {
      kind: "codex_app_server",
      withNeutralFields: (event) =>
        ({
          ...event,
          data: { ...event.data, tool_call: { id: 7 } },
        }) as SessionEventPayload,
    };
    const [said] = stream as [SessionEventPayload];
    expect(createNeutralizer([broken], catalog)("second", said)).toBe(said);
  });

  test("a second engine's stream reads through the neutral fields alone", () => {
    const neutralize = createNeutralizer([secondEngine], catalog);
    const events = stream.map((event) => neutralize("second", event));
    for (const event of events) {
      const { item: _, ...data } = event.data as Record<string, unknown>;
      expect(sessionEventPayloadSchema.parse(event).data).toMatchObject(data);
      for (const engineField of ["message", "session_id", "native_type"]) {
        expect(data).not.toHaveProperty(engineField);
      }
    }
    expect(events.map((event) => presentTurnEvent(event).summary)).toEqual([
      [{ text: "Looking." }],
      [{ text: "shell: ls" }],
      [
        { key: "session.event.toolResult.unknown" },
        { key: "session.event.toolResult.ok" },
        { text: "README.md" },
      ],
      [{ text: "Done." }],
      [
        { key: "session.event.result.other", params: { subtype: "completed" } },
        { key: "session.event.result.tokens", params: { count: 12 } },
      ],
    ]);
    expect(presentTurnEvent(events[4] as SessionEventPayload).error).not.toBe(
      true,
    );
    expect(
      finalReplyText(
        events.map((event) => ({ type: event.event, payload: event.data })),
      ),
    ).toBe("Done.");
  });
});
