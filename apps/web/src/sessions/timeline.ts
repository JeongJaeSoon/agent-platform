import type {
  SessionEventPayload,
  SessionStatus,
  StatusEventPhase,
} from "@agent-platform/contracts";
import type { Translate } from "../i18n/i18n.tsx";
import type { SessionEventFrame } from "./hooks.ts";

/*
 * Turns the raw event stream into the lines the timeline draws: every line
 * says in words what happened, and events with nothing to say to a person
 * (SDK bookkeeping, one tick per thinking token batch) are folded or hidden.
 */

export interface TimelineItem {
  readonly key: string;
  readonly label: string;
  readonly summary: string;
  /** Longer text shown folded under the summary. */
  readonly detail?: string;
  readonly error?: boolean;
  readonly occurredAt: string;
  readonly turnId: string | null;
}

const SUMMARY_MAX = 200;
// Tool inputs can carry tokens or long scripts: a summary shows only a start.
const INPUT_MAX = 80;
const DETAIL_MAX = 2000;

const SESSION_STATUS_VALUES = new Set<string>([
  "queued",
  "running",
  "needs_input",
  "idle",
  "failed",
  "stopped",
] satisfies SessionStatus[]);

export function phaseText(t: Translate, phase: StatusEventPhase) {
  return SESSION_STATUS_VALUES.has(phase)
    ? t(`sessions.status.${phase as SessionStatus}`)
    : t(`session.event.phase.${phase as "interrupting" | "engine_stopped"}`);
}

