import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(
  import.meta.dir,
  "..",
  ".github",
  "scripts",
  "retry-flaky.sh",
);

type Outcome = {
  exitCode: number;
  stderr: string;
  stdout: string;
  summary: string;
};

async function run(args: string[]): Promise<Outcome> {
  const directory = await mkdtemp(join(tmpdir(), "retry-flaky-"));
  const summaryPath = join(directory, "summary.md");
  try {
    const process = Bun.spawn([script, ...args], {
      env: { ...Bun.env, GITHUB_STEP_SUMMARY: summaryPath },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    const summary = await readFile(summaryPath, "utf8").catch(() => "");
    return { exitCode, stderr, stdout, summary };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

/** A command that fails `failures` times before succeeding, keyed by a marker file. */
function flakyCommand(marker: string, failures: number): string[] {
  return [
    "bash",
    "-c",
    `attempts=$(cat "${marker}" 2>/dev/null || echo 0); attempts=$((attempts + 1)); echo "$attempts" > "${marker}"; [ "$attempts" -gt ${failures} ]`,
  ];
}

describe("retry-flaky.sh", () => {
  test("passes through a first-try success without annotating anything", async () => {
    const outcome = await run(["2", "always-ok", "true"]);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).not.toContain("::warning");
    expect(outcome.summary).toBe("");
  });

  test("retries a flaky command and records that it needed a second attempt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retry-flaky-marker-"));
    const marker = join(directory, "attempts");
    try {
      const outcome = await run([
        "2",
        "spikes/94s-92 check",
        ...flakyCommand(marker, 1),
      ]);

      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toContain("::warning title=flaky spike::");
      expect(outcome.stdout).toContain("passed only on attempt 2/2");
      expect(outcome.summary).toContain("spikes/94s-92 check");
      expect(outcome.summary).toContain("flaky");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("reports the command's own exit code once every attempt failed", async () => {
    const outcome = await run(["2", "broken", "bash", "-c", "exit 7"]);

    expect(outcome.exitCode).toBe(7);
    expect(outcome.stdout).toContain("::error title=spike failure::");
    expect(outcome.stdout).toContain("failed all 2 attempts (exit 7)");
    expect(outcome.summary).toContain("failed all 2 attempts");
  });

  test("runs a command exactly once when one attempt is allowed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retry-flaky-once-"));
    const marker = join(directory, "attempts");
    try {
      const outcome = await run(["1", "once", ...flakyCommand(marker, 5)]);

      expect(outcome.exitCode).not.toBe(0);
      expect(await readFile(marker, "utf8")).toBe("1\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("still fails loudly when no step summary is available", async () => {
    const process = Bun.spawn(
      [script, "2", "nosummary", "bash", "-c", "exit 4"],
      {
        env: { ...Bun.env, GITHUB_STEP_SUMMARY: "" },
        stdout: "pipe",
      },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      process.exited,
    ]);

    expect(exitCode).toBe(4);
    expect(stdout).toContain("failed all 2 attempts (exit 4)");
  });

  test("does not retry a command killed by a signal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retry-flaky-signal-"));
    const marker = join(directory, "attempts");
    try {
      // 130 is what a shell reports for a child terminated by SIGINT; a
      // cancelled workflow must not restart the suite.
      const outcome = await run([
        "3",
        "cancelled",
        "bash",
        "-c",
        `attempts=$(cat "${marker}" 2>/dev/null || echo 0); echo $((attempts + 1)) > "${marker}"; kill -INT $$`,
      ]);

      expect(outcome.exitCode).toBe(130);
      expect(await readFile(marker, "utf8")).toBe("1\n");
      expect(outcome.stdout).toContain("::error title=spike cancelled::");
      expect(outcome.stdout).not.toContain("failed (exit 130); retrying");
      expect(outcome.summary).toContain("interrupted");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("still retries a command that exits 128-255 on its own", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retry-flaky-high-exit-"));
    const marker = join(directory, "attempts");
    try {
      // 200 is inside the 128+signum range but nothing was signalled here, so
      // this is an ordinary failure and must get its retry.
      const outcome = await run([
        "2",
        "high-exit",
        "bash",
        "-c",
        `attempts=$(cat "${marker}" 2>/dev/null || echo 0); echo $((attempts + 1)) > "${marker}"; exit 200`,
      ]);

      expect(outcome.exitCode).toBe(200);
      expect(await readFile(marker, "utf8")).toBe("2\n");
      expect(outcome.stdout).toContain("failed (exit 200); retrying");
      expect(outcome.stdout).not.toContain("::error title=spike cancelled::");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects a missing command or a non-numeric attempt count", async () => {
    expect((await run(["2", "no-command"])).exitCode).toBe(2);
    expect((await run(["abc", "label", "true"])).exitCode).toBe(2);
    expect((await run(["0", "label", "true"])).exitCode).toBe(2);
  });
});
