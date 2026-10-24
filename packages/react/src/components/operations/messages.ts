import type { SessionStatus } from "@werft-ai/contracts";

import type { Locale } from "../../messages/index.ts";

/*
 * The operations parts' own wording and number formats, one set per locale,
 * so a screen passes data alone. A host replaces any entry through the
 * part's `messages`.
 */

export interface OperationsFormat {
  readonly count: (n: number) => string;
  /** Seconds as hours and minutes: "64시간 3분". */
  readonly duration: (seconds: number) => string;
  /** Milliseconds, seconds under a minute: "3.1초", else as `duration`. */
  readonly elapsed: (ms: number) => string;
  /** a / b as "1.7%". */
  readonly percent: (a: number, b: number) => string;
}

export interface SessionCountsMessages {
  readonly title: string;
  readonly description: string;
  readonly status: (status: SessionStatus) => string;
  readonly slots: string;
  readonly slotsUsed: (
    used: string,
    limit: string,
  ) => readonly [string, string];
  readonly slotsMeter: string;
  readonly loading: string;
}

export interface FindingsMessages {
  readonly most_time: string;
  readonly fails_often: string;
  readonly slowest: string;
  readonly mostTimeDetail: (total: string, share: number) => string;
  readonly failsOftenDetail: (
    calls: string,
    failed: string,
    rate: string,
  ) => string;
  readonly slowestDetail: (median: string, calls: string) => string;
  readonly empty: string;
}

export interface ToolTableMessages {
  readonly name: string;
  readonly calls: string;
  readonly total: string;
  readonly median: string;
  readonly failed: string;
  readonly open: (name: string) => string;
  readonly callsMeter: (name: string) => string;
  readonly empty: string;
  readonly loading: string;
}

export interface ToolsSummaryMessages {
  /** The parts of "… <b>1,840번</b> … <b>4시간</b> … <bad>21번 실패</bad> …". */
  readonly sentence: (parts: {
    readonly period: string;
    readonly calls: string;
    readonly time: string;
    readonly failed: string;
    readonly rate: string;
  }) => readonly (
    | string
    | { readonly strong: string }
    | { readonly danger: string }
  )[];
}

export interface ToolCallsMessages {
  readonly note: string;
  readonly hidden: string;
  readonly outcome: {
    readonly ok: string;
    readonly failed: string;
    readonly unknown: string;
  };
  readonly none: string;
  readonly empty: string;
}

export interface OperationsMessages {
  readonly format: OperationsFormat;
  readonly sessionCounts: SessionCountsMessages;
  readonly findings: FindingsMessages;
  readonly toolTable: ToolTableMessages;
  readonly toolsSummary: ToolsSummaryMessages;
  readonly toolCalls: ToolCallsMessages;
}

function format(
  locale: Locale,
  hours: (h: number, m: number) => string,
  minutes: (m: number) => string,
  seconds: (s: string) => string,
): OperationsFormat {
  const nf = new Intl.NumberFormat(locale === "ko" ? "ko-KR" : locale);
  const duration = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? hours(h, m) : minutes(m);
  };
  return {
    count: (n) => nf.format(n),
    duration,
    elapsed: (ms) =>
      ms >= 60000 ? duration(ms / 1000) : seconds((ms / 1000).toFixed(1)),
    percent: (a, b) => `${(b ? (100 * a) / b : 0).toFixed(1)}%`,
  };
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
  running: "Running",
  needs_input: "Needs input",
  idle: "Idle",
  failed: "Failed",
  stopped: "Stopped",
};

