import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaimGit } from "@werft-ai/contracts";

// The image's commit-msg hook (apps/worker/git-hooks/werft-hook) reads this
// file under the engine's HOME and adds each line as a `--trailer` argv
// (design github-agent.md decision 5).
export const GIT_TRAILERS_PATH = ".werft/git-trailers";

const UNSAFE = /[\r\n\0]/;

/** The trailer lines a claim asks for; a value that could break a line is dropped. */
export function gitTrailerLines(git: ClaimGit | undefined): string[] {
  const lines: string[] = [];
  const coAuthor = git?.co_author;
  if (coAuthor && !UNSAFE.test(coAuthor.name) && !UNSAFE.test(coAuthor.email)) {
    lines.push(`Co-authored-by: ${coAuthor.name} <${coAuthor.email}>`);
  }
  const sessionUrl = git?.session_url;
  if (sessionUrl && !UNSAFE.test(sessionUrl)) {
    lines.push(`Agent-Session: ${sessionUrl}`);
  }
  return lines;
}

/**
 * Replaces the trailers file with this claim's lines, or removes it when
 * there are none: a claim from a control host without `git` adds nothing.
 */
export async function writeGitTrailers(
  home: string,
  git: ClaimGit | undefined,
): Promise<void> {
  const path = join(home, GIT_TRAILERS_PATH);
  const lines = gitTrailerLines(git);
  if (lines.length === 0) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(join(home, ".werft"), { recursive: true });
  const staged = `${path}.${process.pid}.tmp`;
  await writeFile(staged, `${lines.join("\n")}\n`, { mode: 0o644 });
  await rename(staged, path);
}
