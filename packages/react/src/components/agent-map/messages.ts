import type { SessionStatus } from "@werft-ai/contracts";

import type { Locale } from "../../messages/index.ts";
import type { Lane, MapEdgeKind, RunStatus, ToolCallState } from "./types.ts";

/**
 * The agent map's own wording, one set per locale, so a screen passes data
 * alone. A host replaces any entry through `messages`.
 */
export interface AgentMapMessages {
  readonly status: (status: SessionStatus) => string;
  readonly run: (status: RunStatus) => string;
  readonly toolState: (state: ToolCallState) => string;
  readonly lane: (lane: Exclude<Lane, "done">) => string;
  readonly done: string;
  readonly expandDone: string;
  readonly emptyLane: string;
  readonly waitingLabel: string;
  readonly waitingTitle: (count: number, minutes: number) => string;
  readonly waitingLine: (
    agent: string,
    title: string,
    minutes: number,
  ) => string;
  readonly open: string;
  readonly subagents: (count: number) => string;
  readonly tools: (count: number) => string;
  readonly errors: (count: number) => string;
  readonly approvals: (count: number) => string;
  readonly pinned: string;
  readonly ownRun: string;
  readonly sessionRun: string;
  readonly runTotals: (tools: number, subagents: number) => string;
  readonly noTools: string;
  readonly live: string;
  /** The text beside the edge: a visible badge, or read aloud only. */
  readonly edge: (kind: MapEdgeKind) => string;
  readonly delegationBadge: string;
  readonly relationNote: string;
  readonly timeline: string;
  readonly back: string;
  readonly relations: string;
  readonly loading: string;
}

const STATUS_KO: Record<SessionStatus, string> = {
  queued: "대기 중",
  running: "작업 중",
  needs_input: "답변 대기",
  idle: "쉬는 중",
  failed: "실패",
  stopped: "멈춤",
};
const STATUS_JA: Record<SessionStatus, string> = {
  queued: "待機中",
  running: "作業中",
  needs_input: "回答待ち",
  idle: "休止中",
  failed: "失敗",
  stopped: "停止",
};
const STATUS_EN: Record<SessionStatus, string> = {
  queued: "Queued",
  running: "Working",
  needs_input: "Needs answer",
  idle: "Idle",
  failed: "Failed",
  stopped: "Stopped",
};

