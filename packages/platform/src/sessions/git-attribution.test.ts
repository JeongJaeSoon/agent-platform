import { describe, expect, test } from "bun:test";
import type { SessionAttributionRecord } from "../ports/session-attribution.ts";
import {
  attributionView,
  claimGitOf,
  coAuthorOf,
  PULL_REQUEST_TAIL_END_MARKER,
  PULL_REQUEST_TAIL_MARKER,
  sessionUrlOf,
  withPullRequestTail,
} from "./git-attribution.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";

function record(
  starter: SessionAttributionRecord["starter"],
  trigger: SessionAttributionRecord["trigger"] = "web",
): SessionAttributionRecord {
  return {
    ownerId: "owner-a",
    trigger,
    agentId: null,
    agentReleaseId: null,
    starter,
  };
}

const LINKED = record({
  userId: "user-1",
  github: { id: "583231", login: "octocat" },
});

describe("the co-author a commit names", () => {
  test("is the linked starter's login with GitHub's noreply address", () => {
    expect(coAuthorOf(LINKED)).toEqual({
      name: "octocat",
      email: "583231+octocat@users.noreply.github.com",
    });
  });

  test("is no one without a starter, a link, or with a value outside GitHub's rules", () => {
    for (const github of [
      null,
      { id: "0", login: "octocat" },
      { id: "12a", login: "octocat" },
      { id: "583231", login: "octo cat" },
      { id: "583231", login: "octocat>\nSigned-off-by: x" },
      { id: "583231", login: "a".repeat(40) },
    ]) {
      expect(coAuthorOf(record({ userId: "user-1", github }))).toBeNull();
    }
    expect(coAuthorOf(record(null))).toBeNull();
    expect(coAuthorOf(null)).toBeNull();
  });
});

test("the claim names the session's console page, or none without an origin", () => {
  expect(
    claimGitOf(record(null), "https://console.example.com", SESSION),
  ).toEqual({
    co_author: null,
    session_url: `https://console.example.com/sessions/${SESSION}`,
  });
  expect(sessionUrlOf(null, SESSION)).toBeNull();
});

test("the session detail says co_author, unlinked or app_only", () => {
  expect(attributionView(LINKED)).toEqual({
    trigger: "web",
    attribution: "co_author",
    login: "octocat",
  });
  expect(
    attributionView(record({ userId: "user-1", github: null }, "slack")),
  ).toEqual({ trigger: "slack", attribution: "unlinked", login: null });
  expect(attributionView(record(null, "agent_key"))).toEqual({
    trigger: "agent_key",
    attribution: "app_only",
    login: null,
  });
});

