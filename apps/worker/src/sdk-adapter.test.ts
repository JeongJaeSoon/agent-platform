import { describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "./runtime.ts";
import {
  buildSdkOptions,
  ClaudeSdkRuntime,
  resolvePinnedClaudeExecutable,
} from "./sdk-adapter.ts";

const config: RuntimeConfig = {
  appendSystemPrompt: "platform rules",
  claudeConfigDir: "/tenant/config",
  correlationId: "sdk-options",
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

describe("Claude SDK adapter options", () => {
  test("uses explicit Claude Code defaults without auto-allowing tools", () => {
    const options = buildSdkOptions(config, async () => ({
      behavior: "allow",
    }));
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
    const options = buildSdkOptions(config, async () => {
      callbackCount += 1;
      return { behavior: "allow" };
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
        async () => ({ behavior: "allow" }),
      ),
    ).toThrow("Unsupported permission mode");
  });

  test("ignores an untrusted executable override", () => {
    const untrusted = {
      ...config,
      pathToClaudeCodeExecutable: "/tmp/not-the-pinned-cli",
    } as RuntimeConfig;
    const options = buildSdkOptions(untrusted, async () => ({
      behavior: "allow",
    }));
    expect(options.pathToClaudeCodeExecutable).toBe(
      resolvePinnedClaudeExecutable(),
    );
    expect(options.pathToClaudeCodeExecutable).not.toBe(
      "/tmp/not-the-pinned-cli",
    );
  });
});
