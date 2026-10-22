import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");

function dependencies(manifest: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(root, manifest), "utf8"));
  return pkg.dependencies ?? {};
}

// The harness has its own lockfile, so nothing else keeps it on the SDK (and
// the zod its MCP tools are built with) the product ships; a pass there would
// vouch for versions the product does not run.
test("the compat harness pins the same runtime dependencies as the product", () => {
  const product = dependencies(
    "packages/adapters/runtimes/claude/package.json",
  );
  const harness = dependencies("scripts/agent-sdk-compat/package.json");
  expect(product["@anthropic-ai/claude-agent-sdk"]).toMatch(/^\d+\.\d+\.\d+$/);

  const shared = Object.keys(harness).filter((name) => name in product);
  expect(shared).toContain("@anthropic-ai/claude-agent-sdk");
  expect(shared).toContain("zod");
  for (const name of shared) {
    expect({ name, version: harness[name] }).toEqual({
      name,
      version: product[name],
    });
  }
});
