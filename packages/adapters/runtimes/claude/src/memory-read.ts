import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import type { ClaudeRuntimeConfig } from "./config.ts";

/**
 * Said in the system prompt of a run that asks a person: the engine's memory
 * prompt names the directory but not the tool, and a shell read of it waits
 * for approval like any other command.
 */
export const MEMORY_READ_GUIDANCE =
  "Read your memory directory with the Read, Glob or Grep tools, not Bash: those reads run without approval, while a shell command waits for a person.";

/**
 * Whether a call only reads the engine's own memory directory, the one its
 * memory prompt points the model at. The engine lets such reads through
 * itself, but compares the path it computed with the resolved target, and
 * the worker links `<config dir>/projects` onto the workspace volume, so
 * the two never match there. Only Read, Glob and Grep qualify; the target
 * has to resolve inside the directory, and Glob and Grep, which walk it,
 * need a directory without links. Anything unsure is false, which asks.
 */
export async function readsOnlyMemory(
  config: Pick<ClaudeRuntimeConfig, "claudeConfigDir" | "cwd">,
  tool: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  const target = targetOf(tool, input);
  // A relative one resolves against the engine's cwd, which a shell `cd` moves.
  if (target === undefined || !isAbsolute(target)) return false;
  try {
    const canonical = (await realpath(resolve(config.cwd))).normalize("NFC");
    const project = join(
      config.claudeConfigDir,
      "projects",
      canonical.replaceAll(/[^a-zA-Z0-9]/g, "-"),
    );
    // `projects` is the worker's own link; a link below it would carry the
    // allowed range wherever it points.
    for (const directory of [project, join(project, "memory")]) {
      if (!(await lstat(directory)).isDirectory()) return false;
    }
    const memory = await realpath(join(project, "memory"));
    const resolved = await resolveExisting(resolve(target));
    if (resolved !== memory && !resolved.startsWith(memory + sep)) {
      return false;
    }
    return tool === "Read" || !(await holdsLink(memory));
  } catch {
    return false;
  }
}

function targetOf(
  tool: string,
  input: Record<string, unknown>,
): string | undefined {
  const climbs = (pattern: unknown) =>
    typeof pattern === "string" &&
    (pattern.startsWith("/") || pattern.split(/[\\/]/).includes(".."));
  switch (tool) {
    case "Read":
      return typeof input.file_path === "string" ? input.file_path : undefined;
    case "Glob":
      if (typeof input.pattern !== "string" || climbs(input.pattern)) {
        return undefined;
      }
      return typeof input.path === "string" ? input.path : undefined;
    case "Grep":
      if (climbs(input.glob)) return undefined;
      return typeof input.path === "string" ? input.path : undefined;
    default:
      return undefined;
  }
}

/** The real path, or for a file not written yet, its real directory's. */
async function resolveExisting(path: string): Promise<string> {
  const found = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (found !== null) return realpath(path);
  return join(await realpath(dirname(path)), basename(path));
}

async function holdsLink(directory: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && (await holdsLink(join(directory, entry.name)))) {
      return true;
    }
  }
  return false;
}
