import type {
  UsageToolCallsResponse,
  UsageToolsResponse,
} from "@werft-ai/contracts";

export type { UsageToolsResponse };
export type UsageTool = UsageToolsResponse["tools"][number];
/** Names a row of `tools`, whose figures the finding reads. */
export type UsageToolFinding = UsageToolsResponse["findings"][number];
export type UsageToolFindingKind = UsageToolFinding["kind"];
/**
 * `session_id` and `title` are both null for a session outside what the
 * caller may read; `agent` is null for a session made without one.
 */
export type UsageToolCall = UsageToolCallsResponse["calls"][number];
