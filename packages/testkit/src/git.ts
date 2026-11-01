/**
 * git for tests that build a workspace by hand, with nothing of the host's
 * configuration: no system config, `HOME` at a directory the test owns, and a
 * fixed author.
 *
 * Automatic maintenance is off as the worker's `runGit` has it. Otherwise
 * `commit` detaches `git maintenance run --auto`, whose repack (cruft packs
 * from git 2.54) races whatever the test does to the objects next.
 *
 * `home` is read on every call, so a binding made at module level can follow
 * a scratch directory that `beforeEach` replaces.
 */
export function isolatedGit(
  home: () => string,
): (cwd: string, ...args: string[]) => Promise<string> {
  return async (cwd, ...args) => {
    const child = Bun.spawn(["git", ...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home(),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "maintenance.auto",
        GIT_CONFIG_VALUE_0: "false",
        GIT_CONFIG_KEY_1: "gc.auto",
        GIT_CONFIG_VALUE_1: "0",
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
    return stdout;
  };
}
