import { spawn } from "node:child_process";
import type {
  AgentRun,
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeHooks,
} from "@agent-platform/runtime-core";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";

import {
  CLAUDE_RUNTIME_CAPABILITIES,
  type ClaudeRuntimeConfig,
} from "./config.ts";
import {
  type RuntimePolicy,
  runtimeEnvironment,
  validateRuntimeConfig,
} from "./profile.ts";
import { ClaudeSdkRun, InputStream } from "./run.ts";

export class ClaudeSdkRuntime implements AgentRuntime<ClaudeRuntimeConfig> {
  readonly capabilities: RuntimeCapabilities = CLAUDE_RUNTIME_CAPABILITIES;

  constructor(
    private readonly policy: RuntimePolicy,
    private readonly processObserver?: RuntimeProcessObserver,
  ) {}

  start(config: ClaudeRuntimeConfig, hooks: RuntimeHooks): AgentRun {
    validateRuntimeConfig(config, this.policy);
    const input = new InputStream();
    const abortController = new AbortController();
    const sdkQuery = query({
      prompt: input,
      options: buildSdkOptions(
        config,
        hooks,
        abortController,
        this.processObserver,
      ),
    });
    return new ClaudeSdkRun(
      config.correlationId,
      input,
      sdkQuery,
      abortController,
      config.resume,
    );
  }
}

export function buildSdkOptions(
  config: ClaudeRuntimeConfig,
  hooks: RuntimeHooks,
  abortController = new AbortController(),
  processObserver?: RuntimeProcessObserver,
): Options {
  const permittedTools = new Set(config.tools);
  return {
    abortController,
    canUseTool: async (tool, toolInput, options) => {
      if (!permittedTools.has(tool)) {
        return {
          behavior: "deny",
          message: "Tool is outside the server allowlist",
          toolUseID: options.toolUseID,
        };
      }
      const decision = await hooks.onPermission({
        input: toolInput,
        requestId: options.requestId,
        signal: options.signal,
        tool,
        toolUseId: options.toolUseID,
      });
      return { ...decision, toolUseID: options.toolUseID };
    },
    cwd: config.cwd,
    env: runtimeEnvironment(config),
    ...(config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }),
    ...(config.mcpServers === undefined
      ? {}
      : { mcpServers: config.mcpServers as never }),
    model: config.model,
    pathToClaudeCodeExecutable: resolvePinnedClaudeExecutable(),
    permissionMode: config.permissionMode ?? "default",
    ...(config.plugins === undefined ? {} : { plugins: config.plugins }),
    pluginDelivery: "initialize",
    ...(config.mode === "resume" ? { resume: config.resume } : {}),
    // "eager" so a batch is durable within a frame of the local write: a
    // checkpoint taken at the end of a turn should not be waiting on a flush
    // the SDK would otherwise defer.
    ...(config.sessionStore === undefined
      ? {}
      : {
          sessionStore: config.sessionStore,
          sessionStoreFlush: "eager" as const,
        }),
    settingSources: config.settingSources ?? ["project"],
    strictMcpConfig: true,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(config.appendSystemPrompt === undefined
        ? {}
        : { append: config.appendSystemPrompt }),
      snapshot: true,
    },
    tools: config.tools,
    ...(processObserver === undefined
      ? {}
      : {
          spawnClaudeCodeProcess: (options) => {
            const child = spawn(options.command, options.args, {
              cwd: options.cwd,
              env: options.env as NodeJS.ProcessEnv,
              signal: options.signal,
              stdio: ["pipe", "pipe", "pipe"],
            });
            const pid = child.pid;
            if (pid !== undefined) {
              processObserver.onSpawn(pid);
              child.once("exit", (code, signal) =>
                processObserver.onExit?.(pid, code, signal),
              );
            }
            return child;
          },
        }),
  };
}

export type RuntimeProcessObserver = {
  onExit?(
    pid: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void;
  onSpawn(pid: number): void;
};

export function resolvePinnedClaudeExecutable(): string {
  const { platform, arch } = process;
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported Claude Code architecture: ${arch}`);
  }
  const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  try {
    return Bun.resolveSync(`${packageName}/claude`, import.meta.dir);
  } catch (error) {
    if (platform !== "linux") throw error;
    return Bun.resolveSync(`${packageName}-musl/claude`, import.meta.dir);
  }
}
