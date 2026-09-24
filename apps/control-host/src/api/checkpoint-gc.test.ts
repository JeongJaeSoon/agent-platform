import { expect, test } from "bun:test";
import { createLogger } from "@agent-platform/observability";

import { runCheckpointGc } from "./checkpoint-gc.ts";

function logger() {
  const lines: Array<{ fields?: unknown; message: string }> = [];
  return Object.assign(
    createLogger({
      sinks: [
        {
          write({ fields, message }) {
            lines.push({ fields, message });
          },
        },
      ],
    }),
    { lines },
  );
}

const s3 = {
  AWS_ACCESS_KEY_ID: "id",
  AWS_REGION: "ap-northeast-1",
  AWS_SECRET_ACCESS_KEY: "secret",
  S3_BUCKET: "claude-sessions",
};

test.each([
  [{ CHECKPOINT_OBJECT_STORE: "disabled" }, "CHECKPOINT_OBJECT_STORE=disabled"],
  [
    { ...s3, CHECKPOINT_OBJECT_PROTECTION: "unversioned" },
    "CHECKPOINT_OBJECT_PROTECTION=unversioned holds nothing and pins no versions",
  ],
])(
  "a deployment with nothing held exits 0 without touching a store: %p",
  async (environment, reason) => {
    const log = logger();
    let connected = false;

    const code = await runCheckpointGc({
      connect: async () => {
        connected = true;
        throw new Error("must not connect");
      },
      environment,
      logger: log,
    });

    expect(code).toBe(0);
    expect(connected).toBe(false);
    expect(log.lines).toEqual([
      { message: "Checkpoint GC skipped", fields: { reason } },
    ]);
  },
);

test("refuses a dry-run flag it cannot read rather than deleting", async () => {
  await expect(
    runCheckpointGc({
      environment: { ...s3, CHECKPOINT_GC_DRY_RUN: "yes" },
      logger: logger(),
    }),
  ).rejects.toThrow("CHECKPOINT_GC_DRY_RUN must be true, false, 1, or 0");
});
