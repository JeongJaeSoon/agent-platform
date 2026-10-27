/**
 * Run at image build, through the registry's `image:verify`: resolves the
 * Claude Code executable exactly the way the runtime does at run time and puts
 * it on PATH as `claude`, so `docker run --rm <image> claude --version`
 * reports the bundled build and the build fails if the SDK ever stops
 * shipping it for this arch.
 *
 * The lockfile carries every SDK platform package and the resolver only falls
 * back to musl when the glibc build is missing. The image ships the glibc
 * build only: a musl fallback fails the build, and the ~200 MB musl twins are
 * dropped before the runtime stage copies node_modules.
 */
import { accessSync, constants, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolvePinnedClaudeExecutable } from "./runtime.ts";

const target = resolvePinnedClaudeExecutable();
accessSync(target, constants.X_OK);

const platformPackage = dirname(target);
if (platformPackage.endsWith("-musl")) {
  throw new Error(`The glibc Claude Code build is missing; resolved ${target}`);
}
const nodeModules = dirname(dirname(platformPackage));
// tests/images.test.ts holds this pattern to the notices' REMOVED_AFTER_INSTALL.
const musl = new Bun.Glob("@anthropic-ai/claude-agent-sdk-linux-*-musl");
for (const name of musl.scanSync({ cwd: nodeModules, onlyFiles: false })) {
  rmSync(join(nodeModules, name), { force: true, recursive: true });
}

symlinkSync(target, "/usr/local/bin/claude");
const version = Bun.spawnSync(["claude", "--version"], {
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(version.exitCode);