describe("replacing the pull request tail", () => {
  const block = (text: string) =>
    `---\n${PULL_REQUEST_TAIL_MARKER}\n${text}\n${PULL_REQUEST_TAIL_END_MARKER}`;
  const tailOf = (sessionId: string) =>
    block(
      `Opened by agent-platform from session \`${sessionId}\`, commit \`abc\`.\n\n- Trigger: web\n- Started by: none (App only)`,
    );
  const tail = tailOf("new");
  const OLD = tailOf("old");
  const EXAMPLE = tailOf("example");

  test("an empty body becomes the tail", () => {
    expect(withPullRequestTail("", tail)).toBe(tail);
  });

  test("only the tail between the markers is replaced", () => {
    expect(
      withPullRequestTail(
        `Intro\n\n---\nA rule of the author's\n\n${OLD}\n\nAdded below`,
        tail,
      ),
    ).toBe(`Intro\n\n---\nA rule of the author's\n\n${tail}\n\nAdded below`);
  });

  test("a body that is only an old tail becomes the new one", () => {
    expect(withPullRequestTail(OLD, tail)).toBe(tail);
  });

  test("a marker a person quotes is text: only the real tail changes", () => {
    const quoted = `Use \`${PULL_REQUEST_TAIL_MARKER}\` to find it.\n\nMore notes`;
    expect(withPullRequestTail(`${quoted}\n\n${OLD}`, tail)).toBe(
      `${quoted}\n\n${tail}`,
    );
    expect(withPullRequestTail(`${OLD}\n\n${quoted}`, tail)).toBe(
      `${tail}\n\n${quoted}`,
    );
  });

  test("both markers quoted in a line or a code block are text too", () => {
    const inline = `Example: \`${PULL_REQUEST_TAIL_MARKER}\` HUMAN NOTES \`${PULL_REQUEST_TAIL_END_MARKER}\``;
    expect(withPullRequestTail(`${OLD}\n\n${inline}`, tail)).toBe(
      `${tail}\n\n${inline}`,
    );
    const fence = `\`\`\`\n${EXAMPLE}\n\`\`\``;
    expect(withPullRequestTail(`${OLD}\n\n${fence}`, tail)).toBe(
      `${tail}\n\n${fence}`,
    );
    expect(withPullRequestTail(fence, tail)).toBe(`${fence}\n\n${tail}`);
  });

  test("a fence closes only on its own character, at least as long", () => {
    for (const quoted of [
      `\`\`\`\`\n\`\`\`\n${EXAMPLE}\n\`\`\`\n\`\`\`\``,
      `~~~\n\`\`\`\n${EXAMPLE}\n\`\`\`\n~~~`,
      `\`\`\`\n~~~\n${EXAMPLE}\n~~~\n\`\`\``,
    ]) {
      expect(withPullRequestTail(`${OLD}\n\n${quoted}`, tail)).toBe(
        `${tail}\n\n${quoted}`,
      );
    }
    const indented = EXAMPLE.split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    expect(withPullRequestTail(`${OLD}\n\nUsage:\n\n${indented}`, tail)).toBe(
      `${tail}\n\nUsage:\n\n${indented}`,
    );
    // A longer closing run still closes; the real tail after it is found.
    const closed = `\`\`\`\ncode\n\`\`\`\`\n\n${OLD}`;
    expect(withPullRequestTail(closed, tail)).toBe(
      `\`\`\`\ncode\n\`\`\`\`\n\n${tail}`,
    );
  });

  test("a start marker with no end after it cuts nothing", () => {
    const cut = `Intro\n\n---\n${PULL_REQUEST_TAIL_MARKER}\nold, end removed`;
    expect(withPullRequestTail(cut, tail)).toBe(`${cut}\n\n${tail}`);
  });

  test("markers around a person's own text are not a tail", () => {
    const details = `<details>\n<summary>PR body example</summary>\n\n${block("HUMAN NOTES")}\n</details>`;
    expect(withPullRequestTail(`${OLD}\n\n${details}`, tail)).toBe(
      `${tail}\n\n${details}`,
    );
    const edited = block(
      "Opened by agent-platform from session `old`, commit `abc`.\n\nReviewed by hand",
    );
    expect(withPullRequestTail(edited, tail)).toBe(`${edited}\n\n${tail}`);
  });

  test("the text after the tail is kept as written", () => {
    const code = "    const example = 1;\n      indented more";
    expect(withPullRequestTail(`${OLD}\n\n${code}`, tail)).toBe(
      `${tail}\n\n${code}`,
    );
  });

  test("a whole tail pasted inside an HTML element is quoted", () => {
    for (const quoted of [
      `<details>\n<summary>Earlier output</summary>\n\n${EXAMPLE}\n\n</details>`,
      `<pre>\n${EXAMPLE}\n</pre>`,
      `<div><details>\n\n${EXAMPLE}\n\n</details></div>`,
    ]) {
      expect(withPullRequestTail(`${OLD}\n\n${quoted}`, tail)).toBe(
        `${tail}\n\n${quoted}`,
      );
    }
    // Named in inline code, an element opens nothing.
    const named = "Wrap it in `<details>` to fold it.";
    expect(withPullRequestTail(`${named}\n\n${OLD}`, tail)).toBe(
      `${named}\n\n${tail}`,
    );
  });

  test("a block left open is closed before the tail, so refreshes do not pile up", () => {
    for (const [body, closing] of [
      ["Build log:\n\n```\nerror: failed", "```"],
      ["~~~~\nlog", "~~~~"],
      ["<details>\n<summary>Log</summary>\n\nlines", "</details>"],
    ]) {
      const once = withPullRequestTail(body ?? "", tail);
      expect(once).toBe(`${body}\n${closing}\n\n${tail}`);
      const again = withPullRequestTail(once, tailOf("newer"));
      expect(again).toBe(`${body}\n${closing}\n\n${tailOf("newer")}`);
    }
  });
});
