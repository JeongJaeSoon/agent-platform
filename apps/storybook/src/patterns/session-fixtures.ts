import {
  presentTurnEvent,
  type SessionSummary,
  type TurnEventMessage,
  type TurnEventMessageKey,
} from "@agent-platform/contracts";
import type { TimelineEntry } from "@agent-platform/ui";

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

export const SESSION: SessionSummary = {
  id: "0192f0c4-7d3a-7b4e-9f00-00000000a001",
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
  repository_id: "agent-platform",
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
