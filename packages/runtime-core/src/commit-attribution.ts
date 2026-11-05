/**
 * Whether a session's commits carry the attribution the platform expects.
 * One judgment shared by the worker (the checkpoint manifest, the repair
 * tool's own check) and the control-host's push, so they cannot disagree.
 * Pure: callers run git and hand in the commits' facts.
 */

export type CommitIdentity = { name: string; email: string };

/**
 * One bundle of values a claim issued: a commit passes when it matches any
 * bundle issued to its session, since the GitHub link or the authoring App can
 * change between claims.
 */
export type AttributionExpectation = {
  author: CommitIdentity;
  coAuthor: CommitIdentity | null;
  /** The value after `Agent-Session: `, or null when the claim asked for none. */
  agentSession: string | null;
};

export type CommitFacts = {
  sha: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  /**
   * The trailer block git itself recognizes in the message, one unfolded
   * `Key: value` line each (`git interpret-trailers --parse --no-divider`).
   * Only these lines are attribution: GitHub and git read a `Co-authored-by`
   * or `Agent-Session` line from anywhere else in the body as plain text. The
   * message is read only to refuse an engine line, which no trailer setting of
   * the repository judged in may hide.
   */
  trailers: string;
  message: string;
};

export const ATTRIBUTION_PROBLEMS = [
  "author",
  "committer",
  "co_author",
  "engine_co_author",
  "agent_session",
] as const;
export type AttributionProblem = (typeof ATTRIBUTION_PROBLEMS)[number];

export type AttributionMismatch = {
  commit: string;
  problems: AttributionProblem[];
};

/**
 * The entry a worker writes for a checkpoint whose workspace commit is its
 * own working-tree snapshot (the agent left tracked files uncommitted). It has
 * no `problems` because nothing was judged: the snapshot carries the platform's
 * checkpoint identity by design. The shape is one the manifest and refusal
 * schemas already accept, so a control host that predates it reads the entry
 * as an ordinary mismatch. Judging never produces an empty list, so the shape
 * cannot be confused with a real finding.
 */
export function workingTreeSnapshotMismatch(
  commit: string,
): AttributionMismatch {
  return { commit, problems: [] };
}

/** Whether `mismatches` says `commit` is a working-tree snapshot. */
export function namesWorkingTreeSnapshot(
  mismatches: readonly AttributionMismatch[],
  commit: string,
): boolean {
  return mismatches.some(
    (mismatch) => mismatch.commit === commit && mismatch.problems.length === 0,
  );
}

/** At most this many commits are listed in a refusal's details. */
export const MAX_REPORTED_MISMATCHES = 20;

/**
 * `git log --no-walk=unsorted --stdin --format=<this>`: one record per commit,
 * fields split by US, records ended by RS. Neither byte occurs in names,
 * emails or messages git accepts in practice; a message holding one fails the
 * parse, which callers treat as a mismatch. The trailer block comes from git's
 * own parser (`%(trailers)`), so this judgment cannot drift from git's.
 */
export const COMMIT_FACTS_FORMAT =
  "%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1f%(trailers:only,unfold)%x1e";

export function parseCommitFacts(stdout: string): CommitFacts[] | null {
  const facts: CommitFacts[] = [];
  for (const record of stdout.split("\x1e")) {
    if (record.trim() === "") continue;
    const fields = record.replace(/^\n/, "").split("\x1f");
    if (fields.length !== 7) return null;
    const [sha, authorName, authorEmail, committerName, committerEmail] =
      fields as [string, string, string, string, string, string];
    if (!/^[0-9a-f]{40}$/.test(sha)) return null;
    facts.push({
      sha,
      authorName,
      authorEmail,
      committerName,
      committerEmail,
      message: fields[5] as string,
      trailers: fields[6] as string,
    });
  }
  return facts;
}

const COAUTHOR_LINE = /^co-authored-by:[ \t]*(.*?)[ \t]*$/i;

function emailOf(line: string): string | null {
  const match = /<([^<>]*)>$/.exec(line);
  return match === null ? null : (match[1] as string).toLowerCase();
}

