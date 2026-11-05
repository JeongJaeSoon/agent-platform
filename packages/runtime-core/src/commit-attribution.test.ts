import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttributionExpectation,
  attributionMismatches,
  attributionProblems,
  COMMIT_FACTS_FORMAT,
  type CommitFacts,
  namesWorkingTreeSnapshot,
  parseCommitFacts,
  rangeAttribution,
  workingTreeSnapshotMismatch,
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

/** What git itself reads as the message's trailers. */
function gitTrailers(message: string): string {
  const out = spawnSync(
    "git",
    ["interpret-trailers", "--parse", "--no-divider"],
    {
      input: message,
      encoding: "utf8",
    },
  );
  if (out.status !== 0) throw new Error(out.stderr);
  return out.stdout;
}

/** Facts plus the message they were derived from, which tests build on. */
function commit(
  overrides: Partial<CommitFacts> & { message?: string } = {},
): CommitFacts & { message: string } {
  const message =
    overrides.message ??
    [
      "feat: x",
      "",
      `Co-authored-by: ${human.name} <${human.email}>`,
      `Agent-Session: ${expected.agentSession}`,
      "",
    ].join("\n");
  return {
    sha,
    authorName: bot.name,
    authorEmail: bot.email,
    committerName: bot.name,
    committerEmail: bot.email,
    ...overrides,
    message,
    trailers: overrides.trailers ?? gitTrailers(message),
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

  test("attribution lines in the body, outside git's trailer block, do not count", () => {
    const message = [
      "subject",
      "",
      `Co-authored-by: ${human.name} <${human.email}>`,
      `Agent-Session: ${expected.agentSession}`,
      "",
      "Ordinary body text after the alleged trailers.",
      "",
    ].join("\n");
    // The reviewed input: git reads no trailer in it at all.
    expect(gitTrailers(message)).toBe("");
    expect(attributionProblems(commit({ message }), expected, strip)).toEqual([
      "co_author",
      "agent_session",
    ]);
  });

  test("a body line does not stand in for, or double, a real trailer", () => {
    const body = [
      `Co-authored-by: ${human.name} <${human.email}>`,
      `Agent-Session: ${expected.agentSession}`,
      "",
    ];
    const message = ["subject", "", ...body, "text", "", ...body].join("\n");
    expect(gitTrailers(message)).toContain("Agent-Session:");
    expect(attributionProblems(commit({ message }), expected, strip)).toEqual(
      [],
    );
  });

  test("messages the platform's own tools write pass", () => {
    // Shapes the hook (interpret-trailers --if-exists addIfDifferent) makes:
    // after a body, after a Signed-off-by, and after another human's trailer.
    for (const head of [
      "subject\n\nbody paragraph\n",
      "subject\n\nbody\n\nSigned-off-by: A <a@x.test>\n",
      "subject\n\nbody\n\nReviewed-by: B <b@x.test>\n",
    ]) {
      const message = `${head}${head.includes("-by:") ? "" : "\n"}Co-authored-by: ${human.name} <${human.email}>\nAgent-Session: ${expected.agentSession}\n`;
      expect(attributionProblems(commit({ message }), expected, strip)).toEqual(
        [],
      );
    }
  });

  test("the trailers field is what git log prints for the same message", () => {
    const dir = mkdtempSync(join(tmpdir(), "trailers-"));
    try {
      const git = (...args: string[]) =>
        spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      git("init", "-q");
      const messages = [
        "subject\n\nCo-authored-by: A <a@x.test>\nAgent-Session: s\n\nbody\n",
        "subject\n\nbody\n\nCo-authored-by: A <a@x.test>\nAgent-Session: s\n",
        "subject\n\nAgent-Session: s\n",
        "subject\nAgent-Session: s\n",
        "subject\n\nbody\n\nAgent-Session: s\nnot a trailer\n",
        "subject\n\nbody\n\nSigned-off-by: A <a@x.test>\nAgent-Session: s\nplain\n",
        "subject\n\nAgent-Session: long\n  continued\nCo-authored-by: A <a@x.test>\n",
        "subject\n\nexplanation\n\n---\nmore text\n",
        "subject\n\nbody\n\nCo-authored-by: A <a@x.test>\nAgent-Session: s\n\n---\nafter the line\n",
      ];
      for (const message of messages) {
        git(
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@x.test",
          "commit",
          "-q",
          "--allow-empty",
          "--cleanup=verbatim",
          "-m",
          message,
        );
        const out = git("log", "-1", `--format=${COMMIT_FACTS_FORMAT}`).stdout;
        const parsed = parseCommitFacts(out);
        expect(parsed?.[0]?.trailers).toBe(gitTrailers(message));
      }
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("an engine line with an indented explanation under it is refused though it sits in the body", () => {
    const message = [
      "Subject",
      "",
      "Co-authored-by: Claude <noreply@anthropic.com>",
      "  explanation",
      "",
      "More body.",
      "",
      `Co-authored-by: ${human.name} <${human.email}>`,
      `Agent-Session: ${expected.agentSession}`,
      "",
    ].join("\n");
    // git reads only the last two lines as trailers.
    expect(gitTrailers(message)).not.toContain("anthropic");
    expect(attributionProblems(commit({ message }), expected, strip)).toEqual([
      "engine_co_author",
    ]);
  });

  test("an engine co-author folded over two lines is still found", () => {
    const message = `${commit().message}Co-authored-by: Claude\n <noreply@anthropic.com>\n`;
    expect(gitTrailers(message)).toContain(
      "Co-authored-by: Claude <noreply@anthropic.com>",
    );
    expect(attributionProblems(commit({ message }), expected, strip)).toEqual([
      "engine_co_author",
    ]);
  });

  test("an engine co-author stays refused when a repository trailer setting renames what git parses", () => {
    const message = `${commit().message}Co-authored-by: Claude <noreply@anthropic.com>\n`;
    // What git prints under trailer.Co-authored-by.key = Other.
    const trailers = `${commit().trailers}Other: Claude <noreply@anthropic.com>\n`;
    expect(
      attributionProblems(commit({ message, trailers }), expected, strip),
    ).toEqual(["engine_co_author"]);
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
    const record = `${sha}\x1fa\x1fa@x\x1fc\x1fc@x\x1fsubject\n\nbody\n\x1fK: v\n\x1e\n`;
    expect(parseCommitFacts(record)).toEqual([
      {
        sha,
        authorName: "a",
        authorEmail: "a@x",
        committerName: "c",
        committerEmail: "c@x",
        message: "subject\n\nbody\n",
        trailers: "K: v\n",
      },
    ]);
  });

  test("a malformed record fails the whole parse", () => {
    expect(parseCommitFacts("nope\x1e")).toBeNull();
  });
});

describe("rangeAttribution", () => {
  const record = (c: CommitFacts) =>
    `${[c.sha, c.authorName, c.authorEmail, c.committerName, c.committerEmail, c.message, c.trailers].join("\x1f")}\x1e`;
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

  test("a log the runner cut short is unreadable: the missing commits might be wrong", async () => {
    const result = await rangeAttribution(
      async () => ({
        exitCode: 0,
        stdout: `${record(commit())}\n`,
        truncated: true,
      }),
      {
        tip: "b".repeat(40),
        not: [],
        expectations: [expected],
        stripEmails: strip,
      },
    );
    expect(result).toEqual({ status: "unreadable" });
  });

  test("a git that fails is unreadable, never clean", async () => {
    expect(await run([commit()], 128)).toEqual({ status: "unreadable" });
  });
});

describe("working-tree snapshot marker", () => {
  const sha = "a".repeat(40);

  test("names the pinned commit only when its entry carries no problems", () => {
    expect(
      namesWorkingTreeSnapshot([workingTreeSnapshotMismatch(sha)], sha),
    ).toBe(true);
    expect(
      namesWorkingTreeSnapshot([{ commit: sha, problems: ["author"] }], sha),
    ).toBe(false);
    expect(
      namesWorkingTreeSnapshot(
        [workingTreeSnapshotMismatch("b".repeat(40))],
        sha,
      ),
    ).toBe(false);
  });

  test("judging never yields an empty problem list, so the marker is not a real finding", () => {
    const facts: CommitFacts = {
      sha,
      authorName: "x",
      authorEmail: "x@x",
      committerName: "x",
      committerEmail: "x@x",
      message: "m\n",
      trailers: "",
    };
    for (const found of attributionMismatches([facts], [expected], strip)) {
      expect(found.problems.length).toBeGreaterThan(0);
    }
  });
});
