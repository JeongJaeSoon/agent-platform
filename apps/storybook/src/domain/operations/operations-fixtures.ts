import type { CountSessionsResponse } from "@werft-ai/contracts";
import type {
  UsageToolCall,
  UsageToolsResponse,
} from "@werft-ai/react/components";

/*
 * The operations design's example data (ops-console
 * ccdeck-features-design.html `DATA`), in the response shapes the parts take.
 * The screens stories derive everything else from these.
 */

export const COUNTS: CountSessionsResponse["counts"] = {
  queued: 2,
  running: 7,
  needs_input: 3,
  idle: 41,
  failed: 1,
  stopped: 12,
};

export const SLOTS = { used: 7, limit: 10 } as const;

export const TOOLS: UsageToolsResponse = {
  tools: [
    {
      name: "Bash",
      calls: 1840,
      failed: 21,
      total_ms: 13320000,
      median_ms: 3100,
      max_ms: 298000,
      description: null,
    },
    {
      name: "Read",
      calls: 1204,
      failed: 2,
      total_ms: 1080000,
      median_ms: 400,
      max_ms: 9100,
      description: null,
    },
    {
      name: "Edit",
      calls: 702,
      failed: 12,
      total_ms: 1620000,
      median_ms: 900,
      max_ms: 14200,
      description: null,
    },
    {
      name: "Grep",
      calls: 611,
      failed: 1,
      total_ms: 900000,
      median_ms: 600,
      max_ms: 21000,
      description: null,
    },
    {
      name: "WebFetch",
      calls: 214,
      failed: 1,
      total_ms: 3960000,
      median_ms: 12400,
      max_ms: 61000,
      description: null,
    },
    {
      name: "Task",
      calls: 141,
      failed: 0,
      total_ms: 1200000,
      median_ms: 7800,
      max_ms: 184000,
      description: null,
    },
    {
      name: "mcp__linear__get_issue",
      calls: 100,
      failed: 0,
      total_ms: 240000,
      median_ms: 1900,
      max_ms: 8800,
      description: "Retrieve detailed information about an issue by ID",
    },
  ],
  findings: [
    { kind: "most_time", name: "Bash" },
    { kind: "fails_often", name: "Edit" },
    { kind: "slowest", name: "WebFetch" },
  ],
};

// Display-only text, not API fields.
export const TOOL_NOTE: Readonly<
  Record<string, Record<"ko" | "ja" | "en", string>>
> = {
  Bash: { ko: "셸 명령", ja: "シェルコマンド", en: "Shell command" },
  Read: { ko: "파일 읽기", ja: "ファイル読み取り", en: "Read a file" },
  Edit: { ko: "파일 고치기", ja: "ファイル編集", en: "Edit a file" },
  Grep: { ko: "내용 찾기", ja: "内容検索", en: "Search contents" },
  WebFetch: {
    ko: "웹 페이지 읽기",
    ja: "Webページ読み取り",
    en: "Read a web page",
  },
  Task: { ko: "서브에이전트", ja: "サブエージェント", en: "Subagent" },
  mcp__linear__get_issue: { ko: "MCP 도구", ja: "MCPツール", en: "MCP tool" },
};

export const BASH_CALLS: readonly UsageToolCall[] = [
  {
    occurred_at: "2026-10-24T12:39:10Z",
    agent: "리뷰 봇",
    session_id: "ses_05",
    title: "PR #813 리뷰",
    duration_ms: null,
    outcome: "unknown",
  },
  {
    occurred_at: "2026-10-24T12:38:02Z",
    agent: "리뷰 봇",
    session_id: "ses_01",
    title: "PR #812 리뷰",
    duration_ms: 2900,
    outcome: "ok",
  },
  {
    occurred_at: "2026-10-24T12:36:41Z",
    agent: "배포 도우미",
    session_id: null,
    title: null,
    duration_ms: 41200,
    outcome: "ok",
  },
  {
    occurred_at: "2026-10-24T12:31:15Z",
    agent: "리뷰 봇",
    session_id: "ses_02",
    title: "PR #811 리뷰",
    duration_ms: 3400,
    outcome: "failed",
  },
  {
    occurred_at: "2026-10-24T12:29:50Z",
    agent: "온콜 보조",
    session_id: null,
    title: null,
    duration_ms: 1800,
    outcome: "ok",
  },
  {
    occurred_at: "2026-10-24T12:25:33Z",
    agent: "문서 정리",
    session_id: "ses_04",
    title: "릴리스 노트 초안",
    duration_ms: 2100,
    outcome: "unknown",
  },
  {
    occurred_at: "2026-10-24T12:22:07Z",
    agent: "데이터 질의",
    session_id: "ses_03",
    title: "주간 가입자 집계",
    duration_ms: 6200,
    outcome: "ok",
  },
];

export const BASH_PER_DAY = [
  52, 61, 70, 44, 18, 12, 66, 73, 80, 69, 75, 21, 15, 64,
].map((calls, i) => ({
  date: `2026-10-${String(10 + i).padStart(2, "0")}`,
  calls,
}));