export const OPERATIONS_MESSAGES: Readonly<Record<Locale, OperationsMessages>> =
  {
    ko: {
      format: format(
        "ko",
        (h, m) => `${h}시간 ${m}분`,
        (m) => `${m}분`,
        (s) => `${s}초`,
      ),
      sessionCounts: {
        title: "지금 · 내가 볼 수 있는 세션",
        description:
          "공유받았거나 내가 시작한 세션만 셉니다 · 상태를 누르면 세션 목록으로 갑니다 · 30초마다 새로 읽음",
        status: (status) => STATUS_KO[status],
        slots: "동시 실행 slot · 설치 전체",
        slotsUsed: (used, limit) => [used, ` / ${limit} 사용`],
        slotsMeter: "동시 실행 slot 사용률, 설치 전체",
        loading: "세션 수를 읽는 중",
      },
      findings: {
        most_time: "가장 오래 걸리는 도구: ",
        fails_often: "자주 실패하는 도구: ",
        slowest: "가장 느린 도구: ",
        mostTimeDetail: (total, share) =>
          `${total} · 전체 도구 시간의 ${share}%`,
        failsOftenDetail: (calls, failed, rate) =>
          `${calls}번 중 ${failed}번 실패 (${rate})`,
        slowestDetail: (median, calls) => `보통 ${median} · 호출 ${calls}번`,
        empty: "이 기간에 살펴볼 도구가 없습니다.",
      },
      toolTable: {
        name: "이름",
        calls: "호출",
        total: "총 시간",
        median: "보통",
        failed: "실패",
        open: (name) => `${name} 자세히 보기`,
        callsMeter: (name) => `${name} 호출 비율`,
        empty: "이 기간에 불린 도구가 없습니다.",
        loading: "도구 목록을 읽는 중",
      },
      toolsSummary: {
        sentence: ({ period, calls, time, failed, rate }) => [
          `${period} 동안 에이전트가 도구를 `,
          { strong: `${calls}번` },
          " 불렀고 실행에 ",
          { strong: time },
          "을 썼습니다. ",
          { danger: `${failed}번 실패` },
          `했습니다 (${rate}).`,
        ],
      },
      toolCalls: {
        note: "볼 수 없는 세션은 제목과 링크 없이 시간만 보입니다",
        hidden: "볼 수 없는 세션",
        outcome: { ok: "완료", failed: "실패", unknown: "결과 모름" },
        none: "—",
        empty: "이 기간에 부른 기록이 없습니다.",
      },
    },
    ja: {
      format: format(
        "ja",
        (h, m) => `${h}時間${m}分`,
        (m) => `${m}分`,
        (s) => `${s}秒`,
      ),
      sessionCounts: {
        title: "現在 · 閲覧できるセッション",
        description:
          "共有されたか自分が開始したセッションのみ数えます · 状態を押すとセッション一覧へ移動します · 30秒ごとに再読み込み",
        status: (status) => STATUS_JA[status],
        slots: "同時実行スロット · インストール全体",
        slotsUsed: (used, limit) => [used, ` / ${limit} 使用中`],
        slotsMeter: "同時実行スロット使用率、インストール全体",
        loading: "セッション数を読み込み中",
      },
      findings: {
        most_time: "最も時間がかかるツール: ",
        fails_often: "よく失敗するツール: ",
        slowest: "最も遅いツール: ",
        mostTimeDetail: (total, share) =>
          `${total} · ツール時間全体の${share}%`,
        failsOftenDetail: (calls, failed, rate) =>
          `${calls}回中${failed}回失敗 (${rate})`,
        slowestDetail: (median, calls) =>
          `中央値 ${median} · 呼び出し${calls}回`,
        empty: "この期間に確認するツールはありません。",
      },
      toolTable: {
        name: "名前",
        calls: "呼び出し",
        total: "合計時間",
        median: "中央値",
        failed: "失敗",
        open: (name) => `${name} の詳細を見る`,
        callsMeter: (name) => `${name} の呼び出し比率`,
        empty: "この期間に呼ばれたツールはありません。",
        loading: "ツール一覧を読み込み中",
      },
      toolsSummary: {
        sentence: ({ period, calls, time, failed, rate }) => [
          `${period}、エージェントはツールを`,
          { strong: `${calls}回` },
          "呼び出し、実行に",
          { strong: time },
          "を使いました。",
          { danger: `${failed}回失敗` },
          `しました (${rate})。`,
        ],
      },
      toolCalls: {
        note: "閲覧できないセッションはタイトルとリンクなしで時間のみ表示します",
        hidden: "閲覧できないセッション",
        outcome: { ok: "完了", failed: "失敗", unknown: "結果不明" },
        none: "—",
        empty: "この期間の呼び出し記録はありません。",
      },
    },
    en: {
      format: format(
        "en",
        (h, m) => `${h}h ${m}m`,
        (m) => `${m}m`,
        (s) => `${s}s`,
      ),
      sessionCounts: {
        title: "Now · Sessions you can see",
        description:
          "Counts only sessions shared with you or started by you · Pick a status to open the session list · Refreshed every 30 seconds",
        status: (status) => STATUS_EN[status],
        slots: "Concurrent slots · Whole installation",
        slotsUsed: (used, limit) => [used, ` / ${limit} in use`],
        slotsMeter: "Concurrent slot use, whole installation",
        loading: "Loading session counts",
      },
      findings: {
        most_time: "Takes the most time: ",
        fails_often: "Fails often: ",
        slowest: "Slowest: ",
        mostTimeDetail: (total, share) =>
          `${total} · ${share}% of all tool time`,
        failsOftenDetail: (calls, failed, rate) =>
          `${failed} of ${calls} calls failed (${rate})`,
        slowestDetail: (median, calls) => `Median ${median} · ${calls} calls`,
        empty: "Nothing to look at in this period.",
      },
      toolTable: {
        name: "Name",
        calls: "Calls",
        total: "Total",
        median: "Median",
        failed: "Failed",
        open: (name) => `Show ${name}`,
        callsMeter: (name) => `${name} share of calls`,
        empty: "No tools were called in this period.",
        loading: "Loading tools",
      },
      toolsSummary: {
        sentence: ({ period, calls, time, failed, rate }) => [
          `In the ${period}, agents called tools `,
          { strong: `${calls} times` },
          " and spent ",
          { strong: time },
          " running them. ",
          { danger: `${failed} failed` },
          ` (${rate}).`,
        ],
      },
      toolCalls: {
        note: "Sessions you cannot see show only their times, with no title or link",
        hidden: "Session you cannot see",
        outcome: { ok: "Done", failed: "Failed", unknown: "Unknown" },
        none: "—",
        empty: "No calls in this period.",
      },
    },
  };
