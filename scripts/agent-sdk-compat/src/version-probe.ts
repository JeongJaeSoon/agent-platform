import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveClaudeExecutable } from "./harness";

const sdkEntry = Bun.resolveSync(
  "@anthropic-ai/claude-agent-sdk",
  import.meta.dir,
);
const sdkPackage = JSON.parse(
  await readFile(join(dirname(sdkEntry), "package.json"), "utf8"),
) as { version: string };
const executable = resolveClaudeExecutable();
const processResult = Bun.spawnSync([executable, "--version"]);

console.log(
  JSON.stringify(
    {
      arch: process.arch,
      bun: Bun.version,
      claudeCode: processResult.stdout.toString().trim(),
      executable,
      platform: process.platform,
      sdk: sdkPackage.version,
    },
    null,
    2,
  ),
);
