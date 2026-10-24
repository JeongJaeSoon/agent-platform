/*
 * The shapes of the proposed GET /v1/usage/tools and
 * GET /v1/usage/tools/{name}/calls responses (ops-console selection.md, "새 API
 * 필요 목록"). They move to @werft-ai/contracts with those routes.
 */

export interface UsageTool {
  readonly name: string;
  readonly calls: number;
  readonly failed: number;
  readonly total_ms: number;
  readonly median_ms: number;
  readonly max_ms: number;
}

export type UsageToolFindingKind = "most_time" | "fails_often" | "slowest";

/** Names a row of `tools`, whose figures the finding reads. */
export interface UsageToolFinding {
  readonly kind: UsageToolFindingKind;
  readonly name: string;
}

export interface UsageToolsResponse {
  readonly tools: readonly UsageTool[];
  readonly findings: readonly UsageToolFinding[];
}

export interface UsageToolCall {
  /** Both null for a session outside what the caller may read. */
  readonly session_id: string | null;
  readonly title: string | null;
  readonly agent: string;
  readonly occurred_at: string;
  /** Null with no result yet or with a time missing. */
  readonly duration_ms: number | null;
  readonly outcome: "ok" | "failed" | "unknown";
}
