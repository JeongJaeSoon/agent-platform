import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import type {
  AgentRun,
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeHooks,
} from "@agent-platform/runtime-core";
import {
  type HookCallback,
  type Options,
  query,
} from "@anthropic-ai/claude-agent-sdk";

import {
  CLAUDE_RUNTIME_CAPABILITIES,
  type ClaudeRuntimeConfig,
} from "./config.ts";
import {
  ENGINE_API_KEY_DESCRIPTOR,
  engineApiKey,
  type RuntimePolicy,
  runtimeEnvironment,
  validateRuntimeConfig,
} from "./profile.ts";
import { systemPromptAppend } from "./repository-instructions.ts";
import { ResumedHistory } from "./resumed-history.ts";
import { ClaudeSdkRun, InputStream } from "./run.ts";
import { TurnLedger } from "./turn-ledger.ts";

const MIN_BUDGET_USD = 0.000001;

export class ClaudeSdkRuntime implements AgentRuntime<ClaudeRuntimeConfig> {
  readonly capabilities: RuntimeCapabilities = CLAUDE_RUNTIME_CAPABILITIES;

  constructor(
    private readonly policy: RuntimePolicy,
    private readonly processObserver?: RuntimeProcessObserver,
  ) {}

  start(config: ClaudeRuntimeConfig, hooks: RuntimeHooks): AgentRun {
    validateRuntimeConfig(config, this.policy);
    const { history, launched } = resumedHistory(config);
    const input = new InputStream();
    const abortController = new AbortController();
    const ledger = new TurnLedger(config.resume);
    const sdkQuery = query({
      prompt: input,
      options: buildSdkOptions(
        launched,
        hooks,
        ledger,
        abortController,
        this.processObserver,
      ),
    });
    return new ClaudeSdkRun(
      config.correlationId,
      input,
      sdkQuery,
      abortController,
      history,
      ledger,
    );
  }
}

/** Where the transcript a resumed run continues comes from, read the way the engine reads it. */
function resumedHistory(config: ClaudeRuntimeConfig): {
  history: ResumedHistory;
  launched: ClaudeRuntimeConfig;
} {
  if (config.mode !== "resume") {
    return { history: ResumedHistory.empty(), launched: config };
  }
  if (config.sessionStore !== undefined) {
    const { history, store } = ResumedHistory.watching(config.sessionStore);
    return { history, launched: { ...config, sessionStore: store } };
  }
  // validateRuntimeConfig let a store-less resume through only as a local one.
  return {
    history: ResumedHistory.fromLocalDisk(
      config.claudeConfigDir,
      config.cwd,
      config.resume,
    ),
    launched: config,
  };
}

export function buildSdkOptions(
  config: ClaudeRuntimeConfig,
  hooks: RuntimeHooks,
  ledger = new TurnLedger(config.resume),
  abortController = new AbortController(),
  processObserver?: RuntimeProcessObserver,
): Options {
  const permittedTools = new Set(config.tools);
  const settle: HookCallback = async (input) => {
    if ("tool_use_id" in input) ledger.toolSettled(input.tool_use_id);
    return {};
  };
  const append = systemPromptAppend(config);
  return {
    abortController,
    canUseTool: async (tool, toolInput, options) => {
      // A denied tool never runs and no PostToolUse follows, so the gate
      // settles it here rather than waiting on a tool_result.
      const deny = (message: string) => {
        ledger.toolSettled(options.toolUseID);
        return {
          behavior: "deny" as const,
          message,
          toolUseID: options.toolUseID,
        };
      };
      if (!permittedTools.has(tool)) {
        return deny("Tool is outside the server allowlist");
      }
      const admission = ledger.permissionStarting();
      if (!admission.allowed) return deny(admission.message);
      let allowed = false;
      try {
        const decision = await hooks.onPermission({
          input: toolInput,
          requestId: options.requestId,
          signal: options.signal,
          tool,
          toolUseId: options.toolUseID,
        });
        allowed = decision.behavior === "allow";
        return { ...decision, toolUseID: options.toolUseID };
      } finally {
        ledger.permissionSettled();
        if (!allowed) ledger.toolSettled(options.toolUseID);
      }
    },
    cwd: config.cwd,
    env: runtimeEnvironment(config),
    // The checkpoint quiescence gate. PreToolUse runs for
    // every tool before the permission check, auto-allowed ones included, so
    // it is where a checkpoint lease refuses a new writer; the other three
    // are the ways a tool it admitted can end. An allow answers nothing:
    // "allow" here would skip the permission check.
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              if (!("tool_use_id" in input)) return {};
              const admission = ledger.toolStarting(input.tool_use_id);
              if (admission.allowed) return {};
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: admission.message,
                },
              };
            },
          ],
        },
      ],
      PostToolUse: [{ hooks: [settle] }],
      PostToolUseFailure: [{ hooks: [settle] }],
      PermissionDenied: [{ hooks: [settle] }],
    },
    ...(config.maxBudgetUsd === undefined
      ? {}
      : {
          // The engine refuses 0 and exits before its first request. A
          // micro-dollar, the smallest amount the platform counts, stops the
          // turn at its first request instead, which is what nothing left means.
          maxBudgetUsd: Math.max(config.maxBudgetUsd, MIN_BUDGET_USD),
        }),
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
      ...(append === undefined ? {} : { append }),
      snapshot: true,
    },
    tools: config.tools,
    spawnClaudeCodeProcess: (options) => {
      const apiKey = engineApiKey(config.profile);
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        signal: options.signal,
        // A "pipe" past stdio is a socket pair, which the engine reads
        // directly and closes (ENGINE_API_KEY_DESCRIPTOR).
        stdio:
          apiKey === undefined
            ? ["pipe", "pipe", "pipe"]
            : ["pipe", "pipe", "pipe", "pipe"],
      });
      // The SDK reads stderr only from a process it spawned itself.
      child.stderr?.resume();
      if (apiKey !== undefined) {
        const descriptor = child.stdio[ENGINE_API_KEY_DESCRIPTOR] as Writable;
        // An engine that dies before reading resets the socket; its exit
        // is what reports that, not an unhandled error here.
        descriptor.on("error", () => {});
        descriptor.end(`${apiKey}\n`);
      }
      const pid = child.pid;
      if (pid !== undefined && processObserver !== undefined) {
        processObserver.onSpawn(pid);
        child.once("exit", (code, signal) =>
          processObserver.onExit?.(pid, code, signal),
        );
      }
      return child;
    },
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
