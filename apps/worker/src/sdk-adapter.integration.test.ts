import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentFrame } from "./runtime.ts";
import { ClaudeSdkRuntime } from "./sdk-adapter.ts";

type RecordedRequest = {
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

type FakeReply =
  | { text: string; type: "text" }
  | {
      id: string;
      input: Record<string, unknown>;
      name: string;
      type: "tool";
    };

let root: string | undefined;
let server: ReturnType<typeof startFakeAnthropicServer> | undefined;

afterEach(async () => {
  server?.stop();
  if (root !== undefined) await rm(root, { force: true, recursive: true });
  root = undefined;
  server = undefined;
});

describe("actual Claude SDK adapter with local Messages API", () => {
  test("keeps a streaming process across turns with explicit isolated options", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "94s-18-sdk-")));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(join(workspace, ".claude"), { recursive: true });
    await mkdir(home, { recursive: true });
    server = startFakeAnthropicServer((index) => ({
      type: "text",
      text: `turn-${index + 1}`,
    }));
    const spawnedPids: number[] = [];
    const exitedPids: number[] = [];
    const runtime = new ClaudeSdkRuntime(
      {
        endpoints: [server.url],
        models: ["claude-sonnet-4-5"],
      },
      {
        onSpawn: (pid) => spawnedPids.push(pid),
        onExit: (pid) => exitedPids.push(pid),
      },
    );
    const runtimeConfig = {
      appendSystemPrompt: "APPEND_SENTINEL_94S_18",
      claudeConfigDir: home,
      correlationId: "actual-local",
      cwd: workspace,
      home,
      maxTurns: 4,
      model: "claude-sonnet-4-5",
      profile: {
        kind: "anthropic" as const,
        endpoint: server.url,
        auth: { kind: "api_key" as const, value: "placeholder-local" },
      },
      settingSources: ["project"] as ["project"],
      tools: [],
    };
    const run = runtime.start(runtimeConfig, async () => ({
      behavior: "deny",
      message: "No tools expected",
    }));

    let firstResult: (() => void) | undefined;
    const firstResultSeen = new Promise<void>((resolve) => {
      firstResult = resolve;
    });
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) {
        frames.push(frame);
        if (
          frame.envelope.message.type === "result" &&
          server?.requests.length === 1
        ) {
          firstResult?.();
        }
      }
    })();

    run.send({ message: "first turn", uuid: crypto.randomUUID() });
    await Promise.race([
      firstResultSeen,
      Bun.sleep(20_000).then(() => {
        throw new Error("First SDK turn did not finish");
      }),
    ]);
    run.send({ message: "second turn", uuid: crypto.randomUUID() });
    run.finishInput();
    await consume;

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.headers["x-api-key"]).toBe("placeholder-local");
    expect(JSON.stringify(server.requests[0]?.body.system)).toContain(
      "APPEND_SENTINEL_94S_18",
    );
    expect(server.requests.map((request) => request.body.model)).toEqual([
      "claude-sonnet-4-5",
      "claude-sonnet-4-5",
    ]);
    expect(
      frames.filter((frame) => frame.envelope.message.type === "result"),
    ).toHaveLength(2);
    const sessionIds = new Set(
      frames
        .map((frame) => frame.envelope.message.session_id)
        .filter((value): value is string => typeof value === "string"),
    );
    expect(sessionIds.size).toBe(1);
    expect(spawnedPids).toHaveLength(1);
    const sessionId = [...sessionIds][0];
    if (sessionId === undefined)
      throw new Error("SDK session ID was not emitted");
    const init = frames.find(
      (frame) =>
        frame.envelope.message.type === "system" &&
        frame.envelope.message.subtype === "init",
    );
    expect(init?.envelope.message.claude_code_version).toBe("2.1.270");
    expect(init?.envelope.sdk_version).toBe("0.3.270");
    expect(
      frames.every((frame) => frame.envelope.message.type.length > 0),
    ).toBe(true);

    const resumed = runtime.start(
      { ...runtimeConfig, correlationId: "actual-resume", resume: sessionId },
      async () => ({ behavior: "deny", message: "No tools expected" }),
    );
    resumed.send({
      message: "after process restart",
      uuid: crypto.randomUUID(),
    });
    resumed.finishInput();
    const resumedFrames = [];
    for await (const frame of resumed) resumedFrames.push(frame);
    expect(server.requests).toHaveLength(3);
    expect(
      resumedFrames.some(
        (frame) =>
          frame.envelope.message.type === "result" &&
          frame.envelope.message.session_id === sessionId,
      ),
    ).toBe(true);
    expect(spawnedPids).toHaveLength(2);
    expect(new Set(spawnedPids).size).toBe(2);
    await waitFor(() => exitedPids.length === 2, 5_000);
  }, 30_000);

  test("forwards permission request correlation through the adapter", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "94s-18-permission-")));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(join(workspace, ".claude"), { recursive: true });
    await mkdir(home, { recursive: true });
    server = startFakeAnthropicServer((index) =>
      index === 0
        ? {
            type: "tool",
            id: "toolu_permission",
            name: "Bash",
            input: {
              command: `printf denied > ${JSON.stringify(join(workspace, "permission-denied.txt"))}`,
            },
          }
        : { type: "text", text: "permission handled" },
    );
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });
    const permissionRequests: Array<{ requestId: string; toolUseId: string }> =
      [];
    const run = runtime.start(
      {
        claudeConfigDir: home,
        correlationId: "actual-permission",
        cwd: workspace,
        home,
        maxTurns: 2,
        model: "claude-sonnet-4-5",
        profile: {
          kind: "anthropic",
          endpoint: server.url,
          auth: { kind: "api_key", value: "placeholder-local" },
        },
        settingSources: ["project"],
        tools: ["Bash"],
      },
      async (request) => {
        permissionRequests.push({
          requestId: request.requestId,
          toolUseId: request.toolUseId,
        });
        return { behavior: "deny", message: "Permission denied by host" };
      },
    );
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();
    run.send({ message: "request a command", uuid: crypto.randomUUID() });
    run.finishInput();
    await withTimeout(consume, 5_000, "Permission adapter did not settle");

    expect(permissionRequests).toEqual([
      { requestId: expect.any(String), toolUseId: "toolu_permission" },
    ]);
    expect(
      frames.some((frame) => frame.envelope.message.type === "result"),
    ).toBe(true);
  }, 30_000);

  test("interrupts the current turn and returns a receipt", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "94s-18-interrupt-")));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(workspace, { recursive: true });
    await mkdir(home, { recursive: true });
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    server = startFakeAnthropicServer(async (index) => {
      requestStarted?.();
      if (index === 0) {
        await Bun.sleep(500);
        return { type: "text", text: "INTERRUPTED_RESPONSE_MUST_NOT_SURFACE" };
      }
      return { type: "text", text: "FOLLOW_UP_AFTER_INTERRUPT" };
    });
    const spawnedPids: number[] = [];
    const exitedPids: number[] = [];
    const runtime = new ClaudeSdkRuntime(
      { endpoints: [server.url], models: ["claude-sonnet-4-5"] },
      {
        onSpawn: (pid) => spawnedPids.push(pid),
        onExit: (pid) => exitedPids.push(pid),
      },
    );
    const run = runtime.start(
      {
        claudeConfigDir: home,
        correlationId: "actual-interrupt",
        cwd: workspace,
        home,
        model: "claude-sonnet-4-5",
        profile: {
          kind: "anthropic",
          endpoint: server.url,
          auth: { kind: "api_key", value: "placeholder-local" },
        },
        settingSources: [],
        tools: [],
      },
      async () => ({ behavior: "deny", message: "No tools expected" }),
    );
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();
    run.send({ message: "wait for the response", uuid: crypto.randomUUID() });
    await started;
    const receipt = await run.interrupt();
    run.send({ message: "follow up", uuid: crypto.randomUUID() });
    run.finishInput();
    await withTimeout(consume, 5_000, "Interrupted adapter did not settle");

    expect(receipt.stillQueued).toEqual([]);
    expect(spawnedPids).toHaveLength(1);
    const serialized = JSON.stringify(frames);
    expect(serialized).not.toContain("INTERRUPTED_RESPONSE_MUST_NOT_SURFACE");
    expect(serialized).toContain("FOLLOW_UP_AFTER_INTERRUPT");
    await waitFor(() => exitedPids.length === 1, 5_000);
  }, 30_000);

  test("aborts the whole adapter run and reaps its process", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "94s-18-abort-")));
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(workspace, { recursive: true });
    await mkdir(home, { recursive: true });
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    server = startFakeAnthropicServer(async (_index, request) => {
      requestStarted?.();
      await aborted(request.signal);
      return new Response("request aborted", { status: 499 });
    });
    const spawnedPids: number[] = [];
    const exitedPids: number[] = [];
    const runtime = new ClaudeSdkRuntime(
      { endpoints: [server.url], models: ["claude-sonnet-4-5"] },
      {
        onSpawn: (pid) => spawnedPids.push(pid),
        onExit: (pid) => exitedPids.push(pid),
      },
    );
    const run = runtime.start(
      {
        claudeConfigDir: home,
        correlationId: "actual-abort",
        cwd: workspace,
        home,
        model: "claude-sonnet-4-5",
        profile: {
          kind: "anthropic",
          endpoint: server.url,
          auth: { kind: "api_key", value: "placeholder-local" },
        },
        settingSources: [],
        tools: [],
      },
      async () => ({ behavior: "deny", message: "No tools expected" }),
    );
    const consume = (async () => {
      for await (const _frame of run) void _frame;
    })();
    run.send({ message: "wait for the response", uuid: crypto.randomUUID() });
    await started;
    run.abort();
    const outcome = await withTimeout(
      consume.then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      5_000,
      "Aborted adapter did not settle",
    );

    expect(outcome).toBe("rejected");
    expect(spawnedPids).toHaveLength(1);
    await waitFor(() => exitedPids.length === 1, 5_000);
  }, 30_000);
});

