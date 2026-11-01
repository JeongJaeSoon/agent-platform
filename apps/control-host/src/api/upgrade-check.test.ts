import { describe, expect, test } from "bun:test";
import { createLogger } from "@werft-ai/observability";
import type { UpgradeSession } from "@werft-ai/platform";
import {
  runUpgradeCheck,
  type UpgradeCheckEnvironment,
} from "./upgrade-check.ts";

const current = {
  cliVersion: "2.1.280",
  engine: "claude",
  profileDigestScheme: 1,
  sdkVersion: "0.3.280",
};
const previous = { ...current, cliVersion: "2.1.270", sdkVersion: "0.3.270" };

const environment: UpgradeCheckEnvironment = {
  DATABASE_URL: "postgres://upgrade-check.invalid/db",
  UPGRADE_DEPLOYED_WORKER_IMAGE: "worker@sha256:n",
  WORKER_IMAGE: "worker@sha256:n1",
  WORKER_IMAGE_RUNTIME: JSON.stringify(current),
  WORKER_IMAGE_PREVIOUS: "worker@sha256:n",
  WORKER_IMAGE_PREVIOUS_RUNTIME: JSON.stringify(previous),
};

const unrecorded: UpgradeSession = {
  sessionId: "s-unrecorded",
  pointer: { kind: "unrecorded" },
};

async function run(
  overrides: Partial<UpgradeCheckEnvironment>,
  listSessions: () => Promise<readonly UpgradeSession[]> = async () => [],
) {
  const lines: string[] = [];
  const code = await runUpgradeCheck({
    environment: { ...environment, ...overrides },
    logger: createLogger({ sinks: [{ write() {} }] }),
    listSessions,
    write: (line) => lines.push(line),
  });
  expect(lines).toHaveLength(1);
  return { code, output: JSON.parse(lines[0] as string) };
}

describe("runUpgradeCheck", () => {
  test("no affected session proceeds with exit 0", async () => {
    const { code, output } = await run({});
    expect(code).toBe(0);
    expect(output).toEqual({
      verdict: "proceed",
      deployedWorker: "worker@sha256:n",
      targetWorker: "worker@sha256:n1",
      targetPreviousWorker: "worker@sha256:n",
      affected: [],
      approved: [],
    });
  });

  test("an affected session refuses with exit 2 until UPGRADE_APPROVED_SESSIONS names exactly it", async () => {
    const refused = await run({}, async () => [unrecorded]);
    expect(refused.code).toBe(2);
    expect(refused.output.verdict).toBe("refused");
    expect(refused.output.affected).toEqual([
      { sessionId: "s-unrecorded", reason: "unrecorded" },
    ]);

    const approved = await run(
      { UPGRADE_APPROVED_SESSIONS: '["s-unrecorded"]' },
      async () => [unrecorded],
    );
    expect(approved.code).toBe(0);
    expect(approved.output.approved).toEqual(["s-unrecorded"]);
  });

  test("a target whose previous image is not the deployed one refuses with exit 2", async () => {
    const { code, output } = await run({
      UPGRADE_DEPLOYED_WORKER_IMAGE: "worker@sha256:n-minus-1",
    });
    expect(code).toBe(2);
    expect(output.reason).toContain("is not the deployed one");
  });

  test("an unreadable database stops the upgrade with exit 1 and no override", async () => {
    const { code, output } = await run(
      { UPGRADE_APPROVED_SESSIONS: '["s-unrecorded"]' },
      async () => {
        throw new Error("connect ECONNREFUSED");
      },
    );
    expect(code).toBe(1);
    expect(output.verdict).toBe("check_failed");
    expect(output.reason).toContain("ECONNREFUSED");
  });

  test.each([
    [
      "an empty deployed image (helm template, --dry-run)",
      { UPGRADE_DEPLOYED_WORKER_IMAGE: "" },
      "could not be read",
    ],
    [
      "no target runtime",
      {
        WORKER_IMAGE_RUNTIME: undefined,
        WORKER_IMAGE_PREVIOUS_RUNTIME: undefined,
      },
      "WORKER_IMAGE_RUNTIME is not set",
    ],
    [
      "a malformed target runtime",
      { WORKER_IMAGE_RUNTIME: "{" },
      "WORKER_IMAGE_RUNTIME",
    ],
    [
      "a previous image without its runtime",
      { WORKER_IMAGE_PREVIOUS_RUNTIME: undefined },
      "go together",
    ],
    [
      "approvals that are not a list of ids",
      { UPGRADE_APPROVED_SESSIONS: '"s-1"' },
      "JSON array of session ids",
    ],
    ["no database url", { DATABASE_URL: undefined }, "DATABASE_URL"],
  ])("%s is check_failed with exit 1", async (_, overrides, reason) => {
    let read = false;
    const { code, output } = await run(overrides, async () => {
      read = true;
      return [];
    });
    expect(code).toBe(1);
    expect(output.verdict).toBe("check_failed");
    expect(output.reason).toContain(reason);
    expect(read).toBe(false);
  });
});
