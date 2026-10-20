import { describe, expect, test } from "bun:test";
import type { SessionEventPayload } from "@agent-platform/contracts";
import { type Translate, translate } from "../i18n/i18n.tsx";
import type { SessionEventFrame } from "./hooks.ts";
import { type TimelineItem, timelineItems } from "./timeline.ts";

const t: Translate = (key, vars) => translate("ko", key, vars);
const AT = "2026-10-21T02:54:00.000Z";

let next = 0;
function frame(
  event: SessionEventPayload["event"],
  data: unknown,
  turnId: string | null = "1",
): SessionEventFrame {
  next += 1;
  return {
    id: `ev_${next}`,
    occurredAt: AT,
    turnId,
    payload: { event, data } as SessionEventPayload,
  };
}

const system = (subtype: string, extra: object = {}) =>
  frame("system", { type: "system", subtype, ...extra });
const assistant = (...content: object[]) =>
  frame("assistant", { type: "assistant", message: { content } });
const toolUse = (id: string, name: string, input: object) =>
  frame("tool_use", {
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });

function lines(
  events: SessionEventFrame[],
  debug = false,
): Pick<TimelineItem, "label" | "summary" | "detail" | "error">[] {
  return timelineItems(t, events, { debug }).map(
    ({ label, summary, detail, error }) => ({
      label,
      summary,
      ...(detail === undefined ? {} : { detail }),
      ...(error === undefined ? {} : { error }),
    }),
  );
}

