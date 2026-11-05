import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Step = {
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};
type Job = {
  if?: string;
  name?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  strategy?: { matrix: { include: { part: string; unit?: string }[] } };
  steps: Step[];
};

const workflow = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8"),
) as { jobs: Record<string, Job> };

function verdict(job: string, env: Record<string, string>, stepId?: string) {
  const steps = workflow.jobs[job]?.steps;
  const command = (stepId ? steps?.find((s) => s.id === stepId) : steps?.[0])
    ?.run;
  if (!command) throw new Error(`no verdict command in ${job}`);
  return Bun.spawnSync(["bash", "-c", command], {
    env: { ...Bun.env, CANCELLED: "false", ...env },
  }).exitCode;
}

test("static checks keep one cache writer and report independent failures", () => {
  const parts = workflow.jobs["check-part"];
  expect(
    parts?.strategy?.matrix.include.filter((entry) => !entry.unit),
  ).toEqual([]);
  const job = workflow.jobs.static;
  expect(job?.name).toBe("check (static)");
  expect(job?.needs).toBe("changes");
  for (const command of [
    "bun run typecheck",
    "bun run lint",
    "bun scripts/third-party-notices.ts --check",
  ]) {
    const steps = job?.steps.filter((step) => step.run === command);
    expect(steps).toHaveLength(1);
    expect(steps?.[0]?.if).toBe(
      command === "bun run typecheck"
        ? undefined
        : "!cancelled() && steps.install.outcome == 'success'",
    );
  }
  expect(job?.steps.find((step) => step.id === "install")?.run).toBe(
    "bun install --frozen-lockfile",
  );
  expect(job?.steps.find((step) => step.with?.["save-cache"])?.with).toEqual({
    "save-cache": "true",
  });
  expect(parts?.steps.some((step) => step.with?.["save-cache"])).toBe(false);
});

test("required check only accepts verified product or documentation results", () => {
  const job = workflow.jobs.check;
  expect(job?.needs).toEqual([
    "changes",
    "static",
    "check-part",
    "docs-checks",
  ]);
  expect(job?.if).toMatch(/^always\(\)/);
  expect(job?.steps[0]?.env?.RESULT).toBe(`\${{ needs.check-part.result }}`);
  const product = {
    PLAN: "success",
    STATIC: "success",
    DOCS: "skipped",
    TESTS: "true",
    DOCS_ONLY: "false",
    RESULT: "success",
  };
  expect(verdict("check", product)).toBe(0);
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    expect(verdict("check", { ...product, RESULT: result })).not.toBe(0);
  }
  const docs = {
    ...product,
    DOCS: "success",
    TESTS: "false",
    DOCS_ONLY: "true",
    RESULT: "skipped",
  };
  expect(verdict("check", docs)).toBe(0);
  for (const key of ["PLAN", "STATIC", "DOCS"]) {
    for (const result of ["failure", "cancelled", "skipped", ""]) {
      expect(verdict("check", { ...docs, [key]: result })).not.toBe(0);
    }
  }
  expect(verdict("check", { ...docs, DOCS_ONLY: "" })).not.toBe(0);
  expect(verdict("check", { ...docs, RESULT: "failure" })).not.toBe(0);
  expect(workflow.jobs["docs-checks"]?.if).toContain(
    "needs.changes.outputs.docs_only == 'true'",
  );
  expect(workflow.jobs["docs-checks"]?.steps.at(-1)?.run).toBe(
    "bun test ./tests",
  );
});

test("required integration never treats an unplanned skip as success", () => {
  const job = workflow.jobs.integration;
  expect(job?.needs).toEqual(["changes", "integration-domain"]);
  expect(job?.if).toMatch(/^always\(\)/);
  expect(job?.steps[0]?.env?.RESULT).toBe(
    `\${{ needs.integration-domain.result }}`,
  );
  const product = {
    PLAN: "success",
    TESTS: "true",
    DOCS_ONLY: "false",
    RESULT: "success",
  };
  expect(verdict("integration", product)).toBe(0);
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    expect(verdict("integration", { ...product, RESULT: result })).not.toBe(0);
  }
  const docs = {
    PLAN: "success",
    TESTS: "false",
    DOCS_ONLY: "true",
    RESULT: "skipped",
  };
  expect(verdict("integration", docs)).toBe(0);
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    expect(verdict("integration", { ...docs, PLAN: result })).not.toBe(0);
  }
  expect(verdict("integration", { ...docs, DOCS_ONLY: "" })).not.toBe(0);
  expect(verdict("integration", { ...docs, RESULT: "failure" })).not.toBe(0);
});

