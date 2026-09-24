import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each case spawns a bun process per role; a loaded runner needs more than
// the default 5s for several of them.
const TIMEOUT_MS = 30_000;

async function run(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(
    [process.execPath, "run", `${import.meta.dir}/main.ts`, ...args],
    // An otherwise empty environment: a role that got as far as reading its
    // settings would fail on them, not on the role.
    {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

describe("control host executable", () => {
  test(
    "refuses to guess a role or a mode",
    async () => {
      for (const args of [
        [],
        ["worker"],
        ["API"],
        ["api", "--once"],
        ["scheduler", "--loop"],
        ["reconciler", "--once", "--health"],
      ]) {
        const { exitCode, stderr } = await run(args);
        expect(exitCode, args.join(" ")).toBe(2);
        expect(stderr).toContain(
          "usage: bun run src/main.ts api | <scheduler|reconciler> [--once|--health]",
        );
      }
    },
    TIMEOUT_MS,
  );

  test(
    "each role validates its own settings and nothing else",
    async () => {
      // Without DATABASE_URL every role refuses, each in its own words: the
      // API before any listener, the loops before any pass, a pass before
      // it touches anything.
      const api = await run(["api"]);
      expect(api.exitCode).not.toBe(0);
      expect(api.stderr).toContain("DATABASE_URL is required");
      for (const args of [
        ["reconciler"],
        ["reconciler", "--once"],
        ["scheduler"],
        ["scheduler", "--once"],
      ]) {
        const { exitCode, stderr } = await run(args);
        expect(exitCode, args.join(" ")).not.toBe(0);
        expect(stderr, args.join(" ")).toContain(
          "DATABASE_URL or QUEUE_DATABASE_URL is required",
        );
      }
      // The loop refuses a bad pass setting once at startup rather than
      // failing every pass until the restart policy gives up. The unused
      // address shows no connection is needed to find it.
      const loop = await run(["reconciler"], {
        DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
        RECONCILER_BATCH_SIZE: "0",
      });
      expect(loop.exitCode).not.toBe(0);
      expect(loop.stderr).toContain("RECONCILER_BATCH_SIZE");
      expect(loop.stdout).not.toContain("Reconciler loop started");
    },
    TIMEOUT_MS,
  );

  test(
    "--health judges the role's own status file",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "control-host-health-"));
      try {
        const statusFile = join(dir, "status.json");
        const missing = await run(["scheduler", "--health"], {
          SCHEDULER_STATUS_FILE: statusFile,
        });
        expect(missing.exitCode).toBe(1);
        expect(missing.stderr).toContain("no status file");

        const now = new Date().toISOString();
        await writeFile(
          statusFile,
          JSON.stringify({
            loopStartedAt: now,
            passes: 1,
            lastSuccessAt: now,
            lastFailureAt: null,
            lastFailureReason: null,
            lastSkippedAt: null,
            lastPassDurationMs: 10,
            consecutiveFailures: 0,
            passDeadlineAt: null,
          }),
        );
        const healthy = await run(["scheduler", "--health"], {
          SCHEDULER_STATUS_FILE: statusFile,
        });
        expect(healthy.exitCode).toBe(0);
        expect(healthy.stdout).toContain("last successful pass");
        // The reconciler reads its own file, not the scheduler's.
        const other = await run(["reconciler", "--health"], {
          RECONCILER_STATUS_FILE: join(dir, "reconciler.json"),
          SCHEDULER_STATUS_FILE: statusFile,
        });
        expect(other.exitCode).toBe(1);
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
    TIMEOUT_MS,
  );
});
