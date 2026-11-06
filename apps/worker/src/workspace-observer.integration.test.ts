import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createConsoleLogger } from "./console-logger.ts";
import { WorkspaceObserver } from "./workspace-observer.ts";

test("a live observer emits structured measurements and axis metrics", async () => {
  const root = await mkdtemp(
    join(import.meta.dir, ".workspace-observer-test-"),
  );
  const lines: Array<Record<string, unknown>> = [];
  let measured: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    measured = resolve;
  });
  const observer = new WorkspaceObserver(
    { root },
    createConsoleLogger({
      write: (line) => {
        const record = JSON.parse(line) as Record<string, unknown>;
        lines.push(record);
        if (record.metric === "workspace_measure_duration_seconds")
          measured?.();
      },
    }),
  );
  const timeout = setTimeout(() => measured?.(), 5000);
  try {
    await writeFile(join(root, "file"), "data");
    observer.start();
    await ready;
    const usage = lines.find(
      (line) => line.metric === "workspace_usage_inodes",
    );
    expect(usage).toMatchObject({ value: 2, complete: true });
    expect(
      lines.filter((line) => line.metric === "workspace_limit_mode"),
    ).toHaveLength(2);
    expect(
      lines.find((line) => line.event === "workspace_measurement"),
    ).toMatchObject({ complete: true, inodes: 2 });
    console.log(
      JSON.stringify({
        observer: "VERIFIED",
        metrics: lines.filter((line) => line.metric !== undefined),
      }),
    );
  } finally {
    clearTimeout(timeout);
    observer.stop();
    await rm(root, { recursive: true });
  }
});
