import { StatusDot } from "@werft-ai/ui";
import {
  Bot,
  Check,
  FileText,
  Globe,
  type LucideIcon,
  Pencil,
  Search,
  ShieldQuestion,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { JSX } from "react";

import type { AgentMapMessages } from "./messages.ts";
import type { MapToolCall, ToolCallState } from "./types.ts";
import { useAgentMapMessages } from "./use-messages.ts";

const TOOL_ICON: Readonly<Record<string, LucideIcon>> = {
  Bash: Terminal,
  Read: FileText,
  Edit: Pencil,
  Grep: Search,
  WebFetch: Globe,
  Task: Bot,
};

const TONE: Record<ToolCallState, string> = {
  ok: "border-border text-foreground",
  error:
    "border-(color:--ap-tone-danger-border) bg-(color:--ap-tone-danger-bg) text-(color:--ap-tone-danger-fg)",
  running:
    "border-(color:--ap-tone-progress-border) bg-(color:--ap-tone-progress-bg) text-(color:--ap-tone-progress-fg)",
  waiting:
    "border-(color:--ap-tone-attention-border) bg-(color:--ap-tone-attention-bg) text-(color:--ap-tone-attention-fg)",
};

export interface ToolChipProps {
  readonly call: MapToolCall;
  readonly messages?: Partial<AgentMapMessages> | undefined;
}

/**
 * One tool call as a list item: the state shows in colour, in the trailing
 * mark (check, cross, shield or turning dot) and in words for a screen reader.
 */
export function ToolChip({
  call,
  messages: override,
}: ToolChipProps): JSX.Element {
  const messages = useAgentMapMessages(override);
  const Icon = TOOL_ICON[call.name] ?? Wrench;
  return (
    <li
      className={`inline-flex h-6 max-w-full items-center gap-1 rounded-full border px-2 text-caption ${TONE[call.state]}`}
      title={`${call.name} ${call.target}`}
    >
      <Icon aria-hidden="true" className="size-3 flex-none" />
      <span className="font-medium">{call.name}</span>
      <span className="min-w-0 truncate font-mono text-muted-foreground">
        {call.target}
      </span>
      {call.state === "ok" ? (
        <Check aria-hidden="true" className="size-3 flex-none" />
      ) : call.state === "error" ? (
        <X aria-hidden="true" className="size-3 flex-none" />
      ) : call.state === "waiting" ? (
        <ShieldQuestion aria-hidden="true" className="size-3 flex-none" />
      ) : (
        <StatusDot status="run" />
      )}
      <span className="sr-only">{messages.toolState(call.state)}</span>
    </li>
  );
}

export interface ToolChipsProps {
  readonly tools: readonly MapToolCall[];
  readonly hidden?: number | undefined;
  readonly messages?: Partial<AgentMapMessages> | undefined;
}

/** A run's latest calls, then how many more there are. */
export function ToolChips({
  tools,
  hidden,
  messages: override,
}: ToolChipsProps): JSX.Element {
  const messages = useAgentMapMessages(override);
  if (tools.length === 0) {
    return (
      <p className="m-0 text-caption text-subtle-foreground">
        {messages.noTools}
      </p>
    );
  }
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-2 p-0">
      {tools.map((call) => (
        <ToolChip key={call.id} call={call} messages={messages} />
      ))}
      {hidden ? (
        <li className="inline-flex h-6 items-center text-caption text-muted-foreground">
          +{hidden}
        </li>
      ) : null}
    </ul>
  );
}
