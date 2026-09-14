import { spawn } from "node:child_process";
import {
  type Options,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { frameFromNativeMessage } from "./mapper.ts";
import {
  type RuntimePolicy,
  runtimeEnvironment,
  validateRuntimeConfig,
} from "./profile.ts";
import type {
  AgentFrame,
  AgentInput,
  AgentRun,
  AgentRuntime,
  NativeSdkMessage,
  PermissionDecision,
  PermissionRequest,
  RuntimeConfig,
} from "./runtime.ts";

class InputStream implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private readonly waiting: Array<
    (value: IteratorResult<SDKUserMessage>) => void
  > = [];
  private finished = false;

  push(input: AgentInput): void {
    if (this.finished) throw new Error("Input stream is closed");
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: input.message },
      parent_tool_use_id: null,
      uuid: input.uuid as NonNullable<SDKUserMessage["uuid"]>,
    };
    const waiter = this.waiting.shift();
    if (waiter === undefined) this.queued.push(message);
    else waiter({ done: false, value: message });
  }

  finish(): void {
    this.finished = true;
    for (const waiter of this.waiting.splice(0))
      waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        const value = this.queued.shift();
        if (value !== undefined) return { done: false, value };
        if (this.finished) return { done: true, value: undefined };
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiting.push(resolve);
        });
      },
    };
  }
}

export class ClaudeSdkRuntime implements AgentRuntime {
  constructor(
    private readonly policy: RuntimePolicy,
    private readonly processObserver?: RuntimeProcessObserver,
  ) {}

  start(
    config: RuntimeConfig,
    onPermission: (request: PermissionRequest) => Promise<PermissionDecision>,
  ): AgentRun {
    validateRuntimeConfig(config, this.policy);
    const input = new InputStream();
    const abortController = new AbortController();
    const sdkQuery = query({
      prompt: input,
      options: buildSdkOptions(
        config,
        onPermission,
        abortController,
        this.processObserver,
      ),
    });
    return new ClaudeSdkRun(
      config.correlationId,
      input,
      sdkQuery,
      abortController,
    );
  }
}

export function buildSdkOptions(
  config: RuntimeConfig,
  onPermission: (request: PermissionRequest) => Promise<PermissionDecision>,
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
      const decision = await onPermission({
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
    ...(config.resume === undefined ? {} : { resume: config.resume }),
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

class ClaudeSdkRun implements AgentRun {
  constructor(
    private readonly correlationId: string,
    private readonly input: InputStream,
    private readonly sdkQuery: Query,
    private readonly abortController: AbortController,
  ) {}

  send(input: AgentInput): void {
    this.input.push(input);
  }

  finishInput(): void {
    this.input.finish();
  }

  async interrupt(): Promise<{ stillQueued: string[] }> {
    const receipt = await this.sdkQuery.interrupt();
    return { stillQueued: receipt?.still_queued ?? [] };
  }

  abort(): void {
    this.abortController.abort();
  }

  close(): void {
    this.input.finish();
    this.sdkQuery.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentFrame> {
    let cursor = 0;
    for await (const message of this.sdkQuery) {
      yield frameFromNativeMessage(
        message as SDKMessage as unknown as NativeSdkMessage,
        this.correlationId,
        `sdk:${cursor}`,
      );
      cursor += 1;
    }
  }
}
