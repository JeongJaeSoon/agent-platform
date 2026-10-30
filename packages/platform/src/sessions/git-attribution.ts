import {
  type ClaimGit,
  GITHUB_LOGIN_PATTERN,
  githubNoreplyEmail,
  type SessionGitHubAttribution,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import type {
  SessionAttributionRecord,
  SessionAttributionStore,
} from "../ports/session-attribution.ts";
import { requirePermitted, SessionServiceError } from "./session-service.ts";

/** The session's page in the console; null when the console has no origin. */
export function sessionUrlOf(
  consoleOrigin: string | null,
  sessionId: string,
): string | null {
  return consoleOrigin === null
    ? null
    : new URL(`/sessions/${sessionId}`, consoleOrigin).toString();
}

/**
 * The co-author a commit names, from the starter's GitHub link. Checked again
 * here, not trusted from the row: a value outside GitHub's own rules never
 * reaches a commit message.
 */
export function coAuthorOf(
  record: SessionAttributionRecord | null,
): { name: string; email: string } | null {
  const github = record?.starter?.github;
  if (!github) return null;
  if (!/^[1-9][0-9]{0,19}$/.test(github.id)) return null;
  if (!GITHUB_LOGIN_PATTERN.test(github.login)) return null;
  return {
    name: github.login,
    email: githubNoreplyEmail(github.id, github.login),
  };
}

export function claimGitOf(
  record: SessionAttributionRecord | null,
  consoleOrigin: string | null,
  sessionId: string,
): ClaimGit {
  return {
    co_author: coAuthorOf(record),
    session_url: sessionUrlOf(consoleOrigin, sessionId),
  };
}

export function attributionView(
  record: SessionAttributionRecord,
): SessionGitHubAttribution {
  const coAuthor = coAuthorOf(record);
  return {
    trigger: record.trigger,
    attribution:
      coAuthor !== null
        ? "co_author"
        : record.starter === null
          ? "app_only"
          : "unlinked",
    login: coAuthor?.name ?? null,
  };
}

/** The session detail's attribution line; whoever may read the session. */
export function createSessionAttributionService(deps: {
  authorization: AuthorizationPolicy;
  store: SessionAttributionStore;
}) {
  return {
    async get(
      caller: Caller,
      rawSessionId: string,
    ): Promise<SessionGitHubAttribution> {
      const sessionId = rawSessionId.toLowerCase();
      await requirePermitted(deps.authorization, caller, "session.read", {
        kind: "session",
        id: sessionId,
      });
      const record = await deps.store.attribution(sessionId);
      if (record === null || record.ownerId !== caller.ownerId) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return attributionView(record);
    },
  };
}

export type SessionAttributionService = ReturnType<
  typeof createSessionAttributionService
>;

/** Where the platform's part of a pull request body starts and ends. */
export const PULL_REQUEST_TAIL_MARKER = "<!-- agent-platform:pr-tail -->";
export const PULL_REQUEST_TAIL_END_MARKER = "<!-- /agent-platform:pr-tail -->";

/**
 * The pull request body's tail (decision 5): how to find the session again.
 * The body is anyone's to edit, so this is a pointer, never evidence.
 */
export function pullRequestTail(input: {
  sessionId: string;
  sessionUrl: string | null;
  commit: string;
  pushRequestId: string;
  record: SessionAttributionRecord | null;
}): string {
  const { record } = input;
  const coAuthor = coAuthorOf(record);
  const starter =
    record === null
      ? "unknown"
      : coAuthor !== null
        ? `GitHub account linked (@${coAuthor.name})`
        : record.starter === null
          ? "none (App only)"
          : "GitHub account not linked (App only)";
  const lines = [
    "---",
    PULL_REQUEST_TAIL_MARKER,
    `${TAIL_OPENING}\`${input.sessionId}\`, commit \`${input.commit}\`.`,
    "",
    ...(input.sessionUrl === null ? [] : [`- Session: ${input.sessionUrl}`]),
    `- Agent: ${record?.agentId ? `\`${record.agentId}\`` : "none"}, release ${record?.agentReleaseId ? `\`${record.agentReleaseId}\`` : "none"}`,
    `- Push request: \`${input.pushRequestId}\``,
    `- Trigger: ${record?.trigger ?? "unknown"}`,
    `- Started by: ${starter}`,
    ...(coAuthor === null
      ? []
      : ["", `Co-authored-by: ${coAuthor.name} <${coAuthor.email}>`]),
    PULL_REQUEST_TAIL_END_MARKER,
  ];
  return lines.join("\n");
}

const TAIL_OPENING = "Opened by agent-platform from session ";

