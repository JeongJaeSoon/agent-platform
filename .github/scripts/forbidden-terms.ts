/**
 * Scan the tree, the commit messages of this run and the PR title and body for a private
 * list of forbidden terms.
 *
 * FORBIDDEN_TERMS=<one ERE per line> [PR_NUMBER=n BASE_SHA=s BASE_REF=b HEAD_SHA=s] bun .github/scripts/forbidden-terms.ts
 *
 * The list stays out of the repository and this repository's Actions logs are public, so the
 * output is fixed text and counts only: no term, no path, line or sha (any of them would point
 * at the public sentence that holds a term). Find the place with a local grep. Child stderr is
 * dropped because a bad pattern's error quotes the pattern. The title and body come from the
 * API because a re-run reuses the old event payload.
 *
 * A missing list fails the job. A scan that cannot run is not a scan that found nothing.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class Failed extends Error {}

const HIT = 0;
const MISS = 1;

const env = process.env;

function child(
  cmd: [string, ...string[]],
  input?: string,
): { status: number | null; stdout: string } {
  // The list never reaches a child: patterns go through a file, and the variable is dropped.
  const { FORBIDDEN_TERMS: _dropped, ...rest } = env;
  const [file, ...args] = cmd;
  const p = spawnSync(file, args, {
    input,
    env: rest,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  });
  return { status: p.status, stdout: p.stdout ?? "" };
}

function countText(text: string, terms: string): number {
  const p = child(["grep", "-c", "-i", "-E", "-f", terms], text);
  if (p.status !== HIT && p.status !== MISS) {
    throw new Failed(
      "a pattern in FORBIDDEN_TERMS is invalid; check the list locally",
    );
  }
  return Number.parseInt(p.stdout.trim() || "0", 10);
}

function countTree(terms: string): number {
  const p = child(["git", "grep", "-l", "-I", "-i", "-E", "-f", terms]);
  if (p.status !== HIT && p.status !== MISS) {
    throw new Failed(
      "git grep failed; check the patterns in FORBIDDEN_TERMS locally",
    );
  }
  return p.stdout.split("\n").filter(Boolean).length;
}

const ZERO_SHA = /^0+$/;

// Only the commits this run adds: a PR's own commits, or the commits of a push. Older history
// is not rewritten, so it is not scanned. A push that has no usable "before" scans its head only.
function commitMessages(): string {
  const base = env.BASE_SHA ?? "";
  const head = env.HEAD_SHA || "HEAD";
  const args: [string, ...string[]] = ["git", "log", "--format=%B"];
  if (!base || ZERO_SHA.test(base)) {
    args.push("-1", head);
  } else {
    args.push(head, "--not", base);
    // A PR branch that merged newer main commits must not be charged for them.
    if (
      env.BASE_REF &&
      child([
        "git",
        "rev-parse",
        "--verify",
        "--quiet",
        `origin/${env.BASE_REF}`,
      ]).status === 0
    ) {
      args.push(`origin/${env.BASE_REF}`);
    }
  }
  const p = child(args);
  if (p.status !== 0) throw new Failed("could not read the commit range");
  return p.stdout;
}

function prText(number: string): string {
  const p = child([
    "gh",
    "api",
    `repos/${env.GITHUB_REPOSITORY ?? ""}/pulls/${number}`,
    "--jq",
    '.title + "\\n" + (.body // "")',
  ]);
  if (p.status !== 0) throw new Failed("could not read the PR title and body");
  return p.stdout;
}

function main(): number {
  const patterns = (env.FORBIDDEN_TERMS ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (patterns.length === 0) {
    const fork = env.FORK_PR === "true";
    throw new Failed(
      fork
        ? "FORBIDDEN_TERMS is not available to a pull request from a fork; a maintainer pushes the branch to this repository to scan it"
        : "FORBIDDEN_TERMS is empty or not set; the forbidden-term scan cannot run",
    );
  }
  const dir = mkdtempSync(
    join(env.RUNNER_TEMP || tmpdir(), "forbidden-terms-"),
  ); // mode 700
  try {
    const terms = join(dir, "terms.tmp");
    writeFileSync(terms, `${patterns.join("\n")}\n`, { mode: 0o600 });
    const hits: Record<string, number> = {
      tree: countTree(terms),
      "commit messages": countText(commitMessages(), terms),
    };
    if (env.PR_NUMBER)
      hits["PR title and body"] = countText(prText(env.PR_NUMBER), terms);
    for (const [where, n] of Object.entries(hits))
      console.log(`${where}: ${n}`);
    if (Object.values(hits).some((n) => n > 0)) {
      console.log(
        "::error::forbidden terms found; find them with a local grep of the private list",
      );
      return 1;
    }
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  process.exit(main());
} catch (e) {
  // Only fixed text: an unexpected error's message or stack could quote input.
  console.log(
    `::error::${e instanceof Failed ? e.message : "the forbidden-term scan failed unexpectedly"}`,
  );
  process.exit(1);
}
