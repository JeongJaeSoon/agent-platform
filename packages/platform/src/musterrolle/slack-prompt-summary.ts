import { MCP_TOOL_PREFIX, type UserLocale } from "@werft-ai/contracts";
import type { ToolSummaryContext } from "../ports/pending-requests.ts";

type SummaryCopy = {
  runCommand: string;
  editFile: string;
  writeFile: string;
  readFile: string;
  findFiles: string;
  searchContents: string;
  readWebPage: string;
  searchWeb: string;
  requestPush: string;
  openPullRequest: string;
  updatePullRequest: string;
  commentPullRequest: string;
  closePullRequest: string;
  reopenPullRequest: string;
  attachRepository: string;
  /** `{tool}`: the tool's name. */
  useTool: string;
  /** `{server}` and `{tool}`: a remote MCP server's tool. */
  useMcpTool: string;
};

// Product copy: plain words, no internal module names.
export const SLACK_SUMMARY_MESSAGES: Readonly<Record<UserLocale, SummaryCopy>> =
  {
    ko: {
      runCommand: "명령 실행",
      editFile: "파일 수정",
      writeFile: "파일 쓰기",
      readFile: "파일 읽기",
      findFiles: "파일 찾기",
      searchContents: "내용 찾기",
      readWebPage: "웹 페이지 읽기",
      searchWeb: "웹 검색",
      requestPush: "push 요청",
      openPullRequest: "PR 열기",
      updatePullRequest: "PR 고치기",
      commentPullRequest: "PR에 댓글",
      closePullRequest: "PR 닫기",
      reopenPullRequest: "PR 다시 열기",
      attachRepository: "저장소 붙이기",
      useTool: "{tool} 도구 사용",
      useMcpTool: "{server}의 {tool} 도구 사용",
    },
    ja: {
      runCommand: "コマンド実行",
      editFile: "ファイル編集",
      writeFile: "ファイル作成",
      readFile: "ファイル読み取り",
      findFiles: "ファイル検索",
      searchContents: "内容検索",
      readWebPage: "Webページ読み取り",
      searchWeb: "Web検索",
      requestPush: "push依頼",
      openPullRequest: "PR作成",
      updatePullRequest: "PR更新",
      commentPullRequest: "PRにコメント",
      closePullRequest: "PRをクローズ",
      reopenPullRequest: "PRを再オープン",
      attachRepository: "リポジトリ追加",
      useTool: "{tool}ツールの使用",
      useMcpTool: "{server}の{tool}ツールの使用",
    },
    en: {
      runCommand: "Run a command",
      editFile: "Edit a file",
      writeFile: "Write a file",
      readFile: "Read a file",
      findFiles: "Find files",
      searchContents: "Search contents",
      readWebPage: "Read a web page",
      searchWeb: "Search the web",
      requestPush: "Request a push",
      openPullRequest: "Open a PR",
      updatePullRequest: "Update a PR",
      commentPullRequest: "Comment on a PR",
      closePullRequest: "Close a PR",
      reopenPullRequest: "Reopen a PR",
      attachRepository: "Attach a repository",
      useTool: "Use the {tool} tool",
      useMcpTool: "Use the {tool} tool of {server}",
    },
  };

const VERB_MAX = 100;
const TARGET_MAX = 200;
const COMMAND_MAX = 120;
const URL_PATH_MAX = 40;
const GITHUB = `${MCP_TOOL_PREFIX}github__`;

/**
 * `excerpt`: the first lines of what a file tool writes, so a person sees
 * the content without opening the raw input; null for other tools.
 */
export type ToolSummary = {
  verb: string;
  target: string | null;
  excerpt: string | null;
};

const EXCERPT_LINES = 3;
const EXCERPT_MAX = 300;

/** At most EXCERPT_MAX characters, a trailing "…" line when there is more. */
function excerptOf(text: string | null): string | null {
  if (text === null) return null;
  const lines = text.split("\n");
  const more = lines.length > EXCERPT_LINES;
  const head = clip(
    lines
      .slice(0, EXCERPT_LINES)
      .map((line) => clip(line, COMMAND_MAX))
      .join("\n"),
    more ? EXCERPT_MAX - 2 : EXCERPT_MAX,
  );
  return more && !head.endsWith("…") ? `${head}\n…` : head;
}