/** What is wrong with `commit` against one bundle; empty when it passes. */
export function attributionProblems(
  commit: CommitFacts,
  expectation: AttributionExpectation,
  stripEmails: readonly string[],
): AttributionProblem[] {
  const problems: AttributionProblem[] = [];
  const { author } = expectation;
  if (commit.authorName !== author.name || commit.authorEmail !== author.email)
    problems.push("author");
  if (
    commit.committerName !== author.name ||
    commit.committerEmail !== author.email
  )
    problems.push("committer");

  const strip = new Set(stripEmails.map((email) => email.toLowerCase()));
  const coAuthors = (text: string) =>
    text
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .flatMap((line) => {
        const match = COAUTHOR_LINE.exec(line);
        return match === null ? [] : [match[1] as string];
      });
  // A required line counts only in git's unfolded trailer block (a line
  // outside it is plain text to GitHub). An engine line is refused anywhere:
  // in the block, and in the message with folded lines joined, so a repository
  // trailer.* setting that renames what git parses cannot hide it.
  const unfolded = commit.message.replace(/\r?\n[ \t]+/g, " ");
  if (
    [...coAuthors(commit.trailers), ...coAuthors(unfolded)].some((value) => {
      const email = emailOf(value);
      return email !== null && strip.has(email);
    })
  ) {
    problems.push("engine_co_author");
  }
  const trailerLines = commit.trailers
    .split("\n")
    .map((line) => line.replace(/\r$/, ""));
  if (expectation.coAuthor !== null) {
    const wanted = `${expectation.coAuthor.name} <${expectation.coAuthor.email}>`;
    if (coAuthors(commit.trailers).filter((v) => v === wanted).length !== 1)
      problems.push("co_author");
  }
  if (expectation.agentSession !== null) {
    const wanted = `Agent-Session: ${expectation.agentSession}`;
    if (trailerLines.filter((line) => line === wanted).length !== 1)
      problems.push("agent_session");
  }
  return problems;
}

/**
 * The commits that match no bundle, each with the problems against the
 * closest bundle. No bundles means nothing was issued to check against (a
 * control host without attribution), and nothing is reported.
 */
export function attributionMismatches(
  commits: readonly CommitFacts[],
  expectations: readonly AttributionExpectation[],
  stripEmails: readonly string[],
): AttributionMismatch[] {
  if (expectations.length === 0) return [];
  const out: AttributionMismatch[] = [];
  for (const commit of commits) {
    let best: AttributionProblem[] | null = null;
    for (const expectation of expectations) {
      const problems = attributionProblems(commit, expectation, stripEmails);
      if (problems.length === 0) {
        best = [];
        break;
      }
      if (best === null || problems.length < best.length) best = problems;
    }
    if (best !== null && best.length > 0)
      out.push({ commit: commit.sha, problems: best });
  }
  return out;
}

/** One git invocation inside the repository being judged. */
export type RangeGit = (
  args: readonly string[],
  /** `truncated`: stdout was cut at a cap, so later commits may be missing. */
) => Promise<{ exitCode: number; stdout: string; truncated?: boolean }>;

export type RangeAttribution =
  | { status: "ok"; mismatches: AttributionMismatch[]; checked: number }
  /** git or the log could not be read: the caller must not call it clean. */
  | { status: "unreadable" };

/**
 * Judges the commits that `tip` reaches and none of `not` does (object ids,
 * refs or `--remotes`): the ones this session made. Oldest first, at most
 * MAX_REPORTED_MISMATCHES listed; `checked` counts every commit looked at.
 * The worker (the checkpoint manifest) and the control host's push both call
 * this, each with its own git.
 */
export async function rangeAttribution(
  git: RangeGit,
  input: {
    tip: string;
    not: readonly string[];
    expectations: readonly AttributionExpectation[];
    stripEmails: readonly string[];
  },
): Promise<RangeAttribution> {
  const log = await git([
    "log",
    "--reverse",
    `--format=${COMMIT_FACTS_FORMAT}`,
    input.tip,
    ...(input.not.length === 0 ? [] : ["--not", ...input.not]),
  ]);
  if (log.exitCode !== 0 || log.truncated === true) {
    return { status: "unreadable" };
  }
  const facts = parseCommitFacts(log.stdout);
  if (facts === null) return { status: "unreadable" };
  const all = attributionMismatches(
    facts,
    input.expectations,
    input.stripEmails,
  );
  return {
    status: "ok",
    mismatches: all.slice(0, MAX_REPORTED_MISMATCHES),
    checked: facts.length,
  };
}
