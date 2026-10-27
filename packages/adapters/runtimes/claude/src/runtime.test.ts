import { describe, expect, test } from "bun:test";
import { closeSync, fstatSync, openSync } from "node:fs";
import type { ClaudeRuntimeConfig } from "./config.ts";
import { MirrorProgress } from "./mirror-progress.ts";
import { ResumedHistory } from "./resumed-history.ts";
import { APPROVAL_BARRIER_MS, ClaudeSdkRun, InputStream } from "./run.ts";
import {
  buildSdkOptions,
  ClaudeSdkRuntime,
  resolvePinnedClaudeExecutable,
} from "./runtime.ts";
import { TurnLedger } from "./turn-ledger.ts";

const config: ClaudeRuntimeConfig = {
  appendSystemPrompt: "platform rules",
  claudeConfigDir: "/tenant/config",
  correlationId: "sdk-options",
  mode: "new",
  cwd: "/tenant/workspace",
  home: "/tenant/home",
  model: "primary",
  profile: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.com",
    auth: { kind: "api_key", value: "placeholder" },
    principal: { ownerScope: "owner-a" },
  },
  identities: { plugins: { "/tenant/plugin": "tenant-plugin@1" } },
  plugins: [{ type: "local", path: "/tenant/plugin" }],
  settingSources: ["project"],
  tools: ["Read"],
};

describe("Claude SDK run", () => {
  test("a send rejected by a closed input stream leaves the checkpoint state untouched", async () => {
    const run = new ClaudeSdkRun(
      "closed",
      new InputStream(),
      { interrupt: async () => undefined, close: () => undefined } as never,
      new AbortController(),
      ResumedHistory.empty(),
      new TurnLedger("resume-1"),
    );
    run.finishInput();
    expect(() => run.send({ message: "late", uuid: "late" })).toThrow(
      "Input stream is closed",
    );
    expect((await run.prepareCheckpoint()).status).toBe("ready");
    // It never reached the engine, so sending it again is not a duplicate.
    expect(await run.holdsInput("late")).toBe(false);
  });

  test("holds an input once it was sent, whether or not a result settled it", async () => {
    const run = new ClaudeSdkRun(
      "sent",
      new InputStream(),
      { interrupt: async () => undefined, close: () => undefined } as never,
      new AbortController(),
      ResumedHistory.empty(),
      new TurnLedger(),
    );
    expect(await run.holdsInput("first")).toBe(false);
    run.send({ message: "first", uuid: "first" });
    expect(await run.holdsInput("first")).toBe(true);
    expect(await run.holdsInput("second")).toBe(false);
  });

  test("labels the init's tools with the relays' descriptions, read on init only", async () => {
    let asked = 0;
    const sdkQuery = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "system",
          subtype: "init",
          tools: ["Read", "mcp__docs__find"],
        };
        yield { type: "system", subtype: "status" };
      },
    };
    const run = new ClaudeSdkRun(
      "init",
      new InputStream(),
      sdkQuery as never,
      new AbortController(),
      ResumedHistory.empty(),
      new TurnLedger(),
      () => {
        asked += 1;
        return new Map([["mcp__docs__find", "Finds a page"]]);
      },
    );
    const data = [];
    for await (const frame of run.events()) {
      data.push(...frame.events.map((item) => item.data));
    }
    expect(asked).toBe(1);
    expect(data).toEqual([
      {
        type: "system",
        subtype: "init",
        tools: [
          { name: "Read" },
          { name: "mcp__docs__find", description: "Finds a page" },
        ],
      },
      { type: "system", subtype: "status" },
    ]);
  });
});

