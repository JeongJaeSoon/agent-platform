import {
  countSessionsResponseSchema,
  installationLimitsResponseSchema,
  type UsageSummaryResponse,
  usageSummaryResponseSchema,
} from "@werft-ai/contracts";
import type { UsageTool, UsageToolCall } from "@werft-ai/react/components";

import {
  BASH_CALLS,
  BASH_PER_DAY,
  COUNTS,
  TOOLS,
} from "../domain/operations/operations-fixtures.ts";

/*
 * The operations design's example data (ops-console
 * ccdeck-features-design.html `DATA`) as API responses. Existing APIs are
 * parsed with their contracts schema; the new ones (T5–T7) are typed with the
 * proposed shape. Display values are derived in the story, never stored here.
 */

export const LIMITS = installationLimitsResponseSchema.parse({
  scope: "installation",
  refreshed_at: "2026-10-24T12:40:00Z",
  limits: {
    execution_slot_limit: 10,
    queued_input_limit_per_session: 20,
    storage_limit_bytes: 10737418240,
    max_turn_seconds: 3600,
    session_cost_limit_usd: "25.00",
    session_token_limit: null,
    provider_max_retries: 3,
  },
  usage: {
    execution_slots_used: 7,
    queued_input_count: 4,
    storage: {
      used_bytes: 2147483648,
      accounted_content: ["input_messages"],
      updated_at: "2026-10-24T12:31:00Z",
    },
    outputs: { used_bytes: 0, updated_at: null, complete: true },
  },
});

export const SESSION_COUNTS = countSessionsResponseSchema.parse({
  counts: COUNTS,
  total: Object.values(COUNTS).reduce((sum, n) => sum + n, 0),
});

// Proposed GET /v1/usage/series (T5).
export interface UsageSeriesBucket {
  readonly date: string;
  readonly session_count: number;
  readonly cost_usd: string;
  readonly cost_complete: boolean;
  readonly token_count: number;
  readonly run_seconds: number;
}
export interface UsageSeriesResponse {
  readonly period: { readonly since: string; readonly until: string };
  readonly refreshed_at: string;
  readonly buckets: readonly UsageSeriesBucket[];
}

// Proposed GET /v1/usage/breakdown (T6), one response per `by`.
const TOKEN_COLUMNS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;
export type TokenColumn = (typeof TOKEN_COLUMNS)[number];
export type UsageBreakdownFigures = Record<TokenColumn, number> & {
  readonly session_count: number;
  readonly token_count: number;
  readonly cost_usd: string;
};
export type UsageBreakdownRow = UsageBreakdownFigures & {
  readonly key: string;
  readonly label: string;
};
export interface UsageBreakdownResponse {
  readonly rows: readonly UsageBreakdownRow[];
  readonly totals: UsageBreakdownFigures;
}

const DAY_MS = 86_400_000;
// The design's last bucket is 2026-10-23, the day before it was read.
const LAST_DAY = Date.UTC(2026, 9, 23);

/**
 * `days` buckets ending 2026-10-23 with the design's curves: the 30-day run
 * is the design's own. `partial` lists the bucket indexes whose cost is not
 * all reported; the design marks 10/6 and 10/23.
 */
export function series(
  days: number,
  partial: readonly number[] = [days - 1, days - 18],
): UsageSeriesResponse {
  const offset = 30 - days;
  const buckets = Array.from({ length: days }, (_, n) => {
    const i = n + offset;
    const weekend = ((i % 7) + 7) % 7 === 5 || ((i % 7) + 7) % 7 === 6;
    const sessions = Math.max(
      2,
      Math.round(13 + 5 * Math.sin(i / 2.6) + (weekend ? -8 : 0) + i * 0.15),
    );
    const cost = Math.max(
      6,
      28 + 14 * Math.sin(i / 3.2) + (weekend ? -18 : 0) + i * 0.6,
    );
    const tokens = Math.round(cost * 37000 * (1 + 0.25 * Math.cos(i / 1.7)));
    const run = Math.round(sessions * 540 * (1 + 0.4 * Math.sin(i / 4.1 + 1)));
    return {
      date: new Date(LAST_DAY - (days - 1 - n) * DAY_MS)
        .toISOString()
        .slice(0, 10),
      session_count: sessions,
      cost_usd: cost.toFixed(2),
      cost_complete: !partial.includes(n),
      token_count: tokens,
      run_seconds: run,
    };
  });
  return {
    period: {
      since: `${buckets[0]?.date ?? "2026-10-23"}T00:00:00Z`,
      until: "2026-10-24T00:00:00Z",
    },
    refreshed_at: "2026-10-24T12:40:00Z",
    buckets,
  };
}

/**
 * GET /v1/usage/summary for the same period: the buckets' sums, as T5
 * promises.
 */
export function summaryOf(
  response: UsageSeriesResponse,
  scope: UsageSummaryResponse["scope"] = "installation",
): UsageSummaryResponse {
  const { buckets } = response;
  return usageSummaryResponseSchema.parse({
    scope,
    period: response.period,
    refreshed_at: response.refreshed_at,
    session_count: buckets.reduce((sum, b) => sum + b.session_count, 0),
    run_seconds: buckets.reduce((sum, b) => sum + b.run_seconds, 0),
    cost_usd: buckets
      .reduce((sum, b) => sum + Number(b.cost_usd), 0)
      .toFixed(2),
    cost_complete: buckets.every((b) => b.cost_complete),
    token_count: buckets.reduce((sum, b) => sum + b.token_count, 0),
    basis: {
      sessions: "created_in_period",
      cost: "provider_usage_estimate",
      run_time: "turn_wall_clock",
    },
  });
}

