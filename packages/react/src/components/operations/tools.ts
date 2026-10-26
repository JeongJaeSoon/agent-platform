import type {
  UsageToolCallsResponse,
  UsageToolsResponse,
} from "@werft-ai/contracts";

export type { UsageToolsResponse };
export type UsageTool = UsageToolsResponse["tools"][number];
/** Names a row of `tools`, whose figures the finding reads. */
export type UsageToolFinding = UsageToolsResponse["findings"][number];
export type UsageToolFindingKind = UsageToolFinding["kind"];
export type UsageToolCall = UsageToolCallsResponse["calls"][number];
