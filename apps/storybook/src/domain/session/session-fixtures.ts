import {
  presentTurnEvent,
  type SessionSummary,
  type TurnEventMessage,
  type TurnEventMessageKey,
} from "@werft-ai/contracts";
import type { TimelineEntry } from "@werft-ai/react/components";

/*
 * Short English copy for the session stories. The real wording lives in the
 * screen's dictionary; packages/ui only asks for it.
 */
const COPY: Record<TurnEventMessageKey, string> = {
  "sessions.status.queued": "Queued",
  "sessions.status.running": "Working",
  "sessions.status.needs_input": "Waiting for an answer",
  "sessions.status.idle": "Idle",
  "sessions.status.failed": "Failed",
  "sessions.status.stopped": "Stopped",
  "session.event.phase.interrupting": "Stopping",
  "session.event.phase.engine_stopped": "Engine stopped",
  "session.event.kind.status": "Status",
  "session.event.kind.system": "System",
  "session.event.kind.internal": "Internal",
  "session.event.kind.thinking": "Thinking",
  "session.event.kind.assistant": "Reply",
  "session.event.kind.toolUse": "Tool call",
  "session.event.kind.toolResult": "Tool result",
  "session.event.kind.permission": "Permission request",
  "session.event.kind.question": "Question",
  "session.event.kind.result": "Turn end",
  "session.event.kind.error": "Error",
  "session.event.init": "Session started",
  "session.event.vcsChanged": "Working tree changed",
  "session.event.thinkingTokens": "Thinking ({count})",
  "session.event.thought": "Thought",
  "session.event.toolResult": "{tool} result",
  "session.event.toolResult.unknown": "Tool result",
  "session.event.toolResult.ok": "succeeded",
  "session.event.toolResult.error": "failed",
  "session.event.toolResult.lines": "{count} lines",
  "session.event.result.success": "Turn complete",
  "session.event.result.other": "Turn ended ({subtype})",
  "session.event.result.tokens": "{count} tokens",
};

export function formatMessage({ key, params }: TurnEventMessage): string {
  return COPY[key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params?.[name] ?? ""),
  );
}

export const TIMELINE_MESSAGES = {
  label: "Session events",
  empty: "No events yet.",
  connecting: "Connecting…",
  closed: "Disconnected. Showing events so far.",
  turn: (turnId: string) => `turn ${turnId}`,
};

// Fixed ids and times, as in the other stories: no clocks, no randomness.
const START = Date.parse("2026-10-21T01:00:00.000Z");

type RawEvent = readonly [event: string, data: unknown, turnId?: string | null];

/** Raw events through presentTurnEvent, pairing tool results with calls. */
export function timelineEntries(events: readonly RawEvent[]): TimelineEntry[] {
  const toolNames = new Map<string, string>();
  return events.map(([event, data, turnId = "turn_01"], index) => {
    const blocks = (data as { message?: { content?: unknown } })?.message
      ?.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block?.type === "tool_use") toolNames.set(block.id, block.name);
      }
    }
    const callId = (data as { tool_use_id?: string })?.tool_use_id;
    return {
      id: `evt_${index}`,
      occurredAt: new Date(START + index * 4000).toISOString(),
      turnId,
      presentation: presentTurnEvent(
        { event, data },
        { toolName: callId ? toolNames.get(callId) : undefined },
      ),
    };
  });
}

export const TURN_EVENTS: readonly RawEvent[] = [
  ["status", { phase: "running" }],
  ["system", { subtype: "init" }],
  ["system", { subtype: "thinking_tokens" }],
  ["system", { subtype: "thinking_tokens" }],
  ["system", { subtype: "thinking_tokens" }],
  ["system", { subtype: "sdk_event", native_type: "rate_limit_event" }],
  [
    "assistant",
    {
      message: {
        content: [
          {
            type: "thinking",
            thinking: "Run the tests first, then read the failure.",
          },
        ],
      },
    },
  ],
  [
    "tool_use",
    {
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Bash",
            input: { command: "bun test", description: "Run the tests" },
          },
        ],
      },
    },
  ],
  [
    "tool_result",
    { tool_use_id: "call_1", content: "12 pass\n0 fail\nRan 12 tests" },
  ],
  [
    "assistant",
    { message: { content: [{ type: "text", text: "All 12 tests pass." }] } },
  ],
  [
    "result",
    {
      subtype: "success",
      usage: { input_tokens: 1200, output_tokens: 340 },
    },
  ],
  ["status", { phase: "idle" }],
];

export const FAILED_EVENTS: readonly RawEvent[] = [
  ["status", { phase: "running" }],
  [
    "tool_use",
    {
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_2",
            name: "Bash",
            input: { command: "bun run build" },
          },
        ],
      },
    },
  ],
  [
    "tool_result",
    {
      tool_use_id: "call_2",
      is_error: true,
      content: "error: Could not resolve './missing.ts'",
    },
  ],
  ["error", { message: "The engine stopped before the turn finished." }],
  ["status", { phase: "failed" }],
];

/** The clock the turn stories count relative times from. */
export const TIMELINE_NOW = START + 12 * 60_000;

/**
 * Like `timelineEntries`, with each tool call and result carrying the
 * tool_use id (as session-detail.tsx would fill `toolCallId`) and the events
 * `stepMs` apart, so relative times and same-minute runs both show.
 */