/** A string field as written, whitespace kept; null when blank. */
function content(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** An edit's new text; the first of several, with "…" for the rest. */
function editedText(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const edits = (input as { edits?: unknown }).edits;
  if (!Array.isArray(edits)) return content(input, "new_string");
  const first = content(edits[0], "new_string");
  return first !== null && edits.length > 1 ? `${first}\n…` : first;
}

const clip = (value: string, max: number) => {
  const chars = [...value];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : value;
};

function field(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function firstLine(text: string | null): string | null {
  const line = text?.split("\n").find((part) => part.trim() !== "");
  return line === undefined ? null : clip(line.trim(), COMMAND_MAX);
}

function webTarget(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${clip(path, URL_PATH_MAX)}`;
  } catch {
    return null;
  }
}

/** `repository ← branch`, either side left out when unknown. */
function headOf(context: ToolSummaryContext): string | null {
  const parts = [context.repository, context.branch].filter(
    (part): part is string => part !== undefined && part !== "",
  );
  return parts.length === 0 ? null : parts.join(" ← ");
}

/**
 * The plain-words line a card shows over a tool's raw input: what the tool
 * does and what it does it to. It helps a person decide; the raw input
 * still goes with it, folded.
 */
export function summarizeToolRequest(
  tool: string,
  input: unknown,
  context: ToolSummaryContext,
  locale: UserLocale,
): ToolSummary {
  const copy = SLACK_SUMMARY_MESSAGES[locale];
  const summary = (
    verb: string,
    target: string | null,
    excerpt: string | null = null,
  ): ToolSummary => ({
    verb: clip(verb, VERB_MAX),
    target: target === null ? null : clip(target, TARGET_MAX),
    excerpt: excerptOf(excerpt),
  });
  switch (tool) {
    case "Bash":
      return summary(
        copy.runCommand,
        firstLine(field(input, "description") ?? field(input, "command")),
      );
    case "Edit":
    case "MultiEdit":
      return summary(
        copy.editFile,
        field(input, "file_path"),
        editedText(input),
      );
    case "NotebookEdit":
      return summary(
        copy.editFile,
        field(input, "notebook_path"),
        content(input, "new_source"),
      );
    case "Write":
      return summary(
        copy.writeFile,
        field(input, "file_path"),
        content(input, "content"),
      );
    case "Read":
      return summary(copy.readFile, field(input, "file_path"));
    case "Glob":
      return summary(copy.findFiles, field(input, "pattern"));
    case "Grep":
      return summary(copy.searchContents, field(input, "pattern"));
    case "WebFetch":
      return summary(copy.readWebPage, webTarget(field(input, "url")));
    case "WebSearch":
      return summary(copy.searchWeb, field(input, "query"));
  }
  const github = githubSummary(tool, input, context, copy);
  if (github !== null) return summary(github.verb, github.target);
  if (tool.startsWith(MCP_TOOL_PREFIX)) {
    const rest = tool.slice(MCP_TOOL_PREFIX.length);
    const split = rest.indexOf("__");
    if (split > 0 && split < rest.length - 2) {
      return summary(
        copy.useMcpTool
          .replace("{server}", rest.slice(0, split))
          .replace("{tool}", rest.slice(split + 2)),
        null,
      );
    }
  }
  return summary(copy.useTool.replace("{tool}", tool), null);
}

/** Null when the tool is no GitHub tool or nothing about it could be read. */
function githubSummary(
  tool: string,
  input: unknown,
  context: ToolSummaryContext,
  copy: SummaryCopy,
): Omit<ToolSummary, "excerpt"> | null {
  if (!tool.startsWith(GITHUB)) return null;
  const head = headOf(context);
  switch (tool.slice(GITHUB.length)) {
    case "request_push":
      return head === null ? null : { verb: copy.requestPush, target: head };
    case "open_pull_request": {
      const title = field(input, "title");
      const target =
        title === null ? head : head === null ? title : `${title} (${head})`;
      return target === null ? null : { verb: copy.openPullRequest, target };
    }
    case "update_pull_request":
      return head === null
        ? null
        : { verb: copy.updatePullRequest, target: head };
    case "comment_pull_request":
      return head === null
        ? null
        : { verb: copy.commentPullRequest, target: head };
    case "close_pull_request":
      return head === null
        ? null
        : { verb: copy.closePullRequest, target: head };
    case "reopen_pull_request":
      return head === null
        ? null
        : { verb: copy.reopenPullRequest, target: head };
    case "attach_repository":
      return context.repository === undefined
        ? null
        : { verb: copy.attachRepository, target: context.repository };
    default:
      return null;
  }
}
