import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { discover } from "../.github/scripts/test-files.ts";
import { PARTS, partOf, pick } from "../.github/scripts/unit-part.ts";

const repo = join(import.meta.dir, "..");
const script = join(repo, ".github", "scripts", "unit-part.ts");

async function part(args: string[]) {
  const process = Bun.spawn(["bun", script, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, lines: stdout.split("\n").filter(Boolean), stderr };
}

describe("unit-part.ts", () => {
  test("packages/ is one part and everything else, whatever its top directory, is the other", () => {
    expect(partOf("packages/db/src/queries.test.ts")).toBe("packages");
    expect(partOf("apps/api/src/auth.test.ts")).toBe("rest");
    expect(partOf("tests/architecture.test.ts")).toBe("rest");
    expect(partOf("xapps-e2e/a.test.ts")).toBe("rest");
    expect(partOf("apps/api/packages/x.test.ts")).toBe("rest");
  });

  test("refuses an empty part, which bun test would read as the whole suite", () => {
    expect(() => pick(["apps/a.test.ts"], "packages")).toThrow(
      "unit part packages has no files",
    );
  });

  test("the parts of this repo cover its suite exactly once", async () => {
    const outcomes = await Promise.all(PARTS.map((name) => part([name])));
    const all = outcomes.flatMap((outcome) => outcome.lines);
    const suite = discover(repo, ["tests", "packages", "apps"]).map(
      (path) => `./${path}`,
    );

    for (const outcome of outcomes) expect(outcome.exitCode).toBe(0);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(suite);
    expect(outcomes[1]?.lines).toContain("./tests/unit-part.test.ts");
  });

  test("rejects anything but a part name", async () => {
    for (const args of [[], ["apps"], ["packages", "rest"]]) {
      const outcome = await part(args);
      expect(outcome.exitCode).toBe(2);
      expect(outcome.stderr).toContain("usage:");
    }
  });
});
