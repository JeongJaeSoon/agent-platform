import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * scripts/k8s-api.sh against a kubectl stand-in: the Deployment it execs into
 * follows the chart's fullname rule, and only the three operator CLIs run.
 */

const script = join(import.meta.dir, "..", "scripts/k8s-api.sh");

describe("scripts/k8s-api.sh", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "k8s-api-sh-"));
    await mkdir(join(dir, "bin"));
    await writeFile(
      join(dir, "bin", "kubectl"),
      `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/kubectl-args"
`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (args: string[], env: Record<string, string> = {}) =>
    Bun.spawnSync([script, ...args], {
      env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, ...env },
      stderr: "pipe",
    });
  const kubectlArgs = async () =>
    (await readFile(join(dir, "kubectl-args"), "utf8")).trimEnd().split("\n");

  test("execs the CLI in the default release's api Deployment", async () => {
    const result = run([
      "keys",
      "create",
      "team a",
      "--scopes",
      "sessions:read",
    ]);
    expect(result.exitCode).toBe(0);
    expect(await kubectlArgs()).toEqual([
      "-n",
      "agent-platform",
      "exec",
      "deploy/agent-platform-api",
      "-c",
      "api",
      "--",
      "bun",
      "run",
      "apps/control-host/src/api/keys.ts",
      "create",
      "team a",
      "--scopes",
      "sessions:read",
    ]);
  });

  test("follows the chart's fullname for another release and namespace", async () => {
    expect(
      run(["catalog-authority", "show"], { NAMESPACE: "ap", RELEASE: "prod" })
        .exitCode,
    ).toBe(0);
    const args = await kubectlArgs();
    expect(args.slice(0, 4)).toEqual([
      "-n",
      "ap",
      "exec",
      "deploy/prod-agent-platform-api",
    ]);
    expect(args).toContain("apps/control-host/src/api/catalog-authority.ts");

    run(["grants", "revoke", "x"], { RELEASE: "agent-platform-blue" });
    expect((await kubectlArgs())[3]).toBe("deploy/agent-platform-blue-api");
  });

  test("refuses any other CLI without calling kubectl", async () => {
    for (const args of [[], ["checkpoint-gc"], ["../keys"]]) {
      const result = run(args);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain("usage:");
    }
    expect(await Bun.file(join(dir, "kubectl-args")).exists()).toBe(false);
  });
});