export function pairedTimelineEntries(
  events: readonly RawEvent[],
  stepMs = 20_000,
): TimelineEntry[] {
  return timelineEntries(events).map((entry, index) => {
    const data = events[index]?.[1] as {
      tool_use_id?: string;
      message?: { content?: unknown };
    } | null;
    const blocks = data?.message?.content;
    const call = Array.isArray(blocks)
      ? (blocks as { type?: string; id?: string }[]).find(
          (block) => block?.type === "tool_use",
        )?.id
      : undefined;
    const toolCallId = data?.tool_use_id ?? call;
    return {
      ...entry,
      occurredAt: new Date(START + index * stepMs).toISOString(),
      ...(toolCallId ? { toolCallId } : {}),
    };
  });
}

const inTurn = (events: readonly RawEvent[], turnId: string | null) =>
  events.map(([event, data]): RawEvent => [event, data, turnId]);

const toolUse = (id: string, input: Record<string, unknown>): RawEvent => [
  "tool_use",
  { message: { content: [{ type: "tool_use", id, name: "Bash", input }] } },
];

/** A second turn: a permission wait, then a tool call that fails. */
export const WAIT_FAIL_EVENTS: readonly RawEvent[] = inTurn(
  [
    ["status", { phase: "running" }],
    ["question", { kind: "permission", tool: "Bash", input: {} }],
    toolUse("call_3", { command: "bun run build", description: "Build" }),
    [
      "tool_result",
      {
        tool_use_id: "call_3",
        is_error: true,
        content: "error: Could not resolve './missing.ts'",
      },
    ],
    [
      "assistant",
      {
        message: {
          content: [{ type: "text", text: "The build cannot find a file." }],
        },
      },
    ],
    ["result", { subtype: "error_during_execution" }],
    ["status", { phase: "failed" }],
  ],
  "turn_02",
);

/** Two turns covering every kind: what the user's capture asked for. */
export const TWO_TURN_EVENTS: readonly RawEvent[] = [
  ...TURN_EVENTS,
  ...WAIT_FAIL_EVENTS,
];

/** A call still waiting for its result. */
export const RUNNING_EVENTS: readonly RawEvent[] = inTurn(
  [
    ["status", { phase: "running" }],
    toolUse("call_4", { command: "bun test", description: "Run the tests" }),
  ],
  "turn_03",
);

/** Events from before the first turn carry no turn id. */
export const NO_TURN_EVENTS: readonly RawEvent[] = [
  ...inTurn(
    [
      ["system", { subtype: "init" }],
      ["status", { phase: "queued" }],
    ],
    null,
  ),
  ...inTurn(
    [
      [
        "assistant",
        { message: { content: [{ type: "text", text: "Starting." }] } },
      ],
      ["result", { subtype: "success" }],
    ],
    "turn_01",
  ),
];

/** A long thought and a long tool output, both folded under one line. */
export const LONG_DETAIL_EVENTS: readonly RawEvent[] = inTurn(
  [
    [
      "assistant",
      {
        message: {
          content: [
            {
              type: "thinking",
              thinking: Array.from(
                { length: 6 },
                (_, line) =>
                  `Step ${line + 1}: read the failing test, then the module it imports, and check whether the fixture path changed in the last commit.`,
              ).join("\n"),
            },
          ],
        },
      },
    ],
    toolUse("call_5", { command: "bun test packages/react" }),
    [
      "tool_result",
      {
        tool_use_id: "call_5",
        content: Array.from(
          { length: 14 },
          (_, line) => `(pass) Timeline > case ${line + 1} [${line + 2}ms]`,
        ).join("\n"),
      },
    ],
  ],
  "turn_01",
);

export const SESSION: SessionSummary = {
  id: "0192f0c4-7d3a-7b4e-9f00-00000000a001",
  title: null,
  agent: null,
  created_by: null,
  channel: null,
  revision: 4,
  admission_state: "active",
  status: "running",
  runtime: {
    profile_id: "claude-default",
    kind: "claude_agent_sdk",
    version: "0.2.1",
    model: "claude-sonnet-4-5",
    permission_mode: "default",
  },
  model: "claude-sonnet-4-5",
  repository_id: "agent-platform",
  repository: {
    id: "agent-platform",
    full_name: "werft-ai/agent-platform",
    branch: "main",
  },
  current_turn_id: "turn_01",
  queued_turn_count: 1,
  last_event_at: "2026-10-21T01:00:44.000Z",
  created_at: "2026-10-21T00:58:00.000Z",
  updated_at: "2026-10-21T01:00:44.000Z",
};

export const SESSION_ROW_MESSAGES = {
  status: (status: SessionSummary["status"]) =>
    COPY[`sessions.status.${status}`],
  admission: (state: SessionSummary["admission_state"]) =>
    ({
      active: "Active",
      pausing: "Pausing",
      paused: "Paused",
      resuming: "Resuming",
      stopping: "Ending",
      stopped: "Ended",
      recovery_required: "Needs recovery",
      closing: "Archiving",
      closed: "Archived",
    })[state],
  statusAxis: "Status",
  admissionAxis: "State",
  runtime: "Runtime",
  lastEvent: "Last event",
  created: "Created",
  queuedTurns: (count: number) => `${count} queued`,
  none: "None",
};
