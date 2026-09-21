import { describe, expect, test } from "bun:test";
import type { AgentFrame } from "@agent-platform/runtime-core";
import type { ClaudeRuntimeConfig } from "./config.ts";
import { FakeAgentRuntime } from "./fake-adapter.ts";

const config: ClaudeRuntimeConfig = {
  claudeConfigDir: "/tmp/fake/config",
  correlationId: "fake-correlation",
  mode: "new",
  cwd: "/tmp/fake/workspace",
  home: "/tmp/fake/home",
  model: "fake-model",
  profile: {
    kind: "anthropic",
    endpoint: "http://127.0.0.1:4000",
    auth: { kind: "api_key", value: "placeholder" },
  },
  tools: ["Read"],
};

describe("fake agent runtime", () => {
  test("prepares a checkpoint only once a session id is known and the turn has ended", async () => {
    const runtime = new FakeAgentRuntime([
      {
        type: "emit",
        message: { type: "system", subtype: "init", session_id: "ckpt" },
      },
      {
        type: "emit",
        message: { type: "result", subtype: "success", session_id: "ckpt" },
      },
    ]);
    const allow = {
      onPermission: async () => ({ behavior: "allow" as const }),
    };
    const run = runtime.start(config, allow);
    expect(await run.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "No SDK session has started",
    });
    const iterator = run.events()[Symbol.asyncIterator]();
    await iterator.next();
    expect(await run.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "A turn is still running",
    });
    await iterator.next();
    await iterator.next();
    expect(await run.prepareCheckpoint()).toEqual({
      status: "ready",
      checkpoint: { engine: "claude", resume: "ckpt", sdkVersion: "0.3.270" },
    });
    const resumed = runtime.start(
      { ...config, mode: "resume", resume: "ckpt" },
      allow,
    );
    expect(await resumed.prepareCheckpoint()).toEqual({
      status: "ready",
      checkpoint: { engine: "claude", resume: "ckpt", sdkVersion: "0.3.270" },
    });
    resumed.send({ message: "queued", uuid: "queued-1" });
    expect(await resumed.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "A turn is still running",
    });
  });

  test("rejects a checkpoint while a second queued input is still outstanding", async () => {
    const result = {
      type: "result",
      subtype: "success",
      session_id: "two",
    };
    const runtime = new FakeAgentRuntime([
      { type: "emit", message: result },
      { type: "emit", message: result },
    ]);
    const run = runtime.start(config, {
      onPermission: async () => ({ behavior: "allow" }),
    });
    run.send({ message: "one", uuid: "1" });
    run.send({ message: "two", uuid: "2" });
    const iterator = run.events()[Symbol.asyncIterator]();
    await iterator.next();
    expect(await run.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "A turn is still running",
    });
    await iterator.next();
    expect((await run.prepareCheckpoint()).status).toBe("ready");
  });

  test("refuses a second event consumer", async () => {
    const run = new FakeAgentRuntime([]).start(config, {
      onPermission: async () => ({ behavior: "allow" }),
    });
    await run.events()[Symbol.asyncIterator]().next();
    await expect(
      (async () => {
        for await (const _frame of run) void _frame;
      })(),
    ).rejects.toThrow("AgentRun events can only be consumed once");
  });

  test("controls init, arbitrary order, usage, and result errors", async () => {
    const runtime = new FakeAgentRuntime([
      {
        type: "emit",
        message: { type: "system", subtype: "init", session_id: "fake" },
      },
      {
        type: "emit",
        message: { type: "tool_use_summary", summary: "later first" },
      },
      {
        type: "emit",
        message: {
          type: "result",
          subtype: "error_max_turns",
          session_id: "fake",
          is_error: true,
          usage: { input_tokens: 2 },
        },
      },
    ]);
    const run = runtime.start(config, {
      onPermission: async () => ({
        behavior: "deny",
        message: "unused",
      }),
    });
    run.send({ message: "start", uuid: "input-1" });
    run.finishInput();
    const frames = [];
    for await (const frame of run) frames.push(frame);
    expect(runtime.inputs).toEqual([{ message: "start", uuid: "input-1" }]);
    expect(frames.map((frame) => frame.envelope.message.type)).toEqual([
      "system",
      "tool_use_summary",
      "result",
    ]);
    expect(frames[2]?.events[0]?.event).toBe("result");
  });

  test("runs permission callbacks in parallel", async () => {
    const runtime = new FakeAgentRuntime([
      {
        type: "permissions",
        requests: ["one", "two"].map((id) => ({
          input: { id },
          requestId: `request-${id}`,
          tool: "Read",
          toolUseId: `tool-${id}`,
        })),
      },
    ]);
    let active = 0;
    let maxActive = 0;
    const run = runtime.start(config, {
      onPermission: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(10);
        active -= 1;
        return { behavior: "allow" };
      },
    });
    for await (const _frame of run) {
      throw new Error("Permission-only fake should not emit frames");
    }
    expect(maxActive).toBe(2);
    expect(runtime.permissionDecisions).toHaveLength(2);
  });

  test("distinguishes interrupt, abort, and injected exceptions", async () => {
    const interruptRuntime = new FakeAgentRuntime([
      { type: "delay", delayMs: 1 },
      {
        type: "emit",
        message: { type: "assistant", message: { content: [] } },
      },
    ]);
    const interrupted = interruptRuntime.start(config, {
      onPermission: async () => ({
        behavior: "allow",
      }),
    });
    await interrupted.interrupt();
    const interruptedFrames = [];
    for await (const frame of interrupted) interruptedFrames.push(frame);
    expect(interruptedFrames[0]?.envelope.message.terminal_reason).toBe(
      "interrupted",
    );

    const aborted = interruptRuntime.start(config, {
      onPermission: async () => ({
        behavior: "allow",
      }),
    });
    aborted.abort();
    await expect(async () => {
      for await (const _frame of aborted) void _frame;
    }).toThrow("Run aborted");

    const failure = new FakeAgentRuntime([
      { type: "error", error: new Error("injected fake failure") },
    ]).start(config, { onPermission: async () => ({ behavior: "allow" }) });
    await expect(async () => {
      for await (const _frame of failure) void _frame;
    }).toThrow("injected fake failure");
  });

  test("aborts delay and pending permission waits immediately", async () => {
    const delayed = new FakeAgentRuntime([
      { type: "delay", delayMs: 10_000 },
    ]).start(config, { onPermission: async () => ({ behavior: "allow" }) });
    const delayedConsume = (async () => {
      for await (const _frame of delayed) void _frame;
    })();
    await Bun.sleep(5);
    delayed.abort();
    await expect(delayedConsume).rejects.toMatchObject({ name: "AbortError" });

    let permissionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      permissionStarted = resolve;
    });
    const pending = new FakeAgentRuntime([
      {
        type: "permissions",
        requests: [
          {
            input: {},
            requestId: "pending-request",
            tool: "Read",
            toolUseId: "pending-tool",
          },
        ],
      },
    ]).start(config, {
      onPermission: async ({ signal }) => {
        permissionStarted?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { behavior: "deny", message: "aborted" };
      },
    });
    const pendingConsume = (async () => {
      for await (const _frame of pending) void _frame;
    })();
    await started;
    pending.abort();
    await expect(pendingConsume).rejects.toMatchObject({ name: "AbortError" });
  });

  test("interrupts delay and pending permission waits immediately", async () => {
    const delayed = new FakeAgentRuntime([
      { type: "delay", delayMs: 10_000 },
    ]).start(config, { onPermission: async () => ({ behavior: "allow" }) });
    const delayedFrames: AgentFrame[] = [];
    const delayedConsume = (async () => {
      for await (const frame of delayed) delayedFrames.push(frame);
    })();
    await Bun.sleep(5);
    await delayed.interrupt();
    await within(delayedConsume, 100);
    expect(delayedFrames[0]?.envelope.message.terminal_reason).toBe(
      "interrupted",
    );

    let permissionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      permissionStarted = resolve;
    });
    const pending = new FakeAgentRuntime([
      {
        type: "permissions",
        requests: [
          {
            input: {},
            requestId: "pending-request",
            tool: "Read",
            toolUseId: "pending-tool",
          },
        ],
      },
    ]).start(config, {
      onPermission: async ({ signal }) => {
        permissionStarted?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { behavior: "deny", message: "interrupted" };
      },
    });
    const pendingFrames: AgentFrame[] = [];
    const pendingConsume = (async () => {
      for await (const frame of pending) pendingFrames.push(frame);
    })();
    await started;
    await pending.interrupt();
    await within(pendingConsume, 100);
    expect(pendingFrames[0]?.envelope.message.terminal_reason).toBe(
      "interrupted",
    );
  });
});

async function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    operation,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error("Operation did not settle within the expected time");
    }),
  ]);
}
