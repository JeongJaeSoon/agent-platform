import { describe, expect, test } from "bun:test";

import {
  ClaudeSdkRuntime,
  createWorkerHost,
  FakeAgentRuntime,
  HttpWorkerGatewayClient,
  unwiredCheckpoints,
  WorkerHost,
} from "./index.ts";

describe("worker composition surface", () => {
  test("exposes the Claude runtime and its fake through the adapter package", () => {
    expect(typeof ClaudeSdkRuntime).toBe("function");
    expect(new FakeAgentRuntime([]).capabilities).toEqual({
      checkpoint: true,
      interrupt: true,
      resume: true,
    });
  });

  test("builds a host from the environment the launcher provides", () => {
    const host = createWorkerHost({
      bootstrapNonce: "wln_test",
      executionGeneration: 1,
      executionId: "exec-1",
      gatewayUrl: "http://control-host:8080",
      runtime: {
        claudeConfigDir: "/home/worker/.claude",
        cwd: "/workspace",
        home: "/home/worker",
        model: "claude-sonnet-4-5",
        permissionMode: "default",
        profile: {
          kind: "litellm",
          endpoint: "http://litellm:4000",
          auth: { kind: "api_key", value: "placeholder" },
        },
        tools: [],
      },
      timeouts: {
        answerPollIntervalMs: 1_000,
        claimTimeoutMs: 1_000,
        drainTimeoutMs: 1_000,
        heartbeatIntervalMs: 1_000,
        idleTimeoutMs: 1_000,
        nextInputWaitMs: 1_000,
        questionTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      },
    });

    expect(host).toBeInstanceOf(WorkerHost);
    expect(typeof HttpWorkerGatewayClient).toBe("function");
  });

  test("the checkpoint port refuses a restore it cannot honour yet", async () => {
    expect(await unwiredCheckpoints.restorePlan(null)).toEqual({ mode: "new" });
    await expect(
      unwiredCheckpoints.restorePlan({
        revision: 2,
        manifest_ref: "checkpoints/2.json",
        manifest_sha256: "b".repeat(64),
      }),
    ).rejects.toThrow("94S-201");
  });
});
