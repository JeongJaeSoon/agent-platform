import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSdkMcpServer,
  type HookEvent,
  query,
  type SDKMessage,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  createProbeContext,
  type FakeAnthropicServer,
  type ProbeContext,
  runSdkQuery,
  sdkOptions,
  startFakeAnthropicServer,
  textReply,
  toolReply,
  toolsReply,
} from "./harness";

let context: ProbeContext | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await context?.dispose();
  context = undefined;
  server = undefined;
});

describe.serial("Agent SDK 0.3.270 and Claude Code 2.1.270", () => {
  test("loads project instructions and the Claude Code system preset", async () => {
    context = await createProbeContext();
    server = startFakeAnthropicServer(() => textReply("contract passed"));
    await writeFile(
      join(context.workspace, "CLAUDE.md"),
      "PROJECT_INSTRUCTION_SENTINEL_94S_91",
    );
    const rulesDirectory = join(context.workspace, ".claude", "rules");
    await mkdir(rulesDirectory, { recursive: true });
    await writeFile(
      join(rulesDirectory, "contract-rule.md"),
      "PROJECT_RULE_SENTINEL_94S_91",
    );

    const messages = await runSdkQuery(context, server.url, "Reply briefly.", {
      maxTurns: 1,
    });
    const request = JSON.stringify(server.requests[0]);

    expect(request).toContain("PROJECT_INSTRUCTION_SENTINEL_94S_91");
    expect(request).toContain("PROJECT_RULE_SENTINEL_94S_91");
    expect(request).toContain("APPEND_SENTINEL_94S_91");
    expect(server.requests[0]?.path).toBe("/v1/messages?beta=true");
    expect(messageTypes(messages)).toEqual(["system", "assistant", "result"]);
    expect(JSON.stringify(messages)).toContain("contract passed");
  }, 30_000);

  test("expands and invokes a project custom command", async () => {
    context = await createProbeContext();
    server = startFakeAnthropicServer(() => textReply("command complete"));
    const commandsDirectory = join(context.workspace, ".claude", "commands");
    await mkdir(commandsDirectory, { recursive: true });
    await writeFile(
      join(commandsDirectory, "contract-command.md"),
      "CUSTOM_COMMAND_SENTINEL_94S_91 arguments=$ARGUMENTS",
    );

    await runSdkQuery(context, server.url, "/contract-command payload-94s-91", {
      maxTurns: 1,
    });

    const request = JSON.stringify(server.requests[0]?.body.messages);
    expect(request).toContain("CUSTOM_COMMAND_SENTINEL_94S_91");
    expect(request).toContain("payload-94s-91");
  }, 30_000);

  test("invokes a project skill through the native Skill tool", async () => {
    context = await createProbeContext();
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply("Skill", { skill: "contract-skill" }, "toolu_94s91_skill")
        : textReply("skill complete"),
    );
    const skillDirectory = join(
      context.workspace,
      ".claude",
      "skills",
      "contract-skill",
    );
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      [
        "---",
        "name: contract-skill",
        "description: Contract probe skill",
        "---",
        "SKILL_SENTINEL_94S_91",
      ].join("\n"),
    );

    await runSdkQuery(context, server.url, "Use the contract skill.", {
      skills: ["contract-skill"],
    });

    expect(JSON.stringify(server.requests[1]?.body.messages)).toContain(
      "SKILL_SENTINEL_94S_91",
    );
  }, 30_000);

  test("invokes an in-process local MCP tool", async () => {
    context = await createProbeContext();
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "mcp__contract__echo",
            { value: "mcp-input-94s-91" },
            "toolu_94s91_mcp",
          )
        : textReply("mcp complete"),
    );
    const calls: string[] = [];
    const mcpServer = createSdkMcpServer({
      name: "contract",
      version: "1.0.0",
      tools: [
        tool(
          "echo",
          "Echo the contract probe value",
          { value: z.string() },
          async ({ value }) => {
            calls.push(value);
            return {
              content: [{ type: "text", text: `MCP_SENTINEL_94S_91:${value}` }],
            };
          },
        ),
      ],
    });

    await runSdkQuery(context, server.url, "Use the local MCP tool.", {
      allowedTools: ["mcp__contract__echo"],
      mcpServers: { contract: mcpServer },
    });

    expect(calls).toEqual(["mcp-input-94s-91"]);
    expect(JSON.stringify(server.requests[1]?.body.messages)).toContain(
      "MCP_SENTINEL_94S_91:mcp-input-94s-91",
    );
  }, 30_000);

  test("loads and invokes a command from a local plugin", async () => {
    context = await createProbeContext();
    server = startFakeAnthropicServer(() => textReply("plugin complete"));
    const pluginRoot = join(context.root, "contract-plugin");
    await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "commands"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        description: "SDK gate contract plugin",
        name: "contract-plugin",
        version: "1.0.0",
      }),
    );
    await writeFile(
      join(pluginRoot, "commands", "probe.md"),
      "PLUGIN_COMMAND_SENTINEL_94S_91 arguments=$ARGUMENTS",
    );

    await runSdkQuery(
      context,
      server.url,
      "/contract-plugin:probe plugin-payload-94s-91",
      { maxTurns: 1, plugins: [{ path: pluginRoot, type: "local" }] },
    );

    const request = JSON.stringify(server.requests[0]?.body.messages);
    expect(request).toContain("PLUGIN_COMMAND_SENTINEL_94S_91");
    expect(request).toContain("plugin-payload-94s-91");
  }, 30_000);

  test("invokes a configured subagent and returns its result", async () => {
    context = await createProbeContext();
    server = startFakeAnthropicServer((_request, index) => {
      if (index === 0) {
        return toolReply(
          "Agent",
          {
            description: "Run the SDK gate subagent",
            prompt: "SUBAGENT_TASK_SENTINEL_94S_91",
            subagent_type: "contract-subagent",
          },
          "toolu_94s91_agent",
        );
      }
      return index === 1
        ? textReply("SUBAGENT_RESULT_SENTINEL_94S_91")
        : textReply("subagent complete");
    });

    await runSdkQuery(context, server.url, "Delegate the probe.", {
      agents: {
        "contract-subagent": {
          description: "SDK gate subagent",
          prompt: "SUBAGENT_PROMPT_SENTINEL_94S_91",
          tools: [],
        },
      },
      allowedTools: ["Agent"],
      tools: ["Agent"],
    });

    const requests = JSON.stringify(server.requests);
    expect(server.requests.length).toBeGreaterThanOrEqual(3);
    expect(requests).toContain("SUBAGENT_TASK_SENTINEL_94S_91");
    expect(requests).toContain("SUBAGENT_PROMPT_SENTINEL_94S_91");
    expect(requests).toContain("SUBAGENT_RESULT_SENTINEL_94S_91");
  }, 30_000);

  test("keeps concurrent AskUserQuestion answers bound to their tool IDs", async () => {
    context = await createProbeContext();
    const question = (label: string) => ({
      header: label,
      multiSelect: false,
      options: [
        { description: `${label} first`, label: `${label}-one` },
        { description: `${label} second`, label: `${label}-two` },
      ],
      question: `Choose ${label}`,
    });
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolsReply([
            {
              id: "toolu_94s91_question_alpha",
              input: { questions: [question("alpha")] },
              name: "AskUserQuestion",
            },
            {
              id: "toolu_94s91_question_beta",
              input: { questions: [question("beta")] },
              name: "AskUserQuestion",
            },
          ])
        : textReply("questions complete"),
    );
    const callbackAnswers = new Map<string, string>();
    let activeCallbacks = 0;
    let maximumActiveCallbacks = 0;

    await runSdkQuery(context, server.url, "Ask both questions.", {
      canUseTool: async (name, input, options) => {
        expect(name).toBe("AskUserQuestion");
        activeCallbacks += 1;
        maximumActiveCallbacks = Math.max(
          maximumActiveCallbacks,
          activeCallbacks,
        );
        await Bun.sleep(30);
        const answer = options.toolUseID.endsWith("alpha")
          ? "alpha custom response"
          : "beta-one";
        callbackAnswers.set(options.toolUseID, answer);
        activeCallbacks -= 1;
        const firstQuestion = (
          input.questions as Array<{ question: string }>
        )[0]?.question;
        return {
          behavior: "allow",
          updatedInput: {
            ...input,
            answers:
              firstQuestion === undefined ? {} : { [firstQuestion]: answer },
          },
        };
      },
      tools: ["AskUserQuestion"],
    });

    expect(maximumActiveCallbacks).toBe(2);
    expect(callbackAnswers).toEqual(
      new Map([
        ["toolu_94s91_question_alpha", "alpha custom response"],
        ["toolu_94s91_question_beta", "beta-one"],
      ]),
    );
    const followUp = JSON.stringify(server.requests[1]?.body.messages);
    expect(followUp).toContain("toolu_94s91_question_alpha");
    expect(followUp).toContain("alpha custom response");
    expect(followUp).toContain("toolu_94s91_question_beta");
    expect(followUp).toContain("beta-one");
  }, 30_000);

  test("resumes in a new CLI process without re-running a completed tool", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "resume-once.txt");
    server = startFakeAnthropicServer((_request, index) => {
      if (index === 0) {
        return toolReply(
          "Bash",
          { command: `printf once >> ${JSON.stringify(outputPath)}` },
          "toolu_94s91_resume_once",
        );
      }
      return index === 1
        ? textReply("FIRST_TURN_COMPLETE_94S_91")
        : textReply("RESUMED_TURN_COMPLETE_94S_91");
    });

    const firstMessages = await runSdkQuery(
      context,
      server.url,
      "Run the command once.",
      {
        allowedTools: ["Bash"],
        tools: ["Bash"],
      },
    );
    const sessionId = sessionIdFrom(firstMessages);
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const resumedMessages = await runSdkQuery(
      context,
      server.url,
      "Continue after the worker restart.",
      { maxTurns: 1, resume: sessionId },
    );

    expect(await readFile(outputPath, "utf8")).toBe("once");
    expect(JSON.stringify(server.requests.at(-1)?.body.messages)).toContain(
      "FIRST_TURN_COMPLETE_94S_91",
    );
    expect(JSON.stringify(resumedMessages)).toContain(
      "RESUMED_TURN_COMPLETE_94S_91",
    );
  }, 30_000);

  test("deduplicates a stable user UUID but treats a regenerated UUID as a new turn", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "repeated-user-message.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0 || index === 2
        ? toolReply(
            "Bash",
            { command: `printf 'once\\n' >> ${JSON.stringify(outputPath)}` },
            `toolu_94s91_repeated_${index}`,
          )
        : textReply(`turn ${index} complete`),
    );
    const uuid = crypto.randomUUID();

    const firstMessages: SDKMessage[] = [];
    for await (const message of query({
      prompt: oneMessage("Run the repeated message fixture.", uuid),
      options: sdkOptions(context, server.url, {
        allowedTools: ["Bash"],
        tools: ["Bash"],
      }),
    })) {
      firstMessages.push(message);
    }

    for await (const _message of query({
      prompt: oneMessage("Run the repeated message fixture.", uuid),
      options: sdkOptions(context, server.url, {
        allowedTools: ["Bash"],
        resume: sessionIdFrom(firstMessages),
        tools: ["Bash"],
      }),
    })) {
      void _message;
    }

    expect(await readFile(outputPath, "utf8")).toBe("once\n");

    for await (const _message of query({
      prompt: oneMessage(
        "Run the repeated message fixture.",
        crypto.randomUUID(),
      ),
      options: sdkOptions(context, server.url, {
        allowedTools: ["Bash"],
        resume: sessionIdFrom(firstMessages),
        tools: ["Bash"],
      }),
    })) {
      void _message;
    }

    expect(await readFile(outputPath, "utf8")).toBe("once\nonce\n");
  }, 30_000);

  test("interrupts only the current turn and accepts a same-process follow-up", async () => {
    context = await createProbeContext();
    const firstRequestStarted = deferred<void>();
    const sendFollowUp = deferred<void>();
    server = startFakeAnthropicServer(async (_request, index) => {
      if (index === 0) {
        firstRequestStarted.resolve();
        await Bun.sleep(500);
        return textReply("INTERRUPTED_RESPONSE_MUST_NOT_SURFACE_94S_91");
      }
      return textReply("FOLLOW_UP_RESPONSE_94S_91");
    });
    const firstUuid = crypto.randomUUID();
    const followUpUuid = crypto.randomUUID();
    const prompts = async function* (): AsyncGenerator<SDKUserMessage> {
      yield userMessage("Start a slow turn.", firstUuid);
      await sendFollowUp.promise;
      yield userMessage("Run the follow-up.", followUpUuid);
    };
    const sdkQuery = query({
      prompt: prompts(),
      options: sdkOptions(context, server.url),
    });
    const messages: SDKMessage[] = [];
    const consume = (async () => {
      for await (const message of sdkQuery) {
        messages.push(message);
      }
    })();

    await firstRequestStarted.promise;
    const receipt = await sdkQuery.interrupt();
    sendFollowUp.resolve();
    await consume;

    expect(receipt?.still_queued).toEqual([]);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain(
      "INTERRUPTED_RESPONSE_MUST_NOT_SURFACE_94S_91",
    );
    expect(serialized).toContain("FOLLOW_UP_RESPONSE_94S_91");
    expect(serialized).toContain(firstUuid);
    expect(serialized).toContain(followUpUuid);
  }, 30_000);

  test("routes a Bash permission ask through canUseTool and invokes hooks", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "permission-allowed.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf allowed > ${JSON.stringify(outputPath)}` },
            "toolu_94s91_allowed",
          )
        : textReply("tool complete"),
    );
    const callbacks: Array<{
      event: string;
      requestId?: string;
      toolUseId?: string;
    }> = [];

    const messages = await runSdkQuery(
      context,
      server.url,
      "Run the command.",
      {
        canUseTool: async (_name, input, options) => {
          callbacks.push({
            event: "canUseTool",
            requestId: options.requestId,
            toolUseId: options.toolUseID,
          });
          return { behavior: "allow", updatedInput: input };
        },
        hooks: Object.fromEntries(
          (["PreToolUse", "PostToolUse"] satisfies HookEvent[]).map((event) => [
            event,
            [
              {
                hooks: [
                  async (_input: unknown, toolUseId: string | undefined) => {
                    callbacks.push({
                      event,
                      ...(toolUseId === undefined ? {} : { toolUseId }),
                    });
                    return { continue: true };
                  },
                ],
              },
            ],
          ]),
        ),
        permissionMode: "default",
        tools: ["Bash"],
      },
    );

    expect(await readFile(outputPath, "utf8")).toBe("allowed");
    expect(callbacks).toContainEqual({
      event: "canUseTool",
      requestId: expect.any(String),
      toolUseId: "toolu_94s91_allowed",
    });
    expect(callbacks).toContainEqual({
      event: "PreToolUse",
      toolUseId: "toolu_94s91_allowed",
    });
    expect(callbacks).toContainEqual({
      event: "PostToolUse",
      toolUseId: "toolu_94s91_allowed",
    });
    expect(JSON.stringify(server.requests[1]?.body.messages)).toContain(
      "tool_result",
    );
    expect(messageTypes(messages)).toContain("result");
  }, 30_000);

  test("bypasses canUseTool for a fully allowed Bash rule", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "rule-allowed.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf rule > ${JSON.stringify(outputPath)}` },
            "toolu_94s91_rule",
          )
        : textReply("tool complete"),
    );
    let callbackCount = 0;

    await runSdkQuery(context, server.url, "Run the command.", {
      allowedTools: ["Bash"],
      canUseTool: async (_name, input) => {
        callbackCount += 1;
        return { behavior: "allow", updatedInput: input };
      },
      permissionMode: "default",
      tools: ["Bash"],
    });

    expect(await readFile(outputPath, "utf8")).toBe("rule");
    expect(callbackCount).toBe(0);
  }, 30_000);

  test("applies a project deny rule before allowedTools and canUseTool", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "project-deny.txt");
    await writeProjectSettings(context, { deny: ["Bash"] });
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf denied > ${JSON.stringify(outputPath)}` },
            "toolu_94s91_project_deny",
          )
        : textReply("deny complete"),
    );
    let callbackCount = 0;

    await runSdkQuery(context, server.url, "Run the command.", {
      allowedTools: ["Bash"],
      canUseTool: async (_name, input) => {
        callbackCount += 1;
        return { behavior: "allow", updatedInput: input };
      },
      tools: ["Bash"],
    });

    expect(await exists(outputPath)).toBe(false);
    expect(callbackCount).toBe(0);
  }, 30_000);

  test("holds a project allow rule in an untrusted SDK workspace", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "project-allow.txt");
    await writeProjectSettings(context, { allow: ["Bash(*)"] });
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf allowed > ${JSON.stringify(outputPath)}` },
            "toolu_94s91_project_allow",
          )
        : textReply("allow complete"),
    );
    let callbackCount = 0;
    const stderr: string[] = [];

    await runSdkQuery(context, server.url, "Run the command.", {
      canUseTool: async () => {
        callbackCount += 1;
        return { behavior: "deny", message: "callback deny" };
      },
      stderr: (line) => stderr.push(line),
      tools: ["Bash"],
    });

    expect(await exists(outputPath)).toBe(false);
    expect(callbackCount).toBe(1);
    expect(stderr.join("\n")).toContain("workspace has not been trusted");
  }, 30_000);

  test("routes a project ask rule through canUseTool despite allowedTools", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "project-ask.txt");
    await writeProjectSettings(context, { ask: ["Bash"] });
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf denied > ${JSON.stringify(outputPath)}` },
            "toolu_94s91_project_ask",
          )
        : textReply("ask complete"),
    );
    let matchedAskRule: unknown;

    await runSdkQuery(context, server.url, "Run the command.", {
      allowedTools: ["Bash"],
      canUseTool: async (_name, _input, options) => {
        matchedAskRule = options.matchedAskRule;
        return { behavior: "deny", message: "host rejected ask" };
      },
      tools: ["Bash"],
    });

    expect(await exists(outputPath)).toBe(false);
    expect(matchedAskRule).toEqual(
      expect.objectContaining({ source: "projectSettings" }),
    );
  }, 30_000);

  test("acceptEdits writes a file without consulting canUseTool", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "accept-edits.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Write",
            { content: "accepted", file_path: outputPath },
            "toolu_94s91_accept_edits",
          )
        : textReply("write complete"),
    );
    let callbackCount = 0;

    await runSdkQuery(context, server.url, "Write the file.", {
      canUseTool: async (_name, input) => {
        callbackCount += 1;
        return { behavior: "allow", updatedInput: input };
      },
      permissionMode: "acceptEdits",
      tools: ["Write"],
    });

    expect(await readFile(outputPath, "utf8")).toBe("accepted");
    expect(callbackCount).toBe(0);
  }, 30_000);

  test("lets an explicit canUseTool allow override plan mode", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "plan-mode.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf blocked > ${JSON.stringify(outputPath)}` },
            "toolu_94s91_plan",
          )
        : textReply("plan denial observed"),
    );
    let callbackCount = 0;

    await runSdkQuery(context, server.url, "Try to run the command.", {
      canUseTool: async (_name, input) => {
        callbackCount += 1;
        return { behavior: "allow", updatedInput: input };
      },
      permissionMode: "plan",
      tools: ["Bash"],
    });

    expect(await readFile(outputPath, "utf8")).toBe("blocked");
    expect(callbackCount).toBe(1);
    expect(JSON.stringify(server.requests[1]?.body.messages)).toContain(
      "tool_result",
    );
  }, 30_000);

  test("denies an emitted Bash call in plan mode without an approval surface", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "plan-mode-no-host.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf denied > ${JSON.stringify(outputPath)}` },
            "toolu_94s91_plan_no_host",
          )
        : textReply("plan denial observed"),
    );

    await runSdkQuery(context, server.url, "Try to run the command.", {
      permissionMode: "plan",
      permissionPrompts: "none",
      tools: ["Bash"],
    });

    expect(await exists(outputPath)).toBe(false);
    expect(JSON.stringify(server.requests[1]?.body.messages)).toContain(
      "tool_result",
    );
  }, 30_000);

  test("denies an unapproved Bash call in dontAsk mode without a callback", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "dont-ask.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf denied > ${JSON.stringify(outputPath)}` },
            "toolu_94s91_dontask",
          )
        : textReply("denial observed"),
    );
    let callbackCount = 0;

    const messages = await runSdkQuery(
      context,
      server.url,
      "Run the command.",
      {
        canUseTool: async (_name, input) => {
          callbackCount += 1;
          return { behavior: "allow", updatedInput: input };
        },
        permissionMode: "dontAsk",
        tools: ["Bash"],
      },
    );

    expect(await exists(outputPath)).toBe(false);
    expect(callbackCount).toBe(0);
    expect(JSON.stringify(server.requests[1]?.body.messages)).toContain(
      "tool_result",
    );
    expect(JSON.stringify(messages)).toContain("permission_denials");
  }, 30_000);
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function messageTypes(messages: SDKMessage[]): string[] {
  return messages.map((message) => message.type);
}

function sessionIdFrom(messages: SDKMessage[]): string {
  const message = messages.find(
    (candidate) =>
      candidate.type === "system" &&
      "subtype" in candidate &&
      candidate.subtype === "init" &&
      "session_id" in candidate,
  );
  if (message === undefined || !("session_id" in message)) {
    throw new Error("SDK init message did not include a session ID");
  }
  return String(message.session_id);
}

async function writeProjectSettings(
  probeContext: ProbeContext,
  permissions: {
    allow?: string[];
    ask?: string[];
    deny?: string[];
  },
): Promise<void> {
  await writeFile(
    join(probeContext.workspace, ".claude", "settings.json"),
    JSON.stringify({ permissions }),
  );
}

function userMessage(
  content: string,
  uuid: `${string}-${string}-${string}-${string}-${string}`,
): SDKUserMessage {
  return {
    message: { content, role: "user" },
    origin: { kind: "human" },
    parent_tool_use_id: null,
    type: "user",
    uuid,
  };
}

async function* oneMessage(
  content: string,
  uuid: `${string}-${string}-${string}-${string}-${string}`,
): AsyncGenerator<SDKUserMessage> {
  yield userMessage(content, uuid);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
