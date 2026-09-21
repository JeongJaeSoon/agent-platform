import { describe, expect, test } from "bun:test";
import type { ClaudeRuntimeConfig } from "./config.ts";
import { ClaudeSdkRun, InputStream } from "./run.ts";
import {
  buildSdkOptions,
  ClaudeSdkRuntime,
  resolvePinnedClaudeExecutable,
} from "./runtime.ts";

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
  },
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
      "resume-1",
    );
    run.finishInput();
    expect(() => run.send({ message: "late", uuid: "late" })).toThrow(
      "Input stream is closed",
    );
    expect((await run.prepareCheckpoint()).status).toBe("ready");
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

  test("rejects bypass permission mode before starting a query", () => {
    const runtime = new ClaudeSdkRuntime({
      endpoints: ["https://api.anthropic.com"],
      models: ["primary"],
    });
    expect(() =>
      runtime.start(
        { ...config, permissionMode: "bypassPermissions" as never },
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
});