export const AGENT_MAP_MESSAGES: Readonly<Record<Locale, AgentMapMessages>> = {
  ko: {
    status: (status) => STATUS_KO[status],
    run: (status) =>
      ({
        wait: "기다리는 중",
        run: "작업 중",
        idle: "대기",
        done: "끝남",
        failed: "실패",
      })[status],
    toolState: (state) =>
      ({
        ok: "성공",
        error: "실패",
        running: "실행 중",
        waiting: "승인 대기",
      })[state],
    lane: (lane) =>
      ({
        attention: "답변 필요",
        running: "작업 중",
        queued: "대기",
        idle: "쉬는 중",
      })[lane],
    done: "최근 종료",
    expandDone: "펼치기",
    emptyLane: "없음",
    waitingLabel: "내 답변을 기다리는 요청",
    waitingTitle: (count, minutes) =>
      `답변 대기 ${count} · 가장 오래 ${minutes}분`,
    waitingLine: (agent, title, minutes) =>
      `${agent} · ${title} · ${minutes}분째`,
    open: "보기",
    subagents: (count) => `· 하위 ${count}`,
    tools: (count) => `도구 ${count}`,
    errors: (count) => `오류 ${count}`,
    approvals: (count) => `승인 ${count}`,
    pinned: "자리 정리 대기",
    ownRun: "직접 호출",
    sessionRun: "세션 실행",
    runTotals: (tools, subagents) => `도구 ${tools} · 하위 ${subagents}`,
    noTools: "아직 도구 호출 없음",
    live: "실시간 · 마지막 이벤트",
    edge: (kind) =>
      ({
        delegation: "위임",
        approval: "승인 대기",
        request: "요청",
        response: "응답",
        waiting: "응답 대기",
      })[kind],
    delegationBadge: "Task",
    relationNote:
      "부모·자식 관계는 이 세션 안의 위임(parent_tool_use_id)만 뜻합니다.",
    timeline: "타임라인에서 전체 보기",
    back: "← 목록으로",
    relations: "세션 관계",
    loading: "에이전트 지도를 읽는 중",
  },
  ja: {
    status: (status) => STATUS_JA[status],
    run: (status) =>
      ({
        wait: "待機中",
        run: "作業中",
        idle: "待機",
        done: "完了",
        failed: "失敗",
      })[status],
    toolState: (state) =>
      ({
        ok: "成功",
        error: "失敗",
        running: "実行中",
        waiting: "承認待ち",
      })[state],
    lane: (lane) =>
      ({
        attention: "回答が必要",
        running: "作業中",
        queued: "待機",
        idle: "休止中",
      })[lane],
    done: "最近終了",
    expandDone: "展開",
    emptyLane: "なし",
    waitingLabel: "回答を待っているリクエスト",
    waitingTitle: (count, minutes) => `回答待ち ${count} · 最長 ${minutes}分`,
    waitingLine: (agent, title, minutes) =>
      `${agent} · ${title} · ${minutes}分経過`,
    open: "表示",
    subagents: (count) => `· サブ ${count}`,
    tools: (count) => `ツール ${count}`,
    errors: (count) => `エラー ${count}`,
    approvals: (count) => `承認 ${count}`,
    pinned: "並べ替え待ち",
    ownRun: "直接呼び出し",
    sessionRun: "セッション実行",
    runTotals: (tools, subagents) => `ツール ${tools} · サブ ${subagents}`,
    noTools: "まだツール呼び出しなし",
    live: "リアルタイム · 最終イベント",
    edge: (kind) =>
      ({
        delegation: "委任",
        approval: "承認待ち",
        request: "リクエスト",
        response: "応答",
        waiting: "応答待ち",
      })[kind],
    delegationBadge: "Task",
    relationNote:
      "親子関係はこのセッション内の委任(parent_tool_use_id)だけを表します。",
    timeline: "タイムラインですべて表示",
    back: "← 一覧へ",
    relations: "セッションの関係",
    loading: "エージェントマップを読み込み中",
  },
  en: {
    status: (status) => STATUS_EN[status],
    run: (status) =>
      ({
        wait: "Waiting",
        run: "Working",
        idle: "Idle",
        done: "Done",
        failed: "Failed",
      })[status],
    toolState: (state) =>
      ({
        ok: "succeeded",
        error: "failed",
        running: "running",
        waiting: "awaiting approval",
      })[state],
    lane: (lane) =>
      ({
        attention: "Needs answer",
        running: "Working",
        queued: "Queued",
        idle: "Idle",
      })[lane],
    done: "Recently ended",
    expandDone: "Expand",
    emptyLane: "None",
    waitingLabel: "Requests waiting for your answer",
    waitingTitle: (count, minutes) =>
      `${count} waiting · longest ${minutes} min`,
    waitingLine: (agent, title, minutes) =>
      `${agent} · ${title} · ${minutes} min`,
    open: "View",
    subagents: (count) => `· ${count} sub`,
    tools: (count) => `${count} tools`,
    errors: (count) => `${count} errors`,
    approvals: (count) => `${count} approval`,
    pinned: "Waiting to tidy",
    ownRun: "Direct calls",
    sessionRun: "Session run",
    runTotals: (tools, subagents) => `${tools} tools · ${subagents} sub`,
    noTools: "No tool calls yet",
    live: "Live · last event",
    edge: (kind) =>
      ({
        delegation: "Delegated",
        approval: "Awaiting approval",
        request: "Request",
        response: "Response",
        waiting: "Awaiting reply",
      })[kind],
    delegationBadge: "Task",
    relationNote:
      "Parent and child mean delegation inside this session (parent_tool_use_id) only.",
    timeline: "See all in the timeline",
    back: "← Back to list",
    relations: "Session relations",
    loading: "Loading the agent map",
  },
};
