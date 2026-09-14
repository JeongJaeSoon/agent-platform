import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";

export type AnthropicRequest = {
  messages?: unknown[];
  model?: string;
  stream?: boolean;
  system?: unknown;
  tools?: unknown[];
};

export type FakeBlock =
  | { text: string; type: "text" }
  | {
      id: string;
      input: Record<string, unknown>;
      name: string;
      type: "tool_use";
    };

export type FakeReply = {
  content: FakeBlock[];
  stopReason: "end_turn" | "tool_use";
};

export type RecordedRequest = {
  body: AnthropicRequest;
  headers: Record<string, string>;
  path: string;
  signal?: AbortSignal;
};

export type FakeAnthropicServer = {
  requests: RecordedRequest[];
  stop(): void;
  url: string;
};

export type ProbeContext = {
  claudeHome: string;
  dispose(): Promise<void>;
  executable: string;
  root: string;
  workspace: string;
};

export function startFakeAnthropicServer(
  reply: (
    request: RecordedRequest,
    index: number,
  ) => FakeReply | Response | Promise<FakeReply | Response>,
): FakeAnthropicServer {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/messages")) {
        return new Response("not found", { status: 404 });
      }

      const recorded = {
        body: (await request.json()) as AnthropicRequest,
        headers: Object.fromEntries(request.headers.entries()),
        path: `${url.pathname}${url.search}`,
        signal: request.signal,
      };
      requests.push(recorded);
      const response = await reply(recorded, requests.length - 1);
      if (response instanceof Response) return response;
      return anthropicResponse(
        recorded.body.model ?? "claude-sonnet-4-5",
        response,
        recorded.body.stream === true,
      );
    },
  });

  return {
    requests,
    stop: () => server.stop(true),
    url: `http://127.0.0.1:${server.port}`,
  };
}

export async function createProbeContext(): Promise<ProbeContext> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "94s-91-sdk-")));
  const workspace = join(root, "workspace");
  const claudeHome = join(root, "claude-home");
  await mkdir(join(workspace, ".claude"), { recursive: true });
  await mkdir(claudeHome, { recursive: true });

  return {
    claudeHome,
    dispose: () => rm(root, { force: true, recursive: true }),
    executable: resolveClaudeExecutable(),
    root,
    workspace,
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
    env: sdkEnvironment(context, baseUrl),
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

function sdkEnvironment(
  context: ProbeContext,
  baseUrl: string,
): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: "fake-sdk-contract-key",
    ANTHROPIC_BASE_URL: baseUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CONFIG_DIR: context.claudeHome,
    HOME: context.claudeHome,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
}

function anthropicResponse(
  model: string,
  reply: FakeReply,
  stream: boolean,
): Response {
  const message = {
    id: `msg_94s91_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content: reply.content,
    stop_reason: reply.stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 4 },
  };

  if (!stream) {
    return Response.json(message, {
      headers: { "request-id": `req_${crypto.randomUUID()}` },
    });
  }

  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: { ...message, content: [], stop_reason: null },
    },
  ];
  for (const [index, block] of reply.content.entries()) {
    if (block.type === "text") {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        },
      );
    } else {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        },
      );
    }
    events.push({ type: "content_block_stop", index });
  }
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: reply.stopReason, stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  );

  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream",
        "request-id": `req_${crypto.randomUUID()}`,
      },
    },
  );
}

export function textReply(text: string): FakeReply {
  return { content: [{ type: "text", text }], stopReason: "end_turn" };
}

export function toolReply(
  name: string,
  input: Record<string, unknown>,
  id = `toolu_94s91_${crypto.randomUUID()}`,
): FakeReply {
  return toolsReply([{ id, input, name }]);
}

export function toolsReply(
  tools: Array<{
    id: string;
    input: Record<string, unknown>;
    name: string;
  }>,
): FakeReply {
  return {
    content: tools.map(({ id, input, name }) => ({
      type: "tool_use" as const,
      id,
      input,
      name,
    })),
    stopReason: "tool_use",
  };
}
