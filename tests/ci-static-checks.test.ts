import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workflow = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8"),
) as {
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string;
      strategy?: { matrix: { include: { part: string; unit?: string }[] } };
      steps: {
        id?: string;
        if?: string;
        run?: string;
        with?: Record<string, string>;
      }[];
    }
  >;
};

test("one runner executes all static checks without removing the required aggregate", () => {
  const parts = workflow.jobs["check-part"];
  expect(parts).toBeDefined();
  expect(
    parts?.strategy?.matrix.include.filter((entry) => !entry.unit),
  ).toEqual([{ part: "static" }]);
  for (const command of [
    "bun run typecheck",
    "bun run lint",
    "bun scripts/third-party-notices.ts --check",
  ]) {
    const steps = parts?.steps.filter((step) => step.run === command);
    expect(steps).toHaveLength(1);
    expect(steps?.[0]?.if).toBe(
      command === "bun run typecheck"
        ? "matrix.part == 'static'"
        : "!cancelled() && matrix.part == 'static' && steps.install.outcome == 'success'",
    );
  }
  expect(parts?.steps.find((step) => step.id === "install")?.run).toBe(
    "bun install --frozen-lockfile",
  );
  expect(workflow.jobs.check?.needs).toBe("check-part");
  expect(parts?.steps.find((step) => step.with?.["save-cache"])?.with).toEqual({
    "save-cache": `\${{ matrix.part == 'static' }}`,
  });
});

test("the required check reports failure, cancellation and skip instead of passing", async () => {
  const aggregate = workflow.jobs.check;
  expect(aggregate?.if).toMatch(/\balways\(\)/);
  const command = aggregate?.steps[0]?.run;
  expect(command).toBeDefined();
  if (!command) throw new Error("check has no verdict command");
  for (const result of ["success", "failure", "cancelled", "skipped"]) {
    const process = Bun.spawn(["bash", "-c", command], {
      env: { ...Bun.env, RESULT: result },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await process.exited).toBe(result === "success" ? 0 : 1);
  }
});
