import { describe, expect, test } from "bun:test";
import { CLAUDE_AGENT_SDK_VERSION } from "@agent-platform/runtime-claude";

import { claudeRuntimeRegistry } from "./composition.ts";
import type { WorkerConfig } from "./config.ts";
import { EngineProcesses } from "./engine-processes.ts";

const config: WorkerConfig = {
  bootstrapNonce: "wln_test",
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
};

describe("claudeRuntimeRegistry", () => {
  test("serves a session created for the engine this image ships", () => {
    const launcher = claudeRuntimeRegistry(
      config,
      new EngineProcesses(),
    ).launcherFor({
      kind: "claude_agent_sdk",
      version: CLAUDE_AGENT_SDK_VERSION,
      profile_id: "default",
    });

    expect(typeof launcher.start).toBe("function");
  });

  test("refuses a session that asks for another engine", () => {
    expect(() =>
      claudeRuntimeRegistry(config, new EngineProcesses()).launcherFor({
        kind: "codex_app_server",
        version: "1.0.0",
        profile_id: "default",
      }),
    ).toThrow("not codex_app_server");
  });

  test("refuses a build of the engine this image does not ship", () => {
    // A transcript is only replayable on the build that wrote it, so a
    // version this image cannot provide is refused rather than approximated.
    expect(() =>
      claudeRuntimeRegistry(config, new EngineProcesses()).launcherFor({
        kind: "claude_agent_sdk",
        version: "0.0.1",
        profile_id: "default",
      }),
    ).toThrow("this worker ships Agent SDK");
  });

  test("a profile that wants CLAUDE.md gets no engine when the workspace cannot vouch for one", () => {
    const launcher = claudeRuntimeRegistry(
      config,
      new EngineProcesses(),
    ).launcherFor({
      kind: "claude_agent_sdk",
      version: CLAUDE_AGENT_SDK_VERSION,
      profile_id: "default",
    });

    expect(() =>
      launcher.start(
        {
          committedClaudeMd: () => {
            throw new Error(
              "Repository CLAUDE.md refused: a restored workspace has no freshly fetched commit behind it",
            );
          },
          correlationId: "s:a",
          mode: "new",
          principal: { owner_scope: "owner-a" },
          runtimeConfig: {
            model: "m",
            tools: [],
            permission_mode: "default",
            provider: {
              kind: "anthropic",
              endpoint: "http://127.0.0.1:9",
              auth: { kind: "api_key", value: "placeholder" },
            },
            project_settings: { claude_md: true },
          },
        },
        { onPermission: async () => ({ behavior: "deny", message: "none" }) },
      ),
    ).toThrow("no freshly fetched commit");
  });
});
