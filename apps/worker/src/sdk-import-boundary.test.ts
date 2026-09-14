import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

test("keeps the production SDK import inside the adapter boundary", async () => {
  const files = (await readdir(import.meta.dir)).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );
  const importing = [];
  for (const file of files) {
    const source = await readFile(join(import.meta.dir, file), "utf8");
    if (source.includes('from "@anthropic-ai/claude-agent-sdk"'))
      importing.push(file);
  }
  expect(importing).toEqual(["sdk-adapter.ts"]);
});
