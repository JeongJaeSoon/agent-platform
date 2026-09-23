import { describe, expect, test } from "bun:test";
import { FakeWorkerGateway } from "./fake-gateway.ts";
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
      egressCredentialUrl: "http://egress-proxy:3129",
      executionGeneration: 1,
      executionId: "exec-1",
      gatewayUrl: "http://control-host:8080",
      objectStore: {
        accessKeyId: "test",
        bucket: "claude-sessions",
        endpoint: "http://localstack:4566",
        region: "ap-northeast-1",
        scope: "sessions/00000000-0000-4000-8000-000000000001/",
        secretAccessKey: "test",
      },
      runtime: {
        claudeConfigDir: "/home/worker/.claude",
        cwd: "/workspace",
        home: "/home/worker",
        providerMaxRetries: 2,
      },
      timeouts: {
        answerPollIntervalMs: 1_000,
        claimTimeoutMs: 1_000,
        drainTimeoutMs: 1_000,
        heartbeatIntervalMs: 1_000,
        idleTimeoutMs: 1_000,
        maxTurnMs: 60_000,
        nextInputRetryTimeoutMs: 60_000,
        nextInputWaitMs: 1_000,
        questionTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
        startupTimeoutMs: 60_000,
      },
    });

    expect(host).toBeInstanceOf(WorkerHost);
    expect(typeof HttpWorkerGatewayClient).toBe("function");
  });

  test("the unwired checkpoint port refuses a restore", async () => {
    const claim = await new FakeWorkerGateway().bootstrapClaim({
      execution_id: "execution-1",
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: "nonce" },
    });
    const signal = new AbortController().signal;
    expect(await unwiredCheckpoints.restorePlan(claim, signal)).toEqual({
      mode: "new",
    });
    await expect(
      unwiredCheckpoints.restorePlan(
        {
          ...claim,
          restore: {
            revision: 2,
            manifest_ref: "checkpoints/2.json",
            manifest_sha256: "b".repeat(64),
          },
        },
        signal,
      ),
    ).rejects.toThrow("no restorer bound");
  });
});