// Largest remainder: whole parts of `total` in proportion to `weights`.
function apportion(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  const left = total - out.reduce((a, b) => a + b, 0);
  raw
    .map((r, i) => [r - Math.floor(r), i] as const)
    .sort((a, b) => b[0] - a[0])
    .slice(0, left)
    .forEach(([, i]) => {
      out[i] = (out[i] ?? 0) + 1;
    });
  return out;
}

const MODELS = [
  { key: "claude-opus-5-5", price: 3.2, mix: [0.2, 0.08, 0.64, 0.08] },
  { key: "claude-sonnet-5-5", price: 1, mix: [0.21, 0.07, 0.65, 0.07] },
  { key: "claude-haiku-5-5", price: 0.75, mix: [0.2, 0.06, 0.67, 0.07] },
] as const;
// [key, label, sessions, tokens, share per MODELS entry]
const AGENTS = [
  ["agt_review", "리뷰 봇", 131, 17.2, [0.6, 0.35, 0.05]],
  ["agt_oncall", "온콜 보조", 64, 11, [0.55, 0.35, 0.1]],
  ["agt_deploy", "배포 도우미", 88, 8.8, [0.35, 0.5, 0.15]],
  ["agt_query", "데이터 질의", 79, 6.4, [0.2, 0.6, 0.2]],
  ["agt_docs", "문서 정리", 50, 4.7, [0.1, 0.55, 0.35]],
] as const;

/**
 * by=model and by=agent grouped from one set of (model, agent) source rows
 * apportioned from the summary, so both totals match it column by column.
 */
export function breakdown(summary: UsageSummaryResponse): {
  readonly model: UsageBreakdownResponse;
  readonly agent: UsageBreakdownResponse;
} {
  const source = AGENTS.flatMap(([key, label, sessions, tokens, share]) =>
    MODELS.map((model, j) => ({
      agent: { key, label },
      model: { key: model.key, label: model.key },
      sw: sessions * (share[j] ?? 0),
      tw: tokens * (share[j] ?? 0),
      model_: model,
    })),
  );
  const sessions = apportion(
    summary.session_count,
    source.map((r) => r.sw),
  );
  const cents = apportion(
    Math.round(Number(summary.cost_usd) * 100),
    source.map((r) => r.tw * r.model_.price),
  );
  const columnTotals = apportion(
    summary.token_count,
    TOKEN_COLUMNS.map((_, c) =>
      source.reduce((a, r) => a + r.tw * (r.model_.mix[c] ?? 0), 0),
    ),
  );
  const columns = TOKEN_COLUMNS.map((_, c) =>
    apportion(
      columnTotals[c] ?? 0,
      source.map((r) => r.tw * (r.model_.mix[c] ?? 0)),
    ),
  );
  type Acc = Record<TokenColumn, number> & {
    session_count: number;
    token_count: number;
    cents: number;
  };
  const blank = (): Acc => ({
    session_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    token_count: 0,
    cents: 0,
  });
  const add = (acc: Acc, i: number) => {
    acc.session_count += sessions[i] ?? 0;
    TOKEN_COLUMNS.forEach((column, c) => {
      const n = columns[c]?.[i] ?? 0;
      acc[column] += n;
      acc.token_count += n;
    });
    acc.cents += cents[i] ?? 0;
  };
  const finish = ({ cents: c, ...rest }: Acc): UsageBreakdownFigures => ({
    ...rest,
    cost_usd: (c / 100).toFixed(2),
  });
  const group = (by: "model" | "agent"): UsageBreakdownResponse => {
    const rows = new Map<string, { key: string; label: string; acc: Acc }>();
    const totals = blank();
    source.forEach((row, i) => {
      const { key, label } = row[by];
      const entry = rows.get(key) ?? { key, label, acc: blank() };
      rows.set(key, entry);
      add(entry.acc, i);
      add(totals, i);
    });
    return {
      rows: [...rows.values()]
        .map(({ key, label, acc }) => ({ key, label, ...finish(acc) }))
        .sort((a, b) => Number(b.cost_usd) - Number(a.cost_usd)),
      totals: finish(totals),
    };
  };
  return { model: group("model"), agent: group("agent") };
}

/**
 * The rail of any selected tool: the design only drew Bash's, so the others
 * take its curve and calls scaled to their own figures, and a tool that never
 * failed shows no failed call.
 */
export function toolDetail(tool: UsageTool): {
  readonly calls: readonly UsageToolCall[];
  readonly perDay: readonly { readonly date: string; readonly calls: number }[];
} {
  const bash = TOOLS.tools.find((t) => t.name === "Bash") ?? tool;
  const share = tool.calls / bash.calls;
  const pace = tool.median_ms / bash.median_ms;
  return {
    perDay: BASH_PER_DAY.map((d) => ({
      date: d.date,
      calls: Math.round(d.calls * share),
    })),
    calls: BASH_CALLS.map((call) => ({
      ...call,
      duration_ms:
        call.duration_ms === null
          ? null
          : Math.min(tool.max_ms, Math.round(call.duration_ms * pace)),
      outcome:
        tool.failed === 0 && call.outcome === "failed" ? "ok" : call.outcome,
    })),
  };
}
