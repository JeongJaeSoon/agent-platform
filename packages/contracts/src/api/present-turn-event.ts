import type { StatusEventPhase } from "./event.ts";
import type { SessionStatus } from "./session.ts";

/*
 * Says in words what one session event is, for every surface that shows a
 * turn (the web timeline, Slack). It returns message keys and parameters, not
 * text: each surface owns its wording. It reads only the fields it knows and
 * never throws, so it takes any event-shaped value, parsed or not.
 *
 * Kept free of zod (type imports only) so a browser bundle that calls it does
 * not carry the schemas.
 */

export type TurnEventMessageKey =
  | `sessions.status.${SessionStatus}`
  | "session.event.phase.interrupting"
  | "session.event.phase.engine_stopped"
  | "session.event.kind.status"
  | "session.event.kind.system"
  | "session.event.kind.internal"
  | "session.event.kind.thinking"
  | "session.event.kind.assistant"
  | "session.event.kind.toolUse"
  | "session.event.kind.toolResult"
  | "session.event.kind.permission"
  | "session.event.kind.question"
  | "session.event.kind.result"
  | "session.event.kind.error"
  | "session.event.init"
  | "session.event.vcsChanged"
  | "session.event.thinkingTokens"
  | "session.event.thought"
  | "session.event.toolResult"
  | "session.event.toolResult.unknown"
  | "session.event.toolResult.ok"
  | "session.event.toolResult.error"
  | "session.event.toolResult.lines"
  | "session.event.result.success"
  | "session.event.result.other"
  | "session.event.result.tokens";

export interface TurnEventMessage {
  readonly key: TurnEventMessageKey;
  readonly params?: Readonly<Record<string, string | number>>;
}

/** Event text shown as it came, such as a reply or a tool's first line. */
export interface TurnEventText {
  readonly text: string;
}

export type TurnEventPart = TurnEventMessage | TurnEventText;

export interface TurnEventPresentation {
  readonly label: TurnEventMessage;
  /** Shown joined by " · ". Empty: the event has nothing to show. */
  readonly summary: readonly TurnEventPart[];
  /** Longer text shown folded under the summary. */
  readonly detail?: string;
  readonly error?: boolean;
  /**
   * `debug`: SDK bookkeeping, shown only when asked for. `thinking_tick`:
   * one batch of thinking tokens, which a reader folds into one line per
   * run with the run's count as `count`.
   */
  readonly fold?: "debug" | "thinking_tick";
}

export interface TurnEventContext {
  /** A tool result's call, when the reader paired them. */
  readonly toolName?: string | undefined;
}

// What a reader shows for an event it cannot read: the turn is still going.
const GENERIC: TurnEventPresentation = {
  label: { key: "sessions.status.running" },
  summary: [],
};

const SUMMARY_MAX = 200;
// Tool inputs can carry tokens or long scripts: a summary shows only a start.
const INPUT_MAX = 80;
const DETAIL_MAX = 2000;

const SESSION_STATUSES = new Set<string>([
  "queued",
  "running",
  "needs_input",
  "idle",
  "failed",
  "stopped",
] satisfies SessionStatus[]);
const CONTROL_PHASES = new Set<string>([
  "interrupting",
  "engine_stopped",
] satisfies Exclude<StatusEventPhase, SessionStatus>[]);

function phaseMessage(phase: unknown): TurnEventMessage | null {
  if (typeof phase !== "string") return null;
  if (SESSION_STATUSES.has(phase)) {
    return { key: `sessions.status.${phase as SessionStatus}` };
  }
  if (CONTROL_PHASES.has(phase)) {
    return {
      key: `session.event.phase.${phase as "interrupting" | "engine_stopped"}`,
    };
  }
  return null;
}

function message(
  key: TurnEventMessageKey,
  params?: Record<string, string | number>,
): TurnEventMessage {
  return params ? { key, params } : { key };
}

function clip(text: string, max = SUMMARY_MAX) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contentBlocks(content: unknown): Record<string, unknown>[] {
  return Array.isArray(content)
    ? content.flatMap((block) => {
        const fields = asRecord(block);
        return fields ? [fields] : [];
      })
    : [];
}

function firstLine(text: string) {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

// The first of these an input has names what a call is about: Bash's
// description before its command, a file tool's path, a search's pattern.
const INPUT_KEYS = [
  "description",
  "command",
  "file_path",
  "notebook_path",
  "path",
  "pattern",
  "url",
  "query",
] as const;

function inputSummary(input: unknown) {
  const fields = asRecord(input);
  if (!fields) return null;
  for (const key of INPUT_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) {
      return clip(firstLine(value), INPUT_MAX);
    }
  }
  return null;
}

