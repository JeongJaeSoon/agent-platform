import { expect, test } from "bun:test";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

// Minified and gzipped, as a browser downloads each entry on its own. The
// schemas entry carries zod and every contracts module: the contracts are
// not marked side-effect free, so a bundler keeps all of them.
const BUDGET_BYTES: Record<string, number> = {
  ".": 4 * 1024,
  "./schemas": 128 * 1024,
};

test("every entry has a budget", () => {
  expect(Object.keys(packageJson.exports).sort()).toEqual(
    Object.keys(BUDGET_BYTES).sort(),
  );
});

for (const [entry, file] of Object.entries(packageJson.exports)) {
  test(`${entry} stays within its bundle budget`, async () => {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "..", file)],
      target: "browser",
      minify: true,
    });
    expect(build.success).toBe(true);
    const code = await build.outputs[0]?.text();
    const gzip = Bun.gzipSync(code ?? "").length;
    const budget = BUDGET_BYTES[entry] ?? 0;
    console.log(
      `bundle budget ${entry}: ${gzip} / ${budget} bytes gzip (${code?.length} minified)`,
    );
    expect(gzip).toBeLessThanOrEqual(budget);
  });
}