// What pullRequestTail writes between the markers, in order; `optional` lines
// may be missing. Anything else there (a line a person added) is theirs.
const TAIL_SHAPE: readonly { line: RegExp; optional?: true }[] = [
  { line: /^Opened by agent-platform from session `[^`]+`, commit `[^`]+`\.$/ },
  { line: /^$/ },
  { line: /^- Session: \S+$/, optional: true },
  { line: /^- Agent: (`[^`]+`|none), release (`[^`]+`|none)$/ },
  { line: /^- Push request: `[^`]+`$/ },
  { line: /^- Trigger: [a-z_]+$/ },
  {
    line: /^- Started by: (unknown|none \(App only\)|GitHub account not linked \(App only\)|GitHub account linked \(@[A-Za-z0-9-]+\))$/,
  },
];
const TAIL_LINKED =
  /^- Started by: GitHub account linked \(@([A-Za-z0-9-]+)\)$/;
const TAIL_CO_AUTHOR =
  /^Co-authored-by: ([A-Za-z0-9-]+) <[1-9][0-9]*\+([A-Za-z0-9-]+)@users\.noreply\.github\.com>$/;

const QUOTING_ELEMENT =
  /<(\/?)(details|pre|div|table|blockquote|section|textarea|script|style)\b[^>]*>/gi;

/** Whether the lines between two markers are exactly a tail the platform wrote. */
function isTailContent(content: readonly string[]): boolean {
  const lines = content.map((line) => line.trimEnd());
  let at = 0;
  for (const { line, optional } of TAIL_SHAPE) {
    const next = lines[at];
    if (next !== undefined && line.test(next)) at += 1;
    else if (!optional) return false;
  }
  // The platform writes Co-authored-by exactly when the starter is linked, for
  // that login; any other one is a person's.
  const login = TAIL_LINKED.exec(lines[at - 1] ?? "")?.[1];
  if (login === undefined) return at === lines.length;
  const coAuthor = TAIL_CO_AUTHOR.exec(lines[at + 1] ?? "");
  return (
    at + 2 === lines.length &&
    lines[at] === "" &&
    coAuthor?.[1] === login &&
    coAuthor[2] === login
  );
}

/**
 * `body` with its tail replaced by `tail`. The tail is a start marker line
 * and the next end marker line, each alone and unindented on its line,
 * outside a fenced code block and an HTML element such as `<details>`, with
 * only the platform's own lines between them; the last such pair is the one
 * replaced. Markers a person quotes are text. A body without such a pair
 * (from before the end marker, or one a person cut or edited) keeps all it
 * has and gets the tail added, after closing any block it leaves open. Text
 * around the tail is kept as written.
 */
export function withPullRequestTail(body: string, tail: string): string {
  // GitHub's editor saves CRLF. The result is cut from `body` at these
  // offsets, so the person's text keeps its own line endings.
  const lines = body.split(/\r?\n/);
  const starts = [0];
  for (const newline of body.matchAll(/\r?\n/g)) {
    starts.push(newline.index + newline[0].length);
  }
  const endOf = (at: number) => (starts[at] ?? 0) + (lines[at] ?? "").length;
  const blank = (at: number) => lines[at]?.trim() === "";
  // `body` up to the end of the last line before `at` that has text.
  const headBefore = (at: number) => {
    let last = at - 1;
    while (last >= 0 && blank(last)) last -= 1;
    return last < 0 ? "" : body.slice(0, endOf(last));
  };
  // The opening fence's run (CommonMark): only the same character, at least
  // as long, with nothing after it closes the block.
  let fence: string | null = null;
  // HTML elements a person opened around Markdown (`<details>` around a
  // pasted example): markers inside them are quoted.
  const open: string[] = [];
  let start = -1;
  let pair: [number, number] | null = null;
  for (const [at, line] of lines.entries()) {
    const run = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marks = run?.[1] ?? "";
    const after = run?.[2] ?? "";
    if (fence !== null) {
      if (
        marks[0] === fence[0] &&
        marks.length >= fence.length &&
        after.trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    // A backtick fence's info string has no backtick; that line is inline code.
    if (run && !(marks[0] === "`" && after.includes("`"))) {
      fence = marks;
      continue;
    }
    const outside = open.length === 0;
    for (const [, close, name] of line
      .replace(/`[^`]*`/g, "")
      .matchAll(QUOTING_ELEMENT)) {
      const tag = (name ?? "").toLowerCase();
      if (close === "") open.push(tag);
      else if (open.lastIndexOf(tag) !== -1) {
        open.splice(open.lastIndexOf(tag), 1);
      }
    }
    if (!outside || open.length > 0) {
      start = -1;
      continue;
    }
    // The platform writes its markers flush left; an indented one is quoted
    // (an indented code block, a list item).
    const text = line.trimEnd();
    if (text === PULL_REQUEST_TAIL_MARKER) start = at;
    else if (text === PULL_REQUEST_TAIL_END_MARKER && start !== -1) {
      if (isTailContent(lines.slice(start + 1, at))) pair = [start, at];
      start = -1;
    }
  }
  if (pair === null) {
    // Closed first, or the tail lands inside the person's unclosed block and
    // is never found again: each refresh would add one more.
    const closing = [
      ...(fence === null ? [] : [fence]),
      ...open.reverse().map((tag) => `</${tag}>`),
    ];
    const head = [headBefore(lines.length), ...closing]
      .filter((part) => part !== "")
      .join("\n");
    return head === "" ? tail : `${head}\n\n${tail}`;
  }
  const [from, to] = pair;
  // The marker follows the tail's own `---` line; keep the text above it.
  let top = from;
  while (top > 0 && blank(top - 1)) top -= 1;
  if (top > 0 && lines[top - 1]?.trim() === "---") top -= 1;
  const head = headBefore(top);
  let next = to + 1;
  while (next < lines.length && blank(next)) next += 1;
  const rest = next < lines.length ? body.slice(starts[next]) : "";
  return [head, tail, rest].filter((part) => part !== "").join("\n\n");
}