describe("Claude SDK run approval-wait checkpoint", () => {
  const key = { projectKey: "p", sessionId: "s1" };
  function mirrored() {
    const progress = new MirrorProgress();
    const store = progress.watch({
      append: async () => {},
      listSubkeys: async () => [],
      load: async () => null,
    });
    const ledger = new TurnLedger("s1");
    const run = new ClaudeSdkRun(
      "approval",
      new InputStream(),
      { interrupt: async () => undefined, close: () => undefined } as never,
      new AbortController(),
      ResumedHistory.empty(),
      ledger,
      () => new Map(),
      progress,
    );
    const write = (...blocks: Record<string, unknown>[]) =>
      store.append(key, [
        { type: "assistant", message: { content: blocks } },
      ] as never);
    return { ledger, run, write };
  }

  test("leases only once the mirror holds the waiting call and the results before it", async () => {
    const { ledger, run, write } = mirrored();
    expect(run.approvalCheckpoints).toBe(true);
    ledger.toolStarting("toolu_done");
    ledger.toolSettled("toolu_done");
    ledger.toolStarting("toolu_ask");
    ledger.permissionStarting("toolu_ask");
    expect(await run.prepareCheckpoint("approval_wait")).toMatchObject({
      reason: "turn_in_flight",
    });

    const leasing = run.leaseCheckpoint("approval_wait");
    let leased = false;
    void leasing.then(() => {
      leased = true;
    });
    await write({ type: "tool_use", id: "toolu_ask" });
    await Bun.sleep(40);
    expect(leased).toBe(false);
    await write({ type: "tool_result", tool_use_id: "toolu_done" });
    const grant = await leasing;
    expect(grant.preparation.status).toBe("ready");
    expect(ledger.toolStarting("toolu_next").allowed).toBe(false);
    grant.lease?.release();
  });

  test("gives up when the mirror never catches up", async () => {
    const { ledger, run } = mirrored();
    ledger.toolStarting("toolu_ask");
    ledger.permissionStarting("toolu_ask");
    const startedAt = performance.now();
    const grant = await run.leaseCheckpoint("approval_wait");
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(
      APPROVAL_BARRIER_MS - 50,
    );
    expect(grant).toMatchObject({
      lease: null,
      preparation: { reason: "turn_in_flight" },
    });
    expect(ledger.toolStarting("toolu_next").allowed).toBe(true);
  });

  test("a run without a mirror takes none", async () => {
    const run = new ClaudeSdkRun(
      "plain",
      new InputStream(),
      { interrupt: async () => undefined, close: () => undefined } as never,
      new AbortController(),
      ResumedHistory.empty(),
      new TurnLedger("s1"),
    );
    expect(run.approvalCheckpoints).toBe(false);
    expect((await run.leaseCheckpoint("approval_wait")).lease).toBeNull();
  });
});

describe("Claude SDK input flush", () => {
  const settledNow = async (promise: Promise<void>) => {
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    await Bun.sleep(0);
    return settled;
  };

  test("flushes only once the SDK asks past every pushed message", async () => {
    const input = new InputStream();
    const reader = input[Symbol.asyncIterator]();
    expect(await settledNow(input.flushed())).toBe(true);

    input.push({ message: "queued", uuid: "a" });
    const queued = input.flushed();
    expect(await settledNow(queued)).toBe(false);
    await reader.next();
    // Handed to the SDK, whose write comes before it asks again.
    expect(await settledNow(queued)).toBe(false);
    const waiting = reader.next();
    expect(await settledNow(queued)).toBe(true);

    input.push({ message: "straight to a waiting reader", uuid: "b" });
    expect((await waiting).value?.uuid).toBe("b");
    const handed = input.flushed();
    expect(await settledNow(handed)).toBe(false);
    void reader.next();
    expect(await settledNow(handed)).toBe(true);
  });

  test("finishing the input still waits for what it queued", async () => {
    const input = new InputStream();
    const reader = input[Symbol.asyncIterator]();
    input.push({ message: "last", uuid: "a" });
    input.finish();
    const pending = input.flushed();
    expect(await settledNow(pending)).toBe(false);
    expect((await reader.next()).value?.uuid).toBe("a");
    expect((await reader.next()).done).toBe(true);
    expect(await settledNow(pending)).toBe(true);
  });

  test("an SDK that stops reading releases the wait", async () => {
    const input = new InputStream();
    input.push({ message: "never read", uuid: "a" });
    const pending = input.flushed();
    expect(await settledNow(pending)).toBe(false);
    input.abandon();
    expect(await settledNow(pending)).toBe(true);
    expect(await settledNow(input.flushed())).toBe(true);
  });
});

