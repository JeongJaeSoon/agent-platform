import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import {
  createProbeContext,
  type FakeAnthropicServer,
  type ProbeContext,
  runSdkQuery,
  startFakeAnthropicServer,
  textReply,
} from "./harness.ts";

const LITELLM_VERSION = "1.100.1";
/** Generous: a loaded runner tearing down a large Python process is not news. */
const PROXY_REAP_MS = 15_000;
const PROXY_AUTHORIZATION = "Bearer proxy-contract-placeholder";

describe("actual LiteLLM Anthropic transport", () => {
  let context: ProbeContext;
  let upstream: FakeAnthropicServer;
  let proxy: ChildProcessWithoutNullStreams;
  let proxyUrl: string;
  let proxyExited: Promise<void> | undefined;
  let proxyLogs = "";
  let upstreamCancellationObserved = false;
  let upstreamTimeoutObserved = false;

  beforeAll(async () => {
    context = await createProbeContext();
    upstream = startFakeAnthropicServer(async (request) => {
      const model = request.body.model ?? "";
      if (model.includes("error")) {
        return Response.json(
          {
            type: "error",
            error: { type: "rate_limit_error", message: "contract error" },
          },
          { status: 429 },
        );
      }
      if (model.includes("timeout")) {
        request.signal?.addEventListener(
          "abort",
          () => {
            upstreamTimeoutObserved = true;
          },
          { once: true },
        );
        await Bun.sleep(1_500);
        return textReply("late response");
      }
      if (model.includes("cancel")) {
        return cancellationResponse(request.signal, () => {
          upstreamCancellationObserved = true;
        });
      }
      return textReply(`proxied ${model}`);
    });

    const configPath = `${context.root}/litellm.yaml`;
    await writeFile(configPath, liteLlmConfig(upstream.url), {
      encoding: "utf8",
      mode: 0o600,
    });

    const command = liteLlmCommand();
    const version = Bun.spawnSync([...command, "--version"], {
      env: liteLlmEnvironment(),
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(version.exitCode).toBe(0);
    expect(
      `${version.stdout.toString()}${version.stderr.toString()}`,
    ).toContain(LITELLM_VERSION);

    const [executable, ...arguments_] = command;
    if (!executable) throw new Error("LiteLLM command is empty");
    proxy = spawn(
      executable,
      [
        ...arguments_,
        "--config",
        configPath,
        "--host",
        "127.0.0.1",
        "--port",
        "0",
      ],
      { env: liteLlmEnvironment(), stdio: "pipe" },
    );
    // Registered now, not during teardown: `exit` fires once, and a teardown
    // that subscribes afterwards waits for an event that has already gone by.
    // Polling `exitCode` is no better — a signalled process leaves it null.
    proxyExited = new Promise((resolve) => {
      proxy.once("exit", () => resolve());
    });
    proxy.stdout.on("data", (chunk) => {
      proxyLogs += chunk.toString();
    });
    proxy.stderr.on("data", (chunk) => {
      proxyLogs += chunk.toString();
    });
    const port = await waitForProxyPort(
      () => proxy.exitCode,
      () => proxyLogs,
    );
    proxyUrl = `http://127.0.0.1:${port}`;
    await waitForProxy(
      proxyUrl,
      () => proxy.exitCode,
      () => proxyLogs,
    );
  }, 120_000);

  afterAll(async () => {
    upstream?.stop();
    if (proxyExited) {
      proxy.kill("SIGKILL");
      const reaped = await Promise.race([
        proxyExited.then(() => true),
        Bun.sleep(PROXY_REAP_MS).then(() => false),
      ]);
      // A SIGKILLed process that is still not reaped is worth seeing, but it
      // is teardown, not the transport contract: say so without failing the
      // suite over it.
      if (!reaped) {
        console.error(
          `LiteLLM proxy ${proxy.pid} was not reaped within ${PROXY_REAP_MS}ms`,
        );
      }
    }
    proxy?.stdin.destroy();
    proxy?.stdout.destroy();
    proxy?.stderr.destroy();
    proxy?.unref();
    await context?.dispose();
  }, 30_000);

  test("routes the actual SDK stream and preserves Anthropic transport metadata", async () => {
    const messages = await runSdkQuery(
      context,
      proxyUrl,
      "Return the transport contract result.",
      { model: "primary-alias" },
    );

    expect(messages.some((message) => message.type === "result")).toBe(true);
    const sdkRequest = upstream.requests.find((request) =>
      request.body.model?.includes("primary-upstream"),
    );
    expect(sdkRequest?.path).toBe("/v1/messages");
    expect(sdkRequest?.body.stream).toBe(true);
    expect(sdkRequest?.body.tools?.length).toBeGreaterThan(0);
    expect(JSON.stringify(sdkRequest?.body)).toContain("cache_control");
    expect(sdkRequest?.headers["anthropic-version"]).toBeTruthy();
    expect(sdkRequest?.headers["anthropic-beta"]).toBeTruthy();
    expect(proxy.pid).toBeGreaterThan(0);
  }, 60_000);

  test("routes primary, helper, and subagent model aliases", async () => {
    for (const alias of ["primary-alias", "helper-alias", "subagent-alias"]) {
      const response = await requestProxy(proxyUrl, alias);
      expect(response.ok).toBe(true);
    }

    const routedModels = upstream.requests
      .map((request) => request.body.model)
      .filter((model): model is string => model !== undefined);
    expect(routedModels).toContain("claude-primary-upstream");
    expect(routedModels).toContain("claude-helper-upstream");
    expect(routedModels).toContain("claude-subagent-upstream");
  }, 30_000);

  test("forwards upstream errors and enforces the configured timeout", async () => {
    const errorResponse = await requestProxy(proxyUrl, "error-alias");
    expect(errorResponse.status).toBe(429);
    expect(await errorResponse.text()).toContain("rate_limit_error");

    const startedAt = performance.now();
    const timeoutResponse = await requestProxy(proxyUrl, "timeout-alias");
    expect(timeoutResponse.ok).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(1_400);
    await waitFor(() => upstreamTimeoutObserved, 5_000);
    expect(upstreamTimeoutObserved).toBe(true);
  }, 30_000);

  test("propagates client cancellation to the Anthropic upstream", async () => {
    const controller = new AbortController();
    const response = await requestProxy(
      proxyUrl,
      "cancel-alias",
      controller.signal,
      true,
    );
    expect(response.ok).toBe(true);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("LiteLLM cancellation stream has no body");
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    await waitFor(() => upstreamCancellationObserved, 5_000);
    expect(upstreamCancellationObserved).toBe(true);
  }, 30_000);
});

function liteLlmCommand(): string[] {
  if (process.env.LITELLM_BIN) return [process.env.LITELLM_BIN];
  const installed = Bun.which("litellm");
  if (installed) return [installed];
  return [
    Bun.which("uv") ?? "uv",
    "tool",
    "run",
    "--from",
    `litellm[proxy]==${LITELLM_VERSION}`,
    "litellm",
  ];
}

function liteLlmEnvironment(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    NO_PROXY: "127.0.0.1,localhost",
    PATH: process.env.PATH,
    TMPDIR: "/tmp",
    UV_CACHE_DIR: "/tmp/agent-platform-uv-cache",
    UV_TOOL_DIR: "/tmp/agent-platform-uv-tools",
  };
}

function liteLlmConfig(upstreamUrl: string): string {
  const aliases = [
    ["primary-alias", "claude-primary-upstream"],
    ["helper-alias", "claude-helper-upstream"],
    ["subagent-alias", "claude-subagent-upstream"],
    ["error-alias", "claude-error-upstream"],
    ["timeout-alias", "claude-timeout-upstream"],
    ["cancel-alias", "claude-cancel-upstream"],
  ];
  return `model_list:\n${aliases
    .map(
      ([alias, model]) =>
        `  - model_name: ${alias}\n    litellm_params:\n      model: anthropic/${model}\n      api_base: ${upstreamUrl}\n      api_key: upstream-placeholder\n      request_timeout: 0.5\n      timeout: 0.5`,
    )
    .join(
      "\n",
    )}\nlitellm_settings:\n  num_retries: 0\n  request_timeout: 0.5\n`;
}

async function requestProxy(
  proxyBaseUrl: string,
  model: string,
  signal?: AbortSignal,
  stream = false,
): Promise<Response> {
  return fetch(`${proxyBaseUrl}/v1/messages`, {
    body: JSON.stringify({
      max_tokens: 64,
      messages: [{ role: "user", content: "transport contract" }],
      model,
      stream,
    }),
    headers: {
      "anthropic-version": "2023-06-01",
      authorization: PROXY_AUTHORIZATION,
      "content-type": "application/json",
      "x-api-key": "proxy-contract-placeholder",
    },
    method: "POST",
    ...(signal ? { signal } : {}),
  });
}

function cancellationResponse(
  signal: AbortSignal | undefined,
  onCancel: () => void,
): Response {
  const encoder = new TextEncoder();
  let interval: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      onCancel();
      if (interval) clearInterval(interval);
    },
    start(controller) {
      const close = () => {
        onCancel();
        if (interval) clearInterval(interval);
        controller.close();
      };
      signal?.addEventListener("abort", close, { once: true });
      controller.enqueue(
        encoder.encode(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: "msg_cancel_contract",
              type: "message",
              role: "assistant",
              model: "claude-cancel-upstream",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          })}\n\n`,
        ),
      );
      interval = setInterval(() => {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 100);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function waitForProxy(
  baseUrl: string,
  exitCode: () => number | null,
  logs: () => string,
): Promise<void> {
  try {
    await waitFor(async () => {
      if (exitCode() !== null) throw new Error(`LiteLLM exited: ${logs()}`);
      try {
        return (await fetch(`${baseUrl}/health/liveliness`)).ok;
      } catch {
        return false;
      }
    }, 60_000);
  } catch (error) {
    throw new Error(`LiteLLM did not become ready: ${logs()}`, {
      cause: error,
    });
  }
}

async function waitForProxyPort(
  exitCode: () => number | null,
  logs: () => string,
): Promise<number> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exitCode() !== null) throw new Error(`LiteLLM exited: ${logs()}`);
    const match = logs().match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match?.[1]) return Number(match[1]);
    await Bun.sleep(50);
  }
  throw new Error(`LiteLLM did not report its bound port: ${logs()}`);
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Condition was not met within ${timeoutMs} ms`);
}
