import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const SDK = "@anthropic-ai/claude-agent-sdk";

function pinnedSdk(manifest: string): string | undefined {
  const pkg = JSON.parse(readFileSync(join(root, manifest), "utf8"));
  return pkg.dependencies?.[SDK];
}

// The harness has its own lockfile, so nothing else keeps it on the SDK the
// product ships; a pass there would vouch for a version the product does not run.
test("the compat harness pins the same Agent SDK as the product runtime", () => {
  const product = pinnedSdk("packages/adapters/runtimes/claude/package.json");
  const harness = pinnedSdk("scripts/agent-sdk-compat/package.json");
  expect(product).toMatch(/^\d+\.\d+\.\d+$/);
  expect(harness).toBe(product);
});