function startFakeAnthropicServer(
  reply: (
    index: number,
    request: Request,
  ) => FakeReply | Response | Promise<FakeReply | Response>,
): {
  requests: RecordedRequest[];
  stop(): void;
  url: string;
} {
  const requests: RecordedRequest[] = [];
  const bunServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/messages")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({
        body,
        headers: Object.fromEntries(request.headers.entries()),
      });
      const replyValue = await reply(requests.length - 1, request);
      if (replyValue instanceof Response) return replyValue;
      const model =
        typeof body.model === "string" ? body.model : "claude-sonnet-4-5";
      const id = `msg_${crypto.randomUUID()}`;
      const block =
        replyValue.type === "text"
          ? { type: "text", text: "" }
          : {
              type: "tool_use",
              id: replyValue.id,
              name: replyValue.name,
              input: {},
            };
      const delta =
        replyValue.type === "text"
          ? { type: "text_delta", text: replyValue.text }
          : {
              type: "input_json_delta",
              partial_json: JSON.stringify(replyValue.input),
            };
      const stopReason = replyValue.type === "text" ? "end_turn" : "tool_use";
      const events = [
        {
          type: "message_start",
          message: {
            id,
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: block,
        },
        {
          type: "content_block_delta",
          index: 0,
          delta,
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: 2 },
        },
        { type: "message_stop" },
      ];
      return new Response(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        {
          headers: {
            "content-type": "text/event-stream",
            "request-id": `req_${crypto.randomUUID()}`,
          },
        },
      );
    },
  });
  return {
    requests,
    stop: () => bunServer.stop(true),
    url: `http://127.0.0.1:${bunServer.port}`,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for process exit");
    }
    await Bun.sleep(10);
  }
}

async function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return Promise.race([
    operation,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(message);
    }),
  ]);
}
