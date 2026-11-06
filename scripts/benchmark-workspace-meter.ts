import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { measureWorkspace } from "../apps/worker/src/workspace-meter.ts";

const count = Number(process.argv[2] ?? 100_000);
if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000) {
  throw new Error("File count must be between 1 and 1000000");
}
const root = mkdtempSync(
  join(resolve(import.meta.dir, ".."), ".workspace-benchmark-"),
);
try {
  const content = Buffer.alloc(1024);
  for (let index = 0; index < count; index++) {
    const directory = join(root, String(Math.floor(index / 1000)));
    if (index % 1000 === 0) mkdirSync(directory);
    writeFileSync(join(directory, String(index)), content);
  }
  const started = performance.now();
  let eventLoopTicks = 0;
  const timer = setInterval(() => {
    eventLoopTicks++;
  }, 10);
  const result = await measureWorkspace(
    root,
    120_000,
    new AbortController().signal,
  ).finally(() => clearInterval(timer));
  const wallMs = performance.now() - started;
  const du = Bun.spawn(["du", "-sk", root], { stdout: "pipe" });
  const duBytes =
    Number((await new Response(du.stdout).text()).split(/\s/)[0]) * 1024;
  if ((await du.exited) !== 0) throw new Error("du failed");
  console.log(
    JSON.stringify({
      files: count,
      ...result,
      wallMs,
      eventLoopTicks,
      duBytes,
      matchesDu: result.bytes === duBytes,
    }),
  );
  if (
    !result.complete ||
    result.inodes !== count + Math.ceil(count / 1000) + 1 ||
    result.bytes !== duBytes
  ) {
    throw new Error("Workspace measurement disagrees with fixture or du");
  }
} finally {
  rmSync(root, { recursive: true });
}
