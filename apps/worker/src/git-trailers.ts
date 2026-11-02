import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaimGit, ClaimGitAuthor } from "@werft-ai/contracts";

// The image's commit-msg hook (apps/worker/git-hooks/werft-hook) reads this
// file under the engine's HOME and adds each line as a `--trailer` argv
// (design github-agent.md decision 5).
export const GIT_TRAILERS_PATH = ".werft/git-trailers";
// The image's system git config includes this file after its own
// user.name/email (apps/worker/Dockerfile), so the session's author wins over
// the image default and a `git config` the session runs still wins over both.
export const GIT_IDENTITY_PATH = ".werft/git-identity";

const UNSAFE = /[\r\n\0]/;
const BOT_NAME = /^[a-z0-9][a-z0-9-]*\[bot\]$/;
const BOT_EMAIL =
  /^[1-9][0-9]*\+[a-z0-9][a-z0-9-]*\[bot\]@users\.noreply\.github\.com$/;

/** What a claim says about the session's commits. */
export type ClaimCommits = {
  session_id: string;
  git?: ClaimGit | undefined;
  git_author?: ClaimGitAuthor | null | undefined;
};

/**
 * The trailer lines a claim asks for; a value that could break a line is
 * dropped. Without a console URL, Agent-Session names the session's id: the
 * pull request's tail carries the same id.
 */
export function gitTrailerLines(claim: ClaimCommits): string[] {
  const { git } = claim;
  const lines: string[] = [];
  const coAuthor = git?.co_author;
  if (coAuthor && !UNSAFE.test(coAuthor.name) && !UNSAFE.test(coAuthor.email)) {
    lines.push(`Co-authored-by: ${coAuthor.name} <${coAuthor.email}>`);
  }
  if (git !== undefined) {
    const session = git.session_url ?? claim.session_id;
    if (!UNSAFE.test(session)) lines.push(`Agent-Session: ${session}`);
  }
  return lines;
}

/**
 * The git config the image includes for the commit author, or null when the
 * claim names none or one this file could not hold as a plain value.
 */
export function gitIdentityConfig(author: ClaimGitAuthor | null | undefined) {
  if (!author || !BOT_NAME.test(author.name) || !BOT_EMAIL.test(author.email)) {
    return null;
  }
  return `[user]\n\tname = "${author.name}"\n\temail = ${author.email}\n`;
}

/**
 * Replaces the trailers and identity files with this claim's, or removes
 * each one the claim has nothing for: a claim from a control host without
 * `git` adds nothing, and one without `git_author` keeps the image default.
 */
export async function writeGitTrailers(
  home: string,
  claim: ClaimCommits,
): Promise<void> {
  const lines = gitTrailerLines(claim);
  await replace(
    home,
    GIT_TRAILERS_PATH,
    lines.length === 0 ? null : `${lines.join("\n")}\n`,
  );
  await replace(home, GIT_IDENTITY_PATH, gitIdentityConfig(claim.git_author));
}

async function replace(
  home: string,
  file: string,
  content: string | null,
): Promise<void> {
  const path = join(home, file);
  if (content === null) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(join(home, ".werft"), { recursive: true });
  const staged = `${path}.${process.pid}.tmp`;
  await writeFile(staged, content, { mode: 0o644 });
  await rename(staged, path);
}
