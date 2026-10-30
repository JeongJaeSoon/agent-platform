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
    `Opened by agent-platform from session \`${input.sessionId}\`, commit \`${input.commit}\`.`,
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

/**
 * `body` with its tail replaced by `tail`. The tail is a start marker line
 * and the next end marker line, each alone and unindented on its line and
 * outside a fenced code block, and the last such pair is the one replaced: a
 * marker a person quotes in a sentence or a code block is text. A body without such a pair
 * (from before the end marker, or one a person cut it from) keeps all it has
 * and gets the tail added.
 */
export function withPullRequestTail(body: string, tail: string): string {
  // GitHub's editor saves CRLF.
  const lines = body.split(/\r?\n/);
  // The opening fence's run (CommonMark): only the same character, at least
  // as long, with nothing after it closes the block.
  let fence: string | null = null;
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
    // The platform writes its markers flush left; an indented one is quoted
    // (an indented code block, a list item).
    const text = line.trimEnd();
    if (text === PULL_REQUEST_TAIL_MARKER) start = at;
    else if (text === PULL_REQUEST_TAIL_END_MARKER && start !== -1) {
      pair = [start, at];
      start = -1;
    }
  }
  if (pair === null) return body === "" ? tail : `${body}\n\n${tail}`;
  const [from, to] = pair;
  // The marker follows the tail's own `---` line; keep the text above it.
  const above = lines.slice(0, from);
  while (above.length > 0 && above[above.length - 1]?.trim() === "") {
    above.pop();
  }
  if (above[above.length - 1]?.trim() === "---") above.pop();
  const head = above.join("\n").trimEnd();
  const rest = lines
    .slice(to + 1)
    .join("\n")
    .trim();
  return [head, tail, rest].filter((part) => part !== "").join("\n\n");
}
