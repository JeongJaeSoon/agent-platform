import { describe, expect, test } from "bun:test";
import {
  type AttributionExpectation,
  attributionMismatches,
  attributionProblems,
  type CommitFacts,
  parseCommitFacts,
  rangeAttribution,
} from "./commit-attribution.ts";

const bot = {
  name: "werft[bot]",
  email: "1+werft[bot]@users.noreply.github.com",
};
const human = { name: "octo", email: "2+octo@users.noreply.github.com" };
const expected: AttributionExpectation = {
  author: bot,
  coAuthor: human,
  agentSession: "https://console.test/sessions/s1",
};
const strip = ["noreply@anthropic.com"];
const sha = "a".repeat(40);

function commit(overrides: Partial<CommitFacts> = {}): CommitFacts {
  return {
    sha,
    authorName: bot.name,
    authorEmail: bot.email,
    committerName: bot.name,
    committerEmail: bot.email,
    message: [
      "feat: x",
      "",
      `Co-authored-by: ${human.name} <${human.email}>`,
      `Agent-Session: ${expected.agentSession}`,
      "",
    ].join("\n"),
    ...overrides,
  };
}

describe("attributionProblems", () => {
  test("a correct commit has none", () => {
    expect(attributionProblems(commit(), expected, strip)).toEqual([]);
  });

  test("a wrong author is reported", () => {
    expect(
      attributionProblems(commit({ authorName: "x" }), expected, strip),
    ).toEqual(["author"]);
  });

  test("a wrong committer is reported", () => {
    expect(
      attributionProblems(commit({ committerEmail: "x@y" }), expected, strip),
    ).toEqual(["committer"]);
  });

  test("a missing or duplicated co-author is reported", () => {
    const line = `Co-authored-by: ${human.name} <${human.email}>`;
    expect(
      attributionProblems(
        commit({ message: "m\n\nAgent-Session: " + expected.agentSession }),
        expected,
        strip,
      ),
    ).toEqual(["co_author"]);
    expect(
      attributionProblems(
        commit({ message: `${commit().message}${line}\n` }),
        expected,
        strip,
      ),
    ).toEqual(["co_author"]);
  });

  test("an engine co-author is reported in any key case, a human's is not", () => {
    const withEngine = `${commit().message}co-AUTHORED-by: Claude <Noreply@Anthropic.com>\n`;
    expect(
      attributionProblems(commit({ message: withEngine }), expected, strip),
    ).toEqual(["engine_co_author"]);
    const other = `${commit().message}Co-authored-by: Pat <3+pat@users.noreply.github.com>\n`;
    expect(
      attributionProblems(commit({ message: other }), expected, strip),
    ).toEqual([]);
  });

  test("a wrong Agent-Session is reported", () => {
    expect(
      attributionProblems(
        commit({ message: commit().message.replace("s1", "s2") }),
        expected,
        strip,
      ),
    ).toEqual(["agent_session"]);
  });

  test("a claim without a co-author or a session asks for neither", () => {
    expect(
      attributionProblems(
        commit({ message: "plain" }),
        { author: bot, coAuthor: null, agentSession: null },
        strip,
      ),
    ).toEqual([]);
  });
});

describe("attributionMismatches", () => {
  test("a commit made under an earlier bundle passes", () => {
    const earlier: AttributionExpectation = { ...expected, coAuthor: null };
    const older = commit({
      message: "m\n\nAgent-Session: " + expected.agentSession,
    });
    expect(attributionMismatches([older], [expected, earlier], strip)).toEqual(
      [],
    );
  });

  test("lists each failing commit with its problems", () => {
    const bad = commit({ sha: "b".repeat(40), authorName: "x" });
    expect(attributionMismatches([commit(), bad], [expected], strip)).toEqual([
      { commit: bad.sha, problems: ["author"] },
    ]);
  });

  test("no bundle issued means nothing to check", () => {
    expect(
      attributionMismatches([commit({ authorName: "x" })], [], strip),
    ).toEqual([]);
  });
});

describe("parseCommitFacts", () => {
  test("reads git log records", () => {
    const record = `${sha}\x1fa\x1fa@x\x1fc\x1fc@x\x1fsubject\n\nbody\n\x1e\n`;
    expect(parseCommitFacts(record)).toEqual([
      {
        sha,
        authorName: "a",
        authorEmail: "a@x",
        committerName: "c",
        committerEmail: "c@x",
        message: "subject\n\nbody\n",
      },
    ]);
  });

  test("a malformed record fails the whole parse", () => {
    expect(parseCommitFacts("nope\x1e")).toBeNull();
  });
});

describe("rangeAttribution", () => {
  const record = (c: CommitFacts) =>
    `${[c.sha, c.authorName, c.authorEmail, c.committerName, c.committerEmail, c.message].join("\x1f")}\x1e`;
  const run = (commits: CommitFacts[], exitCode = 0) =>
    rangeAttribution(
      async () => ({ exitCode, stdout: commits.map(record).join("\n") }),
      {
        tip: "b".repeat(40),
        not: ["c".repeat(40)],
        expectations: [expected],
        stripEmails: strip,
      },
    );

  test("a wrong ancestor is found though the tip is right", async () => {
    const ancestor = "1".repeat(40);
    const result = await run([
      commit({ sha: ancestor, authorName: "someone" }),
      commit({ sha: "2".repeat(40) }),
    ]);
    expect(result).toEqual({
      status: "ok",
      checked: 2,
      mismatches: [{ commit: ancestor, problems: ["author"] }],
    });
  });

  test("a git that fails is unreadable, never clean", async () => {
    expect(await run([commit()], 128)).toEqual({ status: "unreadable" });
  });
});
