import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type IsolatedWorkspace = {
  /** Same directory as `home`; Claude Code reads settings and transcripts from it. */
  claudeConfigDir: string;
  dispose(): Promise<void>;
  home: string;
  root: string;
  workspace: string;
};

export type IsolatedWorkspaceOptions = {
  /** Directory the temp root is created in. Defaults to the OS tmpdir. */
  parent?: string;
  prefix?: string;
};

/**
 * Creates `<root>/workspace/.claude` and `<root>/home` under a fresh temp
 * root. Claude Code loads every `CLAUDE.md` from the cwd up to `/`, so the
 * fixture refuses to hand out a workspace whose ancestors carry instructions
 * (94S-91 isolation contract: the parent tree must be tenant-private).
 */
export async function createIsolatedWorkspace(
  options: IsolatedWorkspaceOptions = {},
): Promise<IsolatedWorkspace> {
  const root = await realpath(
    await mkdtemp(
      join(options.parent ?? tmpdir(), options.prefix ?? "testkit-ws-"),
    ),
  );
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  try {
    await mkdir(join(workspace, ".claude"), { recursive: true });
    await mkdir(home, { recursive: true });
    await assertNoAncestorInstructions(workspace);
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
  return {
    claudeConfigDir: home,
    dispose: () => rm(root, { force: true, recursive: true }),
    home,
    root,
    workspace,
  };
}

/** Throws when any ancestor of `path` holds a `CLAUDE.md` or `.claude/CLAUDE.md`. */
export async function assertNoAncestorInstructions(
  path: string,
): Promise<void> {
  const leaks = await findAncestorInstructions(path);
  if (leaks.length > 0) {
    throw new Error(
      `Workspace ${path} would inherit instructions from ${leaks.join(", ")}; move the temp root to a tenant-private tree`,
    );
  }
}

export async function findAncestorInstructions(
  path: string,
): Promise<string[]> {
  const found: string[] = [];
  let current = dirname(path);
  while (true) {
    for (const candidate of [
      join(current, "CLAUDE.md"),
      join(current, ".claude", "CLAUDE.md"),
    ]) {
      if (await exists(candidate)) found.push(candidate);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return found;
}

/**
 * Process environment for a Claude Code subprocess that must not see the
 * host user's config, credentials or memory.
 */
export function isolatedSdkEnv(
  workspace: Pick<IsolatedWorkspace, "home">,
  options: { apiKey?: string; baseUrl: string },
): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: options.apiKey ?? "placeholder-local",
    ANTHROPIC_BASE_URL: options.baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CONFIG_DIR: workspace.home,
    HOME: workspace.home,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