describe("Claude SDK run readiness", () => {
  test("ready waits for the resumed transcript and the engine's initialization, and rejects when the transcript is unreadable", async () => {
    let initialized: () => void = () => {};
    const initialization = new Promise<void>((resolve) => {
      initialized = resolve;
    });
    const history = ResumedHistory.fromLocalDisk(
      "/nonexistent/config",
      "/nonexistent/workspace",
      "missing-session",
    );
    const broken = new ClaudeSdkRun(
      "unreadable",
      new InputStream(),
      { initializationResult: () => initialization } as never,
      new AbortController(),
      history,
      new TurnLedger("missing-session"),
    );
    await expect(broken.ready()).rejects.toThrow("could not be read");

    const fresh = new ClaudeSdkRun(
      "fresh",
      new InputStream(),
      { initializationResult: () => initialization } as never,
      new AbortController(),
      ResumedHistory.empty(),
      new TurnLedger(),
    );
    let ready = false;
    const waiting = fresh.ready().then(() => {
      ready = true;
    });
    await Bun.sleep(5);
    expect(ready).toBe(false);
    initialized();
    await waiting;
    expect(ready).toBe(true);
  });
});

describe("Claude SDK adapter options", () => {
  test("uses explicit Claude Code defaults without auto-allowing tools", () => {
    const options = buildSdkOptions(config, {
      onPermission: async () => ({
        behavior: "allow",
      }),
    });
    expect(options.permissionMode).toBe("default");
    expect(options.allowedTools).toBeUndefined();
    expect(options.tools).toEqual(["Read"]);
    expect(options.settingSources).toEqual(["project"]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "platform rules",
      snapshot: true,
    });
    expect(options.plugins).toEqual([
      { type: "local", path: "/tenant/plugin" },
    ]);
    expect(options.pathToClaudeCodeExecutable).toBe(
      resolvePinnedClaudeExecutable(),
    );
  });

  test("passes a spending budget only when the caller sets one", () => {
    const allow = {
      onPermission: async () => ({ behavior: "allow" as const }),
    };
    expect(buildSdkOptions(config, allow)).not.toHaveProperty("maxBudgetUsd");
    expect(
      buildSdkOptions({ ...config, maxBudgetUsd: 2.5 }, allow).maxBudgetUsd,
    ).toBe(2.5);
    // The engine exits on 0; nothing left is the smallest budget it takes.
    expect(
      buildSdkOptions({ ...config, maxBudgetUsd: 0 }, allow).maxBudgetUsd,
    ).toBe(0.000001);
  });

  test("denies tools outside the server allowlist before the host callback", async () => {
    let callbackCount = 0;
    const options = buildSdkOptions(config, {
      onPermission: async () => {
        callbackCount += 1;
        return { behavior: "allow" };
      },
    });
    const canUseTool = options.canUseTool;
    if (canUseTool === undefined) throw new Error("canUseTool is required");
    const context = {
      requestId: "request-1",
      signal: new AbortController().signal,
      toolUseID: "tool-1",
    } as Parameters<typeof canUseTool>[2];
    expect(await canUseTool("Bash", { command: "pwd" }, context)).toEqual({
      behavior: "deny",
      message: "Tool is outside the server allowlist",
      toolUseID: "tool-1",
    });
    expect(callbackCount).toBe(0);
    expect(
      await canUseTool("Read", { file_path: "README.md" }, context),
    ).toEqual({
      behavior: "allow",
      toolUseID: "tool-1",
    });
    expect(callbackCount).toBe(1);
  });

  test("the PreToolUse gate admits tools into the ledger and refuses them under a checkpoint lease", async () => {
    const ledger = new TurnLedger("s1");
    const options = buildSdkOptions(
      config,
      { onPermission: async () => ({ behavior: "allow" }) },
      ledger,
    );
    const hook = (event: "PostToolUse" | "PreToolUse") => {
      const callback = options.hooks?.[event]?.[0]?.hooks[0];
      if (callback === undefined) throw new Error(`${event} hook is required`);
      return (toolUseId: string) =>
        callback(
          {
            hook_event_name: event,
            tool_name: "Bash",
            tool_input: {},
            tool_use_id: toolUseId,
          } as never,
          toolUseId,
          { signal: new AbortController().signal },
        );
    };
    const pre = hook("PreToolUse");
    const post = hook("PostToolUse");

    // An allow answers nothing: "allow" would skip the permission check.
    expect(await pre("toolu_1")).toEqual({});
    expect(ledger.prepareCheckpoint()).toMatchObject({
      reason: "tool_in_flight",
    });
    await post("toolu_1");
    const grant = ledger.leaseCheckpoint();
    expect(grant.preparation.status).toBe("ready");
    expect(await pre("toolu_2")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "A checkpoint is being saved; no tool may start until it is committed",
      },
    });
    grant.lease?.release();
    expect(ledger.prepareCheckpoint().status).toBe("ready");
  });

  test("the PreToolUse gate admits a call only past the admission guard the host holds", async () => {
    const ledger = new TurnLedger("s1");
    const options = buildSdkOptions(
      config,
      { onPermission: async () => ({ behavior: "allow" }) },
      ledger,
    );
    const callback = options.hooks?.PreToolUse?.[0]?.hooks[0];
    if (callback === undefined) throw new Error("PreToolUse hook is required");
    const pre = (toolUseId: string) =>
      callback(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: {},
          tool_use_id: toolUseId,
        } as never,
        toolUseId,
        { signal: new AbortController().signal },
      );

    const guarded: string[] = [];
    let open: () => void = () => {};
    const first = ledger.holdAdmission(async (id) => {
      guarded.push(`first:${id}`);
      await new Promise<void>((resolve) => {
        open = resolve;
      });
    });
    const admitting = pre("toolu_1");
    await Bun.sleep(5);
    // Not admitted while the guard is out, and a guard that lands meanwhile
    // is awaited as well.
    expect(ledger.prepareCheckpoint().status).toBe("ready");
    first.release();
    ledger.holdAdmission(async (id) => {
      guarded.push(`second:${id}`);
    });
    open();
    expect(await admitting).toEqual({});
    expect(guarded).toEqual(["first:toolu_1", "second:toolu_1"]);
    expect(ledger.prepareCheckpoint()).toMatchObject({
      reason: "tool_in_flight",
    });

    ledger.holdAdmission(async () => {
      throw new Error("gateway down");
    });
    expect(await pre("toolu_2")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "The platform could not record that this tool is starting, so it was not run. This is not a user decision; you may try the call again.",
      },
    });
  });

  test("a tool the permission callback denies is settled, since no PostToolUse follows", async () => {
    const ledger = new TurnLedger("s1");
    const options = buildSdkOptions(
      { ...config, tools: ["Read", "Bash"] },
      {
        onPermission: async (request) =>
          request.tool === "Bash"
            ? { behavior: "deny", message: "no" }
            : { behavior: "allow" },
      },
      ledger,
    );
    const canUseTool = options.canUseTool;
    if (canUseTool === undefined) throw new Error("canUseTool is required");
    const context = (toolUseID: string) =>
      ({
        requestId: `request-${toolUseID}`,
        signal: new AbortController().signal,
        toolUseID,
      }) as Parameters<typeof canUseTool>[2];

    for (const id of ["outside", "denied", "allowed"]) ledger.toolStarting(id);
    await canUseTool("Write", {}, context("outside"));
    await canUseTool("Bash", {}, context("denied"));
    await canUseTool("Read", {}, context("allowed"));
    // Only the allowed one runs, and only its PostToolUse can settle it.
    expect(ledger.prepareCheckpoint()).toMatchObject({
      reason: "tool_in_flight",
      detail: "1 tool call(s) still running",
    });
  });

  test("bypassPermissions opts into the SDK's skip and keeps the tool allowlist in the PreToolUse hook", async () => {
    const ledger = new TurnLedger("s1");
    const options = buildSdkOptions(
      { ...config, permissionMode: "bypassPermissions" },
      { onPermission: async () => ({ behavior: "allow" }) },
      ledger,
    );
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    const pre = options.hooks?.PreToolUse?.[0]?.hooks[0];
    if (pre === undefined) throw new Error("PreToolUse hook is required");
    const call = (tool: string, toolUseId: string) =>
      pre(
        {
          hook_event_name: "PreToolUse",
          tool_name: tool,
          tool_input: {},
          tool_use_id: toolUseId,
        } as never,
        toolUseId,
        { signal: new AbortController().signal },
      );

    expect(await call("Bash", "toolu_1")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Tool is outside the server allowlist",
      },
    });
    // Refused before the ledger admitted it, so nothing is left in flight.
    expect(ledger.prepareCheckpoint().status).toBe("ready");
    expect(await call("Read", "toolu_2")).toEqual({});
  });

  test("auto keeps the allowlist in the hook without the SDK's skip", async () => {
    const options = buildSdkOptions(
      { ...config, permissionMode: "auto" },
      { onPermission: async () => ({ behavior: "allow" }) },
    );
    expect(options.permissionMode).toBe("auto");
    expect(options).not.toHaveProperty("allowDangerouslySkipPermissions");
    const pre = options.hooks?.PreToolUse?.[0]?.hooks[0];
    if (pre === undefined) throw new Error("PreToolUse hook is required");
    expect(
      await pre(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: {},
          tool_use_id: "toolu_1",
        } as never,
        "toolu_1",
        { signal: new AbortController().signal },
      ),
    ).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  test("other modes leave the skip off", () => {
    const allow = {
      onPermission: async () => ({ behavior: "allow" as const }),
    };
    for (const permissionMode of [
      "default",
      "acceptEdits",
      "dontAsk",
      "plan",
    ] as const) {
      expect(
        buildSdkOptions({ ...config, permissionMode }, allow),
      ).not.toHaveProperty("allowDangerouslySkipPermissions");
    }
  });

  test("rejects an unknown permission mode before starting a query", () => {
    const runtime = new ClaudeSdkRuntime({
      endpoints: ["https://api.anthropic.com"],
      models: ["primary"],
    });
    expect(() =>
      runtime.start(
        { ...config, permissionMode: "yolo" as never },
        { onPermission: async () => ({ behavior: "allow" }) },
      ),
    ).toThrow("Unsupported permission mode");
  });

  test("ignores an untrusted executable override", () => {
    const untrusted = {
      ...config,
      pathToClaudeCodeExecutable: "/tmp/not-the-pinned-cli",
    } as ClaudeRuntimeConfig;
    const options = buildSdkOptions(untrusted, {
      onPermission: async () => ({
        behavior: "allow",
      }),
    });
    expect(options.pathToClaudeCodeExecutable).toBe(
      resolvePinnedClaudeExecutable(),
    );
    expect(options.pathToClaudeCodeExecutable).not.toBe(
      "/tmp/not-the-pinned-cli",
    );
  });

  test("the spawn writes the key down descriptor 3", async () => {
    const options = buildSdkOptions(config, {
      onPermission: async () => ({ behavior: "allow" }),
    });
    const spawned = options.spawnClaudeCodeProcess?.({
      command: "/bin/sh",
      args: ["-c", 'read -r key <&3; printf "%s" "$key"'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      signal: new AbortController().signal,
    });
    if (spawned === undefined) throw new Error("no spawn");
    let printed = "";
    for await (const chunk of spawned.stdout) {
      printed += Buffer.from(chunk).toString();
    }
    expect(printed).toBe("placeholder");
  }, 10_000);

  test("an engine that exits at once reports its exit to the listener the SDK adds after spawn", async () => {
    const options = buildSdkOptions(config, {
      onPermission: async () => ({ behavior: "allow" }),
    });
    for (let round = 0; round < 20; round++) {
      const spawned = options.spawnClaudeCodeProcess?.({
        command: "/bin/sh",
        args: ["-c", "exit 3"],
        env: { PATH: process.env.PATH },
        signal: new AbortController().signal,
      });
      if (spawned === undefined) throw new Error("no spawn");
      const exit = await new Promise((resolve) =>
        spawned.once("exit", (code, signal) => resolve({ code, signal })),
      );
      expect(exit).toEqual({ code: 3, signal: null });
    }
  }, 10_000);

  test("a spawned engine's key socket is closed once, never again on a reused descriptor", async () => {
    // node:child_process under Bun closed the extra stdio socket again when
    // it was collected; a later Bun.spawn then failed with EBADF on the
    // pipe that had taken the number.
    const options = buildSdkOptions(config, {
      onPermission: async () => ({ behavior: "allow" }),
    });
    for (let round = 0; round < 10; round++) {
      const spawned = options.spawnClaudeCodeProcess?.({
        command: "/bin/sh",
        args: ["-c", "read -r key <&3; exec 3<&-; sleep 0.05"],
        env: { PATH: process.env.PATH },
        signal: new AbortController().signal,
      });
      if (spawned === undefined) throw new Error("no spawn");
      await new Promise((resolve) => spawned.once("exit", resolve));
    }
    const held = Array.from({ length: 60 }, () => openSync("/dev/null", "r"));
    try {
      Bun.gc(true);
      await Bun.sleep(100);
      Bun.gc(true);
      await Bun.sleep(100);
      const closedUnderneath = held.filter((fd) => {
        try {
          fstatSync(fd);
          return false;
        } catch {
          return true;
        }
      });
      expect(closedUnderneath).toEqual([]);
    } finally {
      for (const fd of held) {
        try {
          closeSync(fd);
        } catch {}
      }
    }
  }, 20_000);
});