function toolCall(name: string, input: unknown) {
  const about = inputSummary(input);
  return about ? `${name}: ${about}` : name;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      const text = asRecord(block)?.text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

function tokenCount(usage: unknown) {
  const fields = asRecord(usage);
  if (!fields) return null;
  const counts = [fields.input_tokens, fields.output_tokens].filter(
    (value): value is number => typeof value === "number",
  );
  return counts.length > 0 ? counts.reduce((a, b) => a + b, 0) : null;
}

function text(value: string): TurnEventPart[] {
  return value ? [{ text: value }] : [];
}

function question(data: Record<string, unknown>): TurnEventPresentation {
  const questions = asRecord(data.input)?.questions;
  const prompts = Array.isArray(questions)
    ? questions
        .flatMap((entry) => {
          const prompt = asRecord(entry)?.question;
          return typeof prompt === "string" ? [prompt] : [];
        })
        .join(" / ")
    : "";
  const tool = typeof data.tool === "string" ? data.tool : "";
  return {
    label: message(
      data.kind === "permission"
        ? "session.event.kind.permission"
        : "session.event.kind.question",
    ),
    summary: text(
      prompts
        ? clip(prompts)
        : tool
          ? toolCall(tool, data.input)
          : (inputSummary(data.input) ?? ""),
    ),
  };
}

function assistant(data: Record<string, unknown>): TurnEventPresentation {
  const blocks = contentBlocks(asRecord(data.message)?.content);
  const reply = blocks
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join(" ")
    .trim();
  if (reply) {
    return {
      label: message("session.event.kind.assistant"),
      summary: text(clip(reply)),
    };
  }
  const tools = blocks.filter((block) => block.type === "tool_use");
  if (tools.length > 0) {
    return {
      label: message("session.event.kind.toolUse"),
      summary: text(
        tools
          .map((block) => toolCall(String(block.name ?? ""), block.input))
          .join(", "),
      ),
    };
  }
  const thinking = blocks.filter((block) => block.type === "thinking");
  if (thinking.length > 0) {
    const thought = thinking
      .map((block) => String(block.thinking ?? ""))
      .join("\n")
      .trim();
    return {
      label: message("session.event.kind.thinking"),
      summary: [message("session.event.thought")],
      ...(thought ? { detail: clip(thought, DETAIL_MAX) } : {}),
    };
  }
  return { label: message("session.event.kind.assistant"), summary: [] };
}

function toolResult(
  data: Record<string, unknown>,
  toolName: string | undefined,
): TurnEventPresentation {
  const tool = toolName ?? "";
  const failed = data.is_error === true;
  const body = resultText(data.content).trim();
  const lines = body ? body.split("\n").length : 0;
  return {
    label: message("session.event.kind.toolResult"),
    summary: [
      tool
        ? message("session.event.toolResult", { tool })
        : message("session.event.toolResult.unknown"),
      message(
        failed
          ? "session.event.toolResult.error"
          : "session.event.toolResult.ok",
      ),
      ...text(body ? clip(firstLine(body), INPUT_MAX) : ""),
      ...(lines > 1
        ? [message("session.event.toolResult.lines", { count: lines })]
        : []),
    ],
    error: failed,
  };
}

function system(data: Record<string, unknown>): TurnEventPresentation {
  const subtype = String(data.subtype ?? "");
  const label = message("session.event.kind.system");
  switch (subtype) {
    case "init":
      return { label, summary: [message("session.event.init")] };
    case "vcs_state_changed":
      return { label, summary: [message("session.event.vcsChanged")] };
    case "thinking_tokens":
      return {
        label: message("session.event.kind.thinking"),
        summary: [message("session.event.thinkingTokens", { count: 1 })],
        fold: "thinking_tick",
      };
    case "sdk_event":
      return {
        label: message("session.event.kind.internal"),
        summary: text(String(data.native_type ?? subtype)),
        fold: "debug",
      };
    default:
      return { label, summary: text(subtype) };
  }
}

export function presentTurnEvent(
  event: { readonly event: string; readonly data?: unknown },
  context: TurnEventContext = {},
): TurnEventPresentation {
  const data = asRecord(event.data);
  // A tool result's payload is whatever the tool returned, not always a record.
  if (event.event === "tool_result") {
    return toolResult(data ?? {}, context.toolName);
  }
  if (!data) return GENERIC;
  switch (event.event) {
    case "status": {
      const phase = phaseMessage(data.phase);
      return phase
        ? { label: message("session.event.kind.status"), summary: [phase] }
        : GENERIC;
    }
    case "error":
      return typeof data.message === "string"
        ? {
            label: message("session.event.kind.error"),
            summary: text(data.message),
            error: true,
          }
        : GENERIC;
    case "question":
      return question(data);
    case "result": {
      if (typeof data.subtype !== "string") return GENERIC;
      const tokens = tokenCount(data.usage);
      return {
        label: message("session.event.kind.result"),
        summary: [
          data.subtype === "success"
            ? message("session.event.result.success")
            : message("session.event.result.other", { subtype: data.subtype }),
          ...(tokens === null
            ? []
            : [message("session.event.result.tokens", { count: tokens })]),
        ],
        error: data.is_error === true,
      };
    }
    case "assistant":
    case "tool_use":
      return assistant(data);
    case "system":
      return system(data);
    default:
      return GENERIC;
  }
}
