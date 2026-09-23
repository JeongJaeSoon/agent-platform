import { describe, expect, test } from "bun:test";

// Each case spawns a bun process per role; a loaded runner needs more than
// the default 5s for three of them.
const TIMEOUT_MS = 30_000;

async function run(...args: string[]) {
  const child = Bun.spawn(
    [process.execPath, "run", `${import.meta.dir}/main.ts`, ...args],
    // An empty environment: a role that got as far as reading its settings
    // would fail on them, not on the role.
    { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr };
}

describe("control host executable", () => {
  test(
    "refuses to guess a role",
    async () => {
      for (const args of [[], ["worker"], ["API"]]) {
        const { exitCode, stderr } = await run(...args);
        expect(exitCode, args.join(" ")).toBe(2);
        expect(stderr).toContain(
          "usage: bun run src/main.ts <api|scheduler|reconciler>",
        );
      }
    },
    TIMEOUT_MS,
  );

  test(
    "each role validates its own settings and nothing else",
    async () => {
      // Without DATABASE_URL every role refuses, each in its own words: the
      // API before any listener, the jobs before any pass.
      const api = await run("api");
      expect(api.exitCode).not.toBe(0);
      expect(api.stderr).toContain("DATABASE_URL is required");
      const reconciler = await run("reconciler");
      expect(reconciler.exitCode).not.toBe(0);
      expect(reconciler.stderr).toContain(
        "DATABASE_URL or QUEUE_DATABASE_URL is required",
      );
      const scheduler = await run("scheduler");
      expect(scheduler.exitCode).not.toBe(0);
      expect(scheduler.stderr).toContain(
        "DATABASE_URL or QUEUE_DATABASE_URL is required",
      );
    },
    TIMEOUT_MS,
  );
});