test("e2e and quickstart always validate the plan and retain their required names", () => {
  for (const [name, flag, variable] of [
    ["e2e", "product", "PRODUCT"],
    ["quickstart", "quickstart", "QUICKSTART"],
  ]) {
    if (!name || !flag || !variable) throw new Error("missing guard case");
    const job = workflow.jobs[name];
    expect(job?.needs).toBe("changes");
    expect(job?.if).toMatch(/^always\(\)/);
    expect(
      verdict(name, {
        PLAN: "success",
        [variable]: "true",
        DOCS_ONLY: "false",
      }),
    ).toBe(0);
    expect(
      verdict(name, {
        PLAN: "success",
        [variable]: "false",
        DOCS_ONLY: "true",
      }),
    ).toBe(0);
    for (const state of ["failure", "cancelled", "skipped", ""]) {
      expect(
        verdict(name, {
          PLAN: state,
          [variable]: "false",
          DOCS_ONLY: "true",
        }),
      ).not.toBe(0);
    }
    expect(
      verdict(name, {
        PLAN: "success",
        [variable]: "false",
        DOCS_ONLY: "false",
      }),
    ).not.toBe(0);
    expect(
      verdict(name, {
        PLAN: "success",
        [variable]: "",
        DOCS_ONLY: "true",
      }),
    ).not.toBe(0);
    for (const step of job?.steps.slice(1).filter((s) => s.id !== "verdict") ??
      []) {
      expect(step.if).toContain(`needs.changes.outputs.${flag} == 'true'`);
    }
  }
  expect(
    verdict("quickstart", {
      PLAN: "success",
      QUICKSTART: "true",
      DOCS_ONLY: "true",
    }),
  ).toBe(0);
});

test("all product and site consumers use the same explicit plan", () => {
  for (const [name, flag] of [
    ["check-part", "tests"],
    ["integration-domain", "tests"],
    ["storybook", "site"],
    ["docs", "site"],
    ["demo", "product"],
    ["ui-pack", "product"],
    ["workspace-quota", "product"],
    ["helm-chart", "product"],
    ["k8s-smoke", "product"],
  ]) {
    if (!name || !flag) throw new Error("missing plan consumer");
    const job = workflow.jobs[name];
    expect([job?.needs].flat()).toContain("changes");
    expect(job?.if).toContain(`needs.changes.outputs.${flag} == 'true'`);
  }
  expect(workflow.jobs.pages?.needs).toEqual(["docs", "storybook"]);
  for (const key of ["tests", "product", "site", "quickstart", "docs_only"]) {
    expect(workflow.jobs.changes?.outputs?.[key]).toBe(
      `\${{ steps.plan.outputs.${key} }}`,
    );
  }
});

test("cancelled workflows cannot report required success from an earlier successful plan", () => {
  const env = {
    PLAN: "success",
    STATIC: "success",
    DOCS: "skipped",
    TESTS: "true",
    DOCS_ONLY: "false",
    RESULT: "success",
    PRODUCT: "true",
    QUICKSTART: "true",
    CANCELLED: "true",
  };
  for (const job of ["check", "integration", "e2e", "quickstart"]) {
    expect(verdict(job, env)).not.toBe(0);
  }
});

test("required heavy jobs verify actual outcomes after planned steps", () => {
  const e2e = {
    PLAN: "success",
    PRODUCT: "true",
    DOCS_ONLY: "false",
    SCENARIO: "success",
  };
  expect(verdict("e2e", e2e, "verdict")).toBe(0);
  for (const state of ["failure", "cancelled", "skipped", ""]) {
    expect(verdict("e2e", { ...e2e, SCENARIO: state }, "verdict")).not.toBe(0);
  }
  expect(
    verdict(
      "e2e",
      {
        ...e2e,
        PRODUCT: "false",
        DOCS_ONLY: "true",
        SCENARIO: "skipped",
      },
      "verdict",
    ),
  ).toBe(0);
  expect(verdict("e2e", { ...e2e, CANCELLED: "true" }, "verdict")).not.toBe(0);

  const quickstart = {
    PLAN: "success",
    QUICKSTART: "true",
    DOCS_ONLY: "false",
    GUIDE: "success",
    API_GUIDE: "success",
  };
  expect(verdict("quickstart", quickstart, "verdict")).toBe(0);
  for (const key of ["GUIDE", "API_GUIDE"]) {
    for (const state of ["failure", "cancelled", "skipped", ""]) {
      expect(
        verdict("quickstart", { ...quickstart, [key]: state }, "verdict"),
      ).not.toBe(0);
    }
  }
  expect(
    verdict(
      "quickstart",
      {
        PLAN: "success",
        QUICKSTART: "false",
        DOCS_ONLY: "true",
        GUIDE: "skipped",
        API_GUIDE: "skipped",
      },
      "verdict",
    ),
  ).toBe(0);
  expect(
    verdict(
      "quickstart",
      {
        ...quickstart,
        CANCELLED: "true",
      },
      "verdict",
    ),
  ).not.toBe(0);

  for (const name of ["check", "integration", "e2e", "quickstart"]) {
    expect(workflow.jobs[name]?.steps[0]?.env?.CANCELLED).toBe(
      `\${{ cancelled() }}`,
    );
  }
  for (const name of ["e2e", "quickstart"]) {
    const final = workflow.jobs[name]?.steps.find((s) => s.id === "verdict");
    expect(final?.if).toBe("always()");
    expect(final?.env?.CANCELLED).toBe(`\${{ cancelled() }}`);
  }
  expect(
    workflow.jobs.e2e?.steps.find((s) => s.id === "verdict")?.env?.SCENARIO,
  ).toBe(`\${{ steps.scenario.outcome }}`);
  const finalGuide = workflow.jobs.quickstart?.steps.find(
    (s) => s.id === "verdict",
  );
  expect(finalGuide?.env?.GUIDE).toBe(`\${{ steps.guide.outcome }}`);
  expect(finalGuide?.env?.API_GUIDE).toBe(`\${{ steps.api-guide.outcome }}`);
});
