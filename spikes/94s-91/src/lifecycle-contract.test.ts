import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  query,
  type SDKMessage,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  createProbeContext,
  type FakeAnthropicServer,
  type ProbeContext,
  readTranscripts,
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

describe.serial("Agent SDK process lifecycle", () => {
  test.each(["abort", "SIGTERM", "SIGKILL"] as const)(
    "%s during approval wait preserves the pending tool without side effects",
    async (termination) => {
      context = await createProbeContext();
      const outputPath = join(context.workspace, `approval-${termination}.txt`);
      const approvalStarted = deferred<void>();
      let approvalCount = 0;
      server = startFakeAnthropicServer((_request, index) =>
        index === 0
          ? toolReply(
              "Bash",
              { command: `printf changed > ${JSON.stringify(outputPath)}` },
              `toolu_94s91_${termination.toLowerCase()}`,
            )
          : textReply("resume observed the interrupted approval"),
      );
      const controller = new AbortController();
      let child: ChildProcessWithoutNullStreams | undefined;
      const messages: SDKMessage[] = [];
      let iteratorError: unknown;
      const sdkQuery = query({
        prompt: "Request the file write.",
        options: sdkOptions(context, server.url, {
          abortController: controller,
          canUseTool: async (_name, _input, options) => {
            approvalCount += 1;
            approvalStarted.resolve();
            await aborted(options.signal);
            return { behavior: "deny", message: "process terminated" };
          },
          spawnClaudeCodeProcess: (options) => {
            child = spawnClaude(options);
            return child;
          },
          tools: ["Bash"],
        }),
      });
      const consume = (async () => {
        try {
          for await (const message of sdkQuery) messages.push(message);
        } catch (error) {
          iteratorError = error;
        }
      })();

      await approvalStarted.promise;
      const pid = child?.pid;
      expect(pid).toBeGreaterThan(0);
      if (termination === "abort") controller.abort();
      else child?.kill(termination);
      await Promise.race([
        consume,
        Bun.sleep(5_000).then(() => {
          throw new Error(`${termination} query did not settle`);
        }),
      ]);
      if (!child) throw new Error("Claude Code child process was not captured");
      const exit = await waitForExit(child);
      const outcome =
        exit.signal === null ? `exit:${exit.code}` : `signal:${exit.signal}`;
      expect(
        termination === "abort"
          ? ["exit:0", "signal:SIGTERM"]
          : termination === "SIGTERM"
            ? ["exit:143", "signal:SIGTERM"]
            : ["exit:137", "signal:SIGKILL"],
      ).toContain(outcome);

      expect(await exists(outputPath)).toBe(false);
      const transcript = await readTranscripts(context);
      const pendingToolPersisted = transcript.includes(
        `toolu_94s91_${termination.toLowerCase()}`,
      );
      if (termination !== "SIGKILL") {
        expect(transcript).toContain(
          `toolu_94s91_${termination.toLowerCase()}`,
        );
      }
      const results = messages
        .filter((message) => message.type === "result")
        .map((message) => ({
          is_error: message.is_error,
          subtype: message.subtype,
          terminal_reason: message.terminal_reason,
        }));
      if (termination === "abort") {
        expect(results).toEqual([
          {
            is_error: false,
            subtype: "success",
            terminal_reason: "completed",
          },
        ]);
      } else {
        expect(results).toEqual([]);
      }
      expect(iteratorError).toBeInstanceOf(Error);

      const sessionId = sessionIdFrom(messages);
      if (termination === "SIGKILL" && !pendingToolPersisted) {
        await expect(
          runSdkQuery(
            context,
            server.url,
            "Continue after the terminated approval.",
            { maxTurns: 1, resume: sessionId },
          ),
        ).rejects.toThrow("No conversation found");
        return;
      }
      const resumed = await runSdkQuery(
        context,
        server.url,
        "Continue after the terminated approval.",
        {
          canUseTool: async (_name, input) => {
            approvalCount += 1;
            return { behavior: "allow", updatedInput: input };
          },
          maxTurns: 1,
          resume: sessionId,
          tools: ["Bash"],
        },
      );
      expect(approvalCount).toBe(1);
      expect(await exists(outputPath)).toBe(false);
      expect(JSON.stringify(resumed)).toContain(
        "resume observed the interrupted approval",
      );
    },
    30_000,
  );

  test("deferred hook decisions stop a multi-tool turn and do not replay on resume", async () => {
    context = await createProbeContext();
    const firstPath = join(context.workspace, "deferred-first.txt");
    const secondPath = join(context.workspace, "deferred-second.txt");
    const hookToolIds: string[] = [];
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolsReply([
            {
              id: "toolu_94s91_deferred_first",
              input: {
                command: `printf first > ${JSON.stringify(firstPath)}`,
              },
              name: "Bash",
            },
            {
              id: "toolu_94s91_deferred_second",
              input: {
                command: `printf second > ${JSON.stringify(secondPath)}`,
              },
              name: "Bash",
            },
          ])
        : textReply("resume after defer completed"),
    );

    const messages = await runSdkQuery(
      context,
      server.url,
      "Request both deferred writes.",
      {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (_input, toolUseId) => {
                  if (toolUseId !== undefined) hookToolIds.push(toolUseId);
                  return {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "defer",
                      permissionDecisionReason:
                        "await durable external approval",
                    },
                  };
                },
              ],
            },
          ],
        },
        tools: ["Bash"],
      },
    );

    expect(hookToolIds.sort()).toEqual([
      "toolu_94s91_deferred_first",
      "toolu_94s91_deferred_second",
    ]);
    expect(await exists(firstPath)).toBe(false);
    expect(await exists(secondPath)).toBe(false);
    const result = messages.find((message) => message.type === "result");
    expect(result).toEqual(
      expect.objectContaining({
        is_error: false,
        subtype: "success",
        terminal_reason: "tool_deferred",
      }),
    );
    expect(JSON.stringify(server.requests[0])).toContain(
      "APPEND_SENTINEL_94S_91",
    );

    const resumed = await runSdkQuery(
      context,
      server.url,
      "Continue after external approval was recorded.",
      { maxTurns: 1, resume: sessionIdFrom(messages) },
    );
    expect(hookToolIds).toHaveLength(2);
    expect(await exists(firstPath)).toBe(false);
    expect(await exists(secondPath)).toBe(false);
    expect(JSON.stringify(resumed)).toContain("resume after defer completed");
  }, 30_000);
});

function spawnClaude(options: SpawnOptions): ChildProcessWithoutNullStreams {
  return spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value?: T): void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise(value as T),
  };
}

function sessionIdFrom(messages: SDKMessage[]): string {
  const sessionId = messages.find(
    (message) => "session_id" in message,
  )?.session_id;
  if (sessionId === undefined)
    throw new Error("SDK session id was not emitted");
  return sessionId;
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
    ),
    Bun.sleep(5_000).then(() => {
      throw new Error("Claude Code child process did not exit");
    }),
  ]);
}
