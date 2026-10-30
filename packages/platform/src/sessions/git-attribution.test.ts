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
  const tail = block("new");

  test("an empty body becomes the tail", () => {
    expect(withPullRequestTail("", tail)).toBe(tail);
  });

  test("only the tail between the markers is replaced", () => {
    expect(
      withPullRequestTail(
        `Intro\n\n---\nA rule of the author's\n\n${block("old")}\n\nAdded below`,
        tail,
      ),
    ).toBe(`Intro\n\n---\nA rule of the author's\n\n${tail}\n\nAdded below`);
  });

  test("a body that is only an old tail becomes the new one", () => {
    expect(withPullRequestTail(block("old"), tail)).toBe(tail);
  });

  test("a marker a person quotes is text: only the real tail changes", () => {
    const quoted = `Use \`${PULL_REQUEST_TAIL_MARKER}\` to find it.\n\nMore notes`;
    expect(withPullRequestTail(`${quoted}\n\n${block("old")}`, tail)).toBe(
      `${quoted}\n\n${tail}`,
    );
    expect(withPullRequestTail(`${block("old")}\n\n${quoted}`, tail)).toBe(
      `${tail}\n\n${quoted}`,
    );
  });

  test("both markers quoted in a line or a code block are text too", () => {
    const inline = `Example: \`${PULL_REQUEST_TAIL_MARKER}\` HUMAN NOTES \`${PULL_REQUEST_TAIL_END_MARKER}\``;
    expect(withPullRequestTail(`${block("old")}\n\n${inline}`, tail)).toBe(
      `${tail}\n\n${inline}`,
    );
    const fence = `\`\`\`\n${block("example")}\n\`\`\``;
    expect(withPullRequestTail(`${block("old")}\n\n${fence}`, tail)).toBe(
      `${tail}\n\n${fence}`,
    );
    expect(withPullRequestTail(fence, tail)).toBe(`${fence}\n\n${tail}`);
  });

  test("a start marker with no end after it cuts nothing", () => {
    const cut = `Intro\n\n---\n${PULL_REQUEST_TAIL_MARKER}\nold, end removed`;
    expect(withPullRequestTail(cut, tail)).toBe(`${cut}\n\n${tail}`);
  });
});