function clip(text: string, max = SUMMARY_MAX) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contentBlocks(message: unknown): Record<string, unknown>[] {
  const content = asRecord(message)?.content;
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

type Line = Pick<TimelineItem, "label" | "summary" | "detail" | "error">;

function questionLine(
  t: Translate,
  data: Extract<SessionEventPayload, { event: "question" }>["data"],
): Line {
  const questions = asRecord(data.input)?.questions;
  const prompts = Array.isArray(questions)
    ? questions
        .flatMap((question) => {
          const text = asRecord(question)?.question;
          return typeof text === "string" ? [text] : [];
        })
        .join(" / ")
    : "";
  return {
    label:
      data.kind === "permission"
        ? t("session.event.kind.permission")
        : t("session.event.kind.question"),
    summary: prompts
      ? clip(prompts)
      : data.tool
        ? toolCall(data.tool, data.input)
        : (inputSummary(data.input) ?? ""),
  };
}

function assistantLine(t: Translate, message: unknown): Line | null {
  const blocks = contentBlocks(message);
  const text = blocks
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join(" ")
    .trim();
  if (text) {
    return { label: t("session.event.kind.assistant"), summary: clip(text) };
  }
  const tools = blocks.filter((block) => block.type === "tool_use");
  if (tools.length > 0) {
    return {
      label: t("session.event.kind.toolUse"),
      summary: tools
        .map((block) => toolCall(String(block.name ?? ""), block.input))
        .join(", "),
    };
  }
  const thinking = blocks.filter((block) => block.type === "thinking");
  if (thinking.length > 0) {
    const thought = thinking
      .map((block) => String(block.thinking ?? ""))
      .join("\n")
      .trim();
    return {
      label: t("session.event.kind.thinking"),
      summary: t("session.event.thought"),
      ...(thought ? { detail: clip(thought, DETAIL_MAX) } : {}),
    };
  }
  return null;
}

function eventLine(
  t: Translate,
  { payload, toolName }: SessionEventFrame,
  toolNames: ReadonlyMap<string, string>,
): Line | null {
  switch (payload.event) {
    case "status":
      return {
        label: t("session.event.kind.status"),
        summary: phaseText(t, payload.data.phase),
      };
    case "error":
      return {
        label: t("session.event.kind.error"),
        summary: payload.data.message,
        error: true,
      };
    case "question":
      return questionLine(t, payload.data);
    case "result": {
      const { subtype, usage } = payload.data;
      const tokens = tokenCount(usage);
      return {
        label: t("session.event.kind.result"),
        summary: [
          subtype === "success"
            ? t("session.event.result.success")
            : t("session.event.result.other", { subtype }),
          tokens === null
            ? null
            : t("session.event.result.tokens", { count: tokens }),
        ]
          .filter(Boolean)
          .join(" · "),
        error: payload.data.is_error === true,
      };
    }
    case "assistant":
    case "tool_use":
      return assistantLine(t, payload.data.message);
    case "tool_result": {
      const data = asRecord(payload.data);
      const id = data?.tool_use_id;
      const tool =
        toolName ?? (typeof id === "string" ? toolNames.get(id) : undefined);
      const failed = data?.is_error === true;
      const text = resultText(data?.content).trim();
      const lines = text ? text.split("\n").length : 0;
      return {
        label: t("session.event.kind.toolResult"),
        summary: [
          tool
            ? t("session.event.toolResult", { tool })
            : t("session.event.toolResult.unknown"),
          failed
            ? t("session.event.toolResult.error")
            : t("session.event.toolResult.ok"),
          text ? clip(firstLine(text), INPUT_MAX) : null,
          lines > 1
            ? t("session.event.toolResult.lines", { count: lines })
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
        error: failed,
      };
    }
    case "system": {
      const subtype = String(payload.data.subtype ?? "");
      if (subtype === "init") {
        return {
          label: t("session.event.kind.system"),
          summary: t("session.event.init"),
        };
      }
      if (subtype === "vcs_state_changed") {
        return {
          label: t("session.event.kind.system"),
          summary: t("session.event.vcsChanged"),
        };
      }
      if (subtype === "sdk_event") {
        return {
          label: t("session.event.kind.internal"),
          summary: String(payload.data.native_type ?? subtype),
        };
      }
      return subtype
        ? { label: t("session.event.kind.system"), summary: subtype }
        : null;
    }
  }
}

function isInternal(payload: SessionEventPayload) {
  return payload.event === "system" && payload.data.subtype === "sdk_event";
}

function isThinkingTick(payload: SessionEventPayload) {
  return (
    payload.event === "system" && payload.data.subtype === "thinking_tokens"
  );
}

// tool_use_id → tool name for calls still in the window; the stream hook
// names results whose call has already slid out (SessionEventFrame.toolName).
function toolNamesById(events: readonly SessionEventFrame[]) {
  const names = new Map<string, string>();
  for (const { payload } of events) {
    if (payload.event !== "tool_use" && payload.event !== "assistant") continue;
    for (const block of contentBlocks(payload.data.message)) {
      if (block.type === "tool_use" && typeof block.id === "string") {
        names.set(block.id, String(block.name ?? ""));
      }
    }
  }
  return names;
}

export function timelineItems(
  t: Translate,
  events: readonly SessionEventFrame[],
  { debug }: { readonly debug: boolean },
): TimelineItem[] {
  const toolNames = toolNamesById(events);
  const items: TimelineItem[] = [];
  let ticks = 0;
  for (const frame of events) {
    const { payload } = frame;
    if (!debug && isInternal(payload)) continue;
    const at = { occurredAt: frame.occurredAt, turnId: frame.turnId };
    if (isThinkingTick(payload)) {
      const last = items.at(-1);
      // A run of ticks in one turn reads as one line; it keeps the run's
      // first key so the row does not remount as the count grows.
      ticks = ticks > 0 && last?.turnId === frame.turnId ? ticks + 1 : 1;
      const line = {
        key: ticks > 1 && last ? last.key : frame.id,
        label: t("session.event.kind.thinking"),
        summary: t("session.event.thinkingTokens", { count: ticks }),
        ...at,
      };
      if (ticks > 1) items[items.length - 1] = line;
      else items.push(line);
      continue;
    }
    ticks = 0;
    const line = eventLine(t, frame, toolNames);
    if (line?.summary) items.push({ key: frame.id, ...line, ...at });
  }
  return items;
}
