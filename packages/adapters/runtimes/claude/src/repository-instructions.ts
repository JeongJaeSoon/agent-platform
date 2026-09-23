import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Past this the run is refused rather than handed part of the file: a cut can
 * drop the rule that mattered or end one mid-sentence, and a model cannot
 * tell a truncated policy from a complete one.
 */
export const REPOSITORY_CLAUDE_MD_MAX_BYTES = 64 * 1024;

/**
 * The checked-out repository's root `CLAUDE.md`, read by the adapter instead
 * of the engine so that letting it in does not also let in the repository's
 * settings.json (see `ClaudeRuntimeConfig.repositoryClaudeMd`).
 *
 * A symlink is followed only while it stays inside the checkout: a
 * `CLAUDE.md -> AGENTS.md` is ordinary, a link to a file elsewhere on the
 * worker would copy that file into a prompt sent to the provider. Left out,
 * against what the engine itself loads: `.claude/CLAUDE.md`, `CLAUDE.local.md`,
 * `.claude/rules/`, nested directories' files and `@` imports — each is
 * another path to confine the same way, worth adding when a repository the
 * platform serves depends on one.
 *
 * The containment check and the open are two steps, which holds only because
 * nothing else writes the checkout while a run starts: the agent is not
 * running yet and the workspace step has finished.
 */
export function readRepositoryClaudeMd(cwd: string): string | undefined {
  const root = realpathSync(cwd);
  let target: string;
  try {
    target = realpathSync(join(root, "CLAUDE.md"));
  } catch (error) {
    // Missing, or a link to nothing: the repository has no instructions.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const inside = relative(root, target);
  if (
    inside === "" ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  ) {
    throw new Error("Repository CLAUDE.md resolves outside the workspace");
  }
  // Non-blocking so a FIFO planted under the name cannot hang the start.
  const fd = openSync(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error("Repository CLAUDE.md is not a regular file");
    }
    const buffer = Buffer.alloc(REPOSITORY_CLAUDE_MD_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > REPOSITORY_CLAUDE_MD_MAX_BYTES) {
      throw new Error(
        `Repository CLAUDE.md is larger than ${REPOSITORY_CLAUDE_MD_MAX_BYTES} bytes`,
      );
    }
    return new TextDecoder().decode(buffer.subarray(0, length));
  } finally {
    closeSync(fd);
  }
}

/**
 * The text appended to the engine's preset system prompt: the caller's own
 * addition first, then the repository's instructions under a heading that
 * says where they came from.
 */
export function systemPromptAppend(config: {
  appendSystemPrompt?: string;
  cwd: string;
  repositoryClaudeMd?: boolean;
}): string | undefined {
  const instructions =
    config.repositoryClaudeMd === true
      ? readRepositoryClaudeMd(config.cwd)
      : undefined;
  const parts = [
    config.appendSystemPrompt,
    instructions === undefined || instructions.trim() === ""
      ? undefined
      : `Contents of CLAUDE.md at the root of the repository you are working in (project instructions checked into it):\n\n${instructions}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join("\n\n");
}