describe("session timeline", () => {
  test("every kind gets a label in words and a one-line body", () => {
    const items = timelineItems(
      t,
      [
        frame("status", { phase: "running" }),
        frame("status", { phase: "interrupting" }),
        system("init"),
        system("vcs_state_changed"),
        system("compact_boundary"),
        assistant({ type: "text", text: "Listing files" }),
        toolUse("tu_1", "Bash", { command: "ls" }),
        frame("tool_result", {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: "a.txt",
        }),
        frame("question", {
          request_id: "req_1",
          tool_use_id: "tu_1",
          kind: "permission",
          tool: "Bash",
          input: { command: "ls" },
        }),
        frame("result", {
          type: "result",
          subtype: "success",
          session_id: "s",
        }),
        frame("error", { message: "engine crashed" }),
      ],
      { debug: false },
    );
    expect(items.map((item) => [item.label, item.summary])).toEqual([
      ["상태", "작업 중"],
      ["상태", "멈추는 중"],
      ["시스템", "세션 시작"],
      ["시스템", "작업 트리 변경"],
      ["시스템", "compact_boundary"],
      ["응답", "Listing files"],
      ["도구 호출", "Bash: ls"],
      ["도구 결과", "Bash 결과 · 성공 · a.txt"],
      ["권한 요청", "Bash: ls"],
      ["turn 끝", "turn 완료"],
      ["오류", "engine crashed"],
    ]);
    for (const item of items) expect(item.summary).not.toBe("");
  });

  test("a run of thinking ticks in one turn is one line with its count", () => {
    const ticks = Array.from({ length: 52 }, () => system("thinking_tokens"));
    const items = timelineItems(t, ticks, { debug: false });
    expect(items).toHaveLength(1);
    expect(items[0]?.summary).toBe("생각 중 (52)");
    // The row keeps the run's first key, so it does not remount as it grows.
    expect(items[0]?.key).toBe(ticks[0]?.id);

    expect(
      lines([
        system("thinking_tokens"),
        system("thinking_tokens"),
        assistant({ type: "text", text: "done" }),
        system("thinking_tokens"),
        system("thinking_tokens", {}),
      ]).map((line) => line.summary),
    ).toEqual(["생각 중 (2)", "done", "생각 중 (2)"]);

    expect(
      timelineItems(
        t,
        [
          system("thinking_tokens"),
          frame(
            "system",
            {
              type: "system",
              subtype: "thinking_tokens",
            },
            "2",
          ),
        ],
        { debug: false },
      ).map((item) => item.summary),
    ).toEqual(["생각 중 (1)", "생각 중 (1)"]);
  });

  test("SDK bookkeeping shows only with the debug toggle on", () => {
    const events = [
      system("sdk_event", { native_type: "command_lifecycle" }),
      frame("status", { phase: "idle" }),
    ];
    expect(lines(events)).toEqual([{ label: "상태", summary: "쉬는 중" }]);
    expect(lines(events, true)).toEqual([
      { label: "내부", summary: "command_lifecycle" },
      { label: "상태", summary: "쉬는 중" },
    ]);
  });

  test("hidden bookkeeping does not split a run of thinking ticks", () => {
    expect(
      lines([
        system("thinking_tokens"),
        system("sdk_event", { native_type: "command_lifecycle" }),
        system("thinking_tokens"),
      ]),
    ).toEqual([{ label: "생각", summary: "생각 중 (2)" }]);
  });

  test("an assistant message with only thinking or only a tool call still says what it was", () => {
    expect(
      lines([
        assistant({ type: "thinking", thinking: "" }),
        assistant({ type: "thinking", thinking: "Check the README first." }),
        assistant({
          type: "tool_use",
          id: "tu_9",
          name: "Write",
          input: { file_path: "/repo/notes.md", content: "x" },
        }),
      ]),
    ).toEqual([
      { label: "생각", summary: "생각함" },
      {
        label: "생각",
        summary: "생각함",
        detail: "Check the README first.",
      },
      { label: "도구 호출", summary: "Write: /repo/notes.md" },
    ]);
  });

  test("a tool call is summarised by what its input is about, cut short", () => {
    const long = `echo ${"x".repeat(200)}`;
    expect(
      lines([
        toolUse("a", "Bash", { command: "rm -rf build", description: "Clean" }),
        toolUse("b", "Bash", { command: `${long}\nsecond line` }),
        toolUse("c", "Grep", { pattern: "TODO" }),
        toolUse("d", "TodoWrite", { todos: [] }),
      ]).map((line) => line.summary),
    ).toEqual([
      "Bash: Clean",
      `Bash: ${long.slice(0, 80)}…`,
      "Grep: TODO",
      "TodoWrite",
    ]);
  });

  test("a tool result names its call, its outcome, first line and length", () => {
    expect(
      lines([
        toolUse("tu_1", "Bash", { command: "make" }),
        frame("tool_result", {
          type: "tool_result",
          tool_use_id: "tu_1",
          is_error: true,
          content: [
            { type: "text", text: "make: *** No rule\nline 2\nline 3" },
          ],
        }),
        frame("tool_result", {
          type: "tool_result",
          tool_use_id: "unknown",
          content: "",
        }),
      ]).slice(1),
    ).toEqual([
      {
        label: "도구 결과",
        summary: "Bash 결과 · 오류 · make: *** No rule · 3줄",
        error: true,
      },
      { label: "도구 결과", summary: "도구 결과 · 성공", error: false },
    ]);
  });

  test("a turn result shows its token count when usage is there", () => {
    const result = (data: object) =>
      frame("result", { type: "result", session_id: "s", ...data });
    expect(
      lines([
        result({
          subtype: "success",
          usage: { input_tokens: 120, output_tokens: 30 },
        }),
        result({ subtype: "success" }),
        result({ subtype: "error_max_turns", is_error: true }),
      ]),
    ).toEqual([
      { label: "turn 끝", summary: "turn 완료 · 토큰 150", error: false },
      { label: "turn 끝", summary: "turn 완료", error: false },
      {
        label: "turn 끝",
        summary: "turn 끝남(error_max_turns)",
        error: true,
      },
    ]);
  });

  test("a question says what it asks", () => {
    const question = (data: object) =>
      frame("question", { request_id: "r", tool_use_id: "u", ...data });
    expect(
      lines([
        question({
          kind: "permission",
          tool: "Edit",
          input: { file_path: "/repo/a.ts" },
        }),
        question({
          kind: "question",
          tool: "AskUserQuestion",
          input: {
            questions: [{ question: "Which branch?" }, { question: "Why?" }],
          },
        }),
      ]),
    ).toEqual([
      { label: "권한 요청", summary: "Edit: /repo/a.ts" },
      { label: "질문", summary: "Which branch? / Why?" },
    ]);
  });
});
