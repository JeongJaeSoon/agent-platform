import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  createIsolatedWorkspace,
  isolatedSdkEnv,
} from "../../../packages/testkit/src/workspace.ts";

// The fake Messages API lives in packages/testkit; this spike is not a
// workspace member (own bun.lock), so it reaches the module by relative path.
export {
  type AnthropicRequest,
  type FakeAnthropicServer,
  type FakeBlock,
  type FakeReply,
  type RecordedRequest,
  startFakeAnthropicServer,
  textReply,
  toolReply,
  toolsReply,
} from "../../../packages/testkit/src/fake-anthropic.ts";

export type ProbeContext = {
  claudeHome: string;
  dispose(): Promise<void>;
  executable: string;
  root: string;
  workspace: string;
};

/**
 * A cancellable deadline. `Bun.sleep` in a lost `Promise.race` leaves a live
 * timer that holds the event loop open until it fires, which is indistinguishable
 * from work that has not finished.
 */
export function deadline(ms: number): {
  expired: Promise<void>;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
    expired,
  };
}

export async function createProbeContext(): Promise<ProbeContext> {
  const isolated = await createIsolatedWorkspace({ prefix: "94s-91-sdk-" });
  return {
    claudeHome: isolated.home,
    dispose: isolated.dispose,
    executable: resolveClaudeExecutable(),
    root: isolated.root,
    workspace: isolated.workspace,
  };
}

export async function readTranscripts(context: ProbeContext): Promise<string> {
  const files = await readdir(context.claudeHome, { recursive: true });
  const transcriptPaths = files
    .filter((path) => path.endsWith(".jsonl"))
    .map((path) => join(context.claudeHome, path));
  return (
    await Promise.all(transcriptPaths.map((path) => readFile(path, "utf8")))
  ).join("\n");
}

export function resolveClaudeExecutable(): string {
  const platform = process.platform;
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`Unsupported Claude Code architecture: ${process.arch}`);
  }
  const arch = process.arch;
  const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  try {
    return Bun.resolveSync(`${packageName}/claude`, import.meta.dir);
  } catch (error) {
    if (platform !== "linux") throw error;
    return Bun.resolveSync(`${packageName}-musl/claude`, import.meta.dir);
  }
}

export async function runSdkQuery(
  context: ProbeContext,
  baseUrl: string,
  prompt: string,
  overrides: Options = {},
): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for await (const message of query({
    prompt,
    options: sdkOptions(context, baseUrl, overrides),
  })) {
    messages.push(message);
  }
  return messages;
}

export function sdkOptions(
  context: ProbeContext,
  baseUrl: string,
  overrides: Options = {},
): Options {
  return {
    cwd: context.workspace,
    env: isolatedSdkEnv(
      { home: context.claudeHome },
      { apiKey: "fake-sdk-contract-key", baseUrl },
    ),
    maxTurns: 4,
    model: "claude-sonnet-4-5",
    pathToClaudeCodeExecutable: context.executable,
    settingSources: ["project"],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: "APPEND_SENTINEL_94S_91",
    },
    ...overrides,
  };
}
