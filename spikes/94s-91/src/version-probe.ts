import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const sdkEntry = Bun.resolveSync(
  "@anthropic-ai/claude-agent-sdk",
  import.meta.dir,
);
const sdkPackage = JSON.parse(
  await readFile(join(dirname(sdkEntry), "package.json"), "utf8"),
) as { version: string };
const executable = Bun.resolveSync(
  "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
  import.meta.dir,
);
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
