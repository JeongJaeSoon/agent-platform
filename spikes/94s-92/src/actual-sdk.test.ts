import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Options,
  SDKMessage,
  SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  type PublishCheckpointDependencies,
  publishCheckpoint,
  QuiescenceTracker,
} from "./checkpoint-contract.ts";
import { startFakeAnthropicServer } from "./fake-anthropic.ts";
import {
  createLocalstackClient,
  deletePrefix,
  ensureLocalstackBucket,
  localstackBucket,
  localstackCalls,
  localstackEnabled,
} from "./localstack.ts";
import { startStallReporter } from "./s3-diagnostics.ts";
import { S3SessionStoreProbe } from "./s3-session-store.ts";

const describeActual = localstackEnabled ? describe : describe.skip;

/**
 * Short of bun's own 30s limit, so a child that never settles is reported with
 * its state instead of being replaced by a bare `timed out after 30000ms`.
 */
const CHILD_WATCHDOG_MS = 20_000;

type ChildResult = {
  readonly appendAttempts: number;
  readonly error?: string;
  readonly mirrorErrors?: number;
  readonly result?: { readonly session_id?: string; readonly subtype?: string };
  readonly sequence?: readonly string[];
};

describeActual("actual SDK SessionStore process contract", () => {
  const client = createLocalstackClient();
  const prefix = `94s-92/actual-${crypto.randomUUID()}`;
  let root = "";
  let workspace = "";
  let stopStallReporter = () => {};

  beforeAll(async () => {
    stopStallReporter = startStallReporter("suite", localstackCalls);
    await ensureLocalstackBucket(client);
    root = await mkdtemp(join(tmpdir(), "94s-92-actual-"));
    workspace = join(root, "workspace");
    await mkdir(join(workspace, ".claude"), { recursive: true });
  });

  afterAll(async () => {
    stopStallReporter();
    await deletePrefix(client, prefix);
    client.destroy();
    await rm(root, { force: true, recursive: true });
  });

  test("resumes from LocalStack in a new process and a fresh config directory", async () => {
    const server = startFakeAnthropicServer((_request, index) =>
      index === 0 ? "TURN_ONE_CONTEXT" : "TURN_TWO_RESUMED",
    );
    try {
      const first = await runChild({
        apiUrl: server.url,
        configDir: join(root, "config-first"),
        prefix,
        prompt: "remember the first turn",
        workspace,
      });
      expect(first.exitCode).toBe(0);
      expect(first.value.result?.subtype).toBe("success");
      expect(first.value.mirrorErrors).toBe(0);
      const sessionId = first.value.result?.session_id;
      expect(sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      if (!sessionId) throw new Error("First process returned no session ID");

      const secondConfig = join(root, "config-second");
      const second = await runChild({
        apiUrl: server.url,
        configDir: secondConfig,
        prefix,
        prompt: "what did I ask you to remember?",
        resumeSessionId: sessionId,
        workspace,
      });
      expect(second.exitCode).toBe(0);
      expect(second.value.result?.subtype).toBe("success");
      expect(second.value.mirrorErrors).toBe(0);
      expect(server.requests).toHaveLength(2);
      const resumedRequest = JSON.stringify(server.requests[1]?.body);
      expect(resumedRequest).toContain("TURN_ONE_CONTEXT");
      expect(resumedRequest).toContain("remember the first turn");
      expect(await findJsonl(secondConfig)).toEqual([]);

      const store = new S3SessionStoreProbe({
        bucket: localstackBucket(),
        client,
        prefix,
      });
      const revision = await store.captureRevision({
        projectKey: "tenant-workspace",
        sessionId,
      });
      expect(revision?.entryCount).toBeGreaterThan(0);
    } finally {
      server.stop();
    }
  }, 30_000);

  test("emits mirror_error after three rejected attempts but still yields result", async () => {
    const server = startFakeAnthropicServer(() => "MIRROR_FAILURE_RESULT");
    try {
      const failed = await runChild({
        apiUrl: server.url,
        appendMode: "fail",
        configDir: join(root, "config-failed"),
        prefix: `${prefix}/failed`,
        prompt: "finish despite mirror failure",
        workspace,
      });
      expect(failed.exitCode).toBe(0);
      expect(failed.value.result?.subtype).toBe("success");
      expect(failed.value.appendAttempts).toBeGreaterThanOrEqual(3);
      expect(failed.value.mirrorErrors).toBeGreaterThanOrEqual(1);
      expect(
        failed.value.sequence?.indexOf("system:mirror_error"),
      ).toBeLessThan(failed.value.sequence?.indexOf("result:success") ?? -1);
    } finally {
      server.stop();
    }
  }, 30_000);

  test("deduplicates late writes after the adapter reports a timeout", async () => {
    const server = startFakeAnthropicServer(() => "MIRROR_TIMEOUT_RESULT");
    const timeoutPrefix = `${prefix}/timeout`;
    try {
      const timedOut = await runChild({
        apiUrl: server.url,
        appendMode: "timeout",
        configDir: join(root, "config-timeout"),
        prefix: timeoutPrefix,
        prompt: "finish after an ambiguous append timeout",
        workspace,
      });
      expect(timedOut.exitCode).toBe(0);
      expect(timedOut.value.appendAttempts).toBeGreaterThanOrEqual(3);
      expect(timedOut.value.mirrorErrors).toBeGreaterThanOrEqual(1);
      const sessionId = timedOut.value.result?.session_id;
      if (!sessionId)
        throw new Error("Timed-out process returned no session ID");
      // No settling delay: the child drains its late writes before it exits,
      // so its exit is the synchronisation point.
      const store = new S3SessionStoreProbe({
        bucket: localstackBucket(),
        client,
        prefix: timeoutPrefix,
      });
      const entries = await store.load({
        projectKey: "tenant-workspace",
        sessionId,
      });
      const uuids = (entries ?? []).flatMap((entry) =>
        typeof entry.uuid === "string" ? [entry.uuid] : [],
      );
      expect(new Set(uuids).size).toBe(uuids.length);
    } finally {
      server.stop();
    }
  }, 30_000);

  test("missing store data never becomes a quiet new session with an empty config", async () => {
    const server = startFakeAnthropicServer(() => "MUST_NOT_RUN");
    try {
      const before = server.requests.length;
      const missing = await runChild({
        apiUrl: server.url,
        configDir: join(root, "config-missing"),
        prefix: `${prefix}/missing`,
        prompt: "resume missing session",
        resumeSessionId: crypto.randomUUID(),
        workspace,
      });
      expect(missing.exitCode).not.toBe(0);
      expect(missing.value.error).toContain("No conversation found");
      expect(server.requests).toHaveLength(before);
    } finally {
      server.stop();
    }
  }, 30_000);

  test("a killed process blocked in append cannot publish a durable suffix", async () => {
    const server = startFakeAnthropicServer(() => "BLOCKED_APPEND_RESULT");
    const hangingPrefix = `${prefix}/hanging`;
    try {
      const child = startChild({
        apiUrl: server.url,
        appendMode: "hang",
        configDir: join(root, "config-hanging"),
        prefix: hangingPrefix,
        prompt: "block the mirror",
        workspace,
      });
      await waitForRequestCount(server.requests, 1);
      await Bun.sleep(500);
      child.kill("SIGKILL");
      expect(await child.exited).not.toBe(0);

      const store = new S3SessionStoreProbe({
        bucket: localstackBucket(),
        client,
        prefix: hangingPrefix,
      });
      expect(await store.listSessions("tenant-workspace")).toEqual([]);
    } finally {
      server.stop();
    }
  }, 30_000);

  test("blocks checkpoint publication during an actual Bash write and a registered background writer", async () => {
    const outputPath = join(workspace, "slow-write.txt");
    const backgroundPath = join(workspace, "background-write.txt");
    const server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? {
            id: "toolu_94s92_slow_write",
            input: {
              command: `sleep 1; printf quiescent > ${JSON.stringify(outputPath)}`,
            },
            name: "Bash",
            type: "tool_use" as const,
          }
        : "write complete",
    );
    const tracker = new QuiescenceTracker();
    const toolReleases = new Map<string, () => void>();
    const preToolUse = Promise.withResolvers<void>();
    const calls: string[] = [];
    const dependencies = checkpointDependencies(tracker, calls);
    try {
      const queryPromise = runInProcessQuery(
        server.url,
        join(root, "config-slow-write"),
        workspace,
        new S3SessionStoreProbe({
          bucket: localstackBucket(),
          client,
          prefix: `${prefix}/slow-write`,
        }),
        "Run the slow write.",
        {
          canUseTool: async (_name, input) => ({
            behavior: "allow",
            updatedInput: input,
          }),
          hooks: {
            PostToolUse: [
              {
                hooks: [
                  async (_input, toolUseId) => {
                    if (toolUseId) toolReleases.get(toolUseId)?.();
                    return { continue: true };
                  },
                ],
              },
            ],
            PreToolUse: [
              {
                hooks: [
                  async (_input, toolUseId) => {
                    if (toolUseId) {
                      toolReleases.set(toolUseId, tracker.beginToolWrite());
                    }
                    preToolUse.resolve();
                    return { continue: true };
                  },
                ],
              },
            ],
          },
          permissionMode: "default",
          tools: ["Bash"],
        },
      );
      await preToolUse.promise;
      await expect(
        publishCheckpoint(dependencies, checkpointInput("during-tool")),
      ).rejects.toThrow("Workspace is not quiescent");
      await queryPromise;
      expect(await readFile(outputPath, "utf8")).toBe("quiescent");
      expect(tracker.inspect().activeToolWrites).toBe(0);

      const releaseBackground = tracker.beginBackgroundWriter();
      const background = Bun.spawn({
        cmd: [
          process.execPath,
          "-e",
          `await Bun.sleep(300); await Bun.write(${JSON.stringify(backgroundPath)}, "background")`,
        ],
      });
      await expect(
        publishCheckpoint(dependencies, checkpointInput("during-background")),
      ).rejects.toThrow("Workspace is not quiescent");
      expect(await background.exited).toBe(0);
      releaseBackground();
      await publishCheckpoint(dependencies, checkpointInput("after-writers"));
      expect(await readFile(backgroundPath, "utf8")).toBe("background");
    } finally {
      server.stop();
    }
  }, 30_000);

  test("blocks checkpoint publication while an actual Edit hook is pending", async () => {
    const editPath = join(workspace, "edit-target.txt");
    await writeFile(editPath, "before");
    const server = startFakeAnthropicServer((_request, index) => {
      if (index === 0) {
        return {
          id: "toolu_94s92_read_before_edit",
          input: { file_path: editPath },
          name: "Read",
          type: "tool_use" as const,
        };
      }
      return index === 1
        ? {
            id: "toolu_94s92_edit",
            input: {
              file_path: editPath,
              new_string: "after",
              old_string: "before",
            },
            name: "Edit",
            type: "tool_use" as const,
          }
        : "edit complete";
    });
    const tracker = new QuiescenceTracker();
    const releaseByTool = new Map<string, () => void>();
    const preToolUse = Promise.withResolvers<void>();
    const allowEdit = Promise.withResolvers<void>();
    const dependencies = checkpointDependencies(tracker, []);
    try {
      const queryPromise = runInProcessQuery(
        server.url,
        join(root, "config-edit"),
        workspace,
        new S3SessionStoreProbe({
          bucket: localstackBucket(),
          client,
          prefix: `${prefix}/edit`,
        }),
        "Edit the file.",
        {
          canUseTool: async (_name, input) => ({
            behavior: "allow",
            updatedInput: input,
          }),
          hooks: {
            PostToolUse: [
              {
                hooks: [
                  async (input, toolUseId) => {
                    if (
                      (input as { tool_name?: string }).tool_name === "Edit" &&
                      toolUseId
                    ) {
                      releaseByTool.get(toolUseId)?.();
                    }
                    return { continue: true };
                  },
                ],
              },
            ],
            PreToolUse: [
              {
                hooks: [
                  async (input, toolUseId) => {
                    if (
                      (input as { tool_name?: string }).tool_name === "Edit" &&
                      toolUseId
                    ) {
                      releaseByTool.set(toolUseId, tracker.beginToolWrite());
                      preToolUse.resolve();
                      await allowEdit.promise;
                    }
                    return { continue: true };
                  },
                ],
              },
            ],
          },
          permissionMode: "default",
          maxTurns: 3,
          tools: ["Read", "Edit"],
        },
      );
      await preToolUse.promise;
      await expect(
        publishCheckpoint(dependencies, checkpointInput("during-edit")),
      ).rejects.toThrow("Workspace is not quiescent");
      allowEdit.resolve();
      await queryPromise;
      expect(await readFile(editPath, "utf8")).toBe("after");
      expect(tracker.inspect().activeToolWrites).toBe(0);
    } finally {
      allowEdit.resolve();
      server.stop();
    }
  }, 30_000);
});

type ChildOptions = {
  readonly apiUrl: string;
  readonly appendMode?: "fail" | "hang" | "success" | "timeout";
  readonly configDir: string;
  readonly prefix: string;
  readonly prompt: string;
  readonly resumeSessionId?: string;
  readonly workspace: string;
};

async function runChild(
  options: ChildOptions,
): Promise<{ exitCode: number; value: ChildResult }> {
  const child = startChild(options);
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  let exitCode: number | undefined;
  const settled = Promise.all([
    child.exited.then((code) => {
      exitCode = code;
    }),
    stdout.closed,
    stderr.closed,
  ]);

  const timedOut = await Promise.race([
    settled.then(() => false),
    Bun.sleep(CHILD_WATCHDOG_MS).then(() => true),
  ]);
  if (timedOut) {
    // Which of the three is still open is the whole diagnosis: a live child is
    // a stuck child, while a dead child with an open pipe is a grandchild
    // still holding the write end.
    const state = [
      `child pid=${child.pid} did not settle within ${CHILD_WATCHDOG_MS}ms`,
      `exit=${exitCode ?? "pending"} stdout=${stdout.state()} stderr=${stderr.state()}`,
      `parent s3: ${localstackCalls.describe()}`,
      `child stdout so far: ${JSON.stringify(stdout.text())}`,
      `child stderr so far: ${JSON.stringify(stderr.text())}`,
    ];
    child.kill("SIGTERM");
    await Promise.race([settled, Bun.sleep(2_000)]);
    state.push(`after SIGTERM: exit=${exitCode ?? "pending"}`);
    state.push(`child stderr now: ${JSON.stringify(stderr.text())}`);
    child.kill("SIGKILL");
    throw new Error(state.join("\n  "));
  }

  const line = stdout
    .text()
    .split("\n")
    .find((candidate) => candidate.startsWith("CHILD_RESULT:"));
  if (!line) throw new Error(`Child emitted no result: ${stderr.text()}`);
  return {
    exitCode: exitCode ?? -1,
    value: JSON.parse(line.slice("CHILD_RESULT:".length)) as ChildResult,
  };
}

/** Buffers a child stream so partial output is readable before it closes. */
function collect(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  let open = true;
  const closed = (async () => {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
    }
    buffer += decoder.decode();
    open = false;
  })();
  return {
    closed,
    state: () => (open ? "open" : "closed"),
    text: () => buffer,
  };
}

function startChild(options: ChildOptions) {
  return Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "sdk-child.ts")],
    cwd: import.meta.dir,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: options.apiUrl,
      APPEND_MODE: options.appendMode ?? "success",
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test",
      AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? "http://127.0.0.1:4566",
      AWS_REGION: process.env.AWS_REGION ?? "ap-northeast-1",
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      CLAUDE_CONFIG_DIR: options.configDir,
      PROMPT: options.prompt,
      ...(options.resumeSessionId
        ? { RESUME_SESSION_ID: options.resumeSessionId }
        : {}),
      S3_BUCKET: localstackBucket(),
      SESSION_STORE_PREFIX: options.prefix,
      WORKSPACE_PATH: options.workspace,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
}

async function waitForRequestCount(
  requests: readonly unknown[],
  expected: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (requests.length < expected && Date.now() < deadline) {
    await Bun.sleep(25);
  }
  if (requests.length < expected) throw new Error("Fake API request timed out");
}

async function findJsonl(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { recursive: true })).filter((entry) =>
      entry.endsWith(".jsonl"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function runInProcessQuery(
  apiUrl: string,
  configDir: string,
  workspacePath: string,
  sessionStore: SessionStore,
  prompt: string,
  overrides: Options,
): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for await (const message of query({
    prompt,
    options: {
      cwd: workspacePath,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_BASE_URL: apiUrl,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_PROJECT_DIR_NAME: "tenant-workspace",
        CLAUDE_CONFIG_DIR: configDir,
        HOME: configDir,
      },
      maxTurns: 2,
      model: "claude-sonnet-4-5",
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      sessionStore,
      sessionStoreFlush: "eager",
      settingSources: ["project"],
      ...overrides,
    },
  })) {
    messages.push(message);
  }
  return messages;
}

function resolveClaudeExecutable(): string {
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`Unsupported Claude Code architecture: ${process.arch}`);
  }
  const packageName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  try {
    return Bun.resolveSync(`${packageName}/claude`, import.meta.dir);
  } catch (error) {
    if (process.platform !== "linux") throw error;
    return Bun.resolveSync(`${packageName}-musl/claude`, import.meta.dir);
  }
}

function checkpointDependencies(
  tracker: QuiescenceTracker,
  calls: string[],
): PublishCheckpointDependencies {
  return {
    acquireExclusiveCheckpoint: async () =>
      tracker.acquireCheckpointExclusive(),
    captureRootRevision: async () => ({
      entryCount: 1,
      parts: [{ key: "part", sha256: "a".repeat(64) }],
      sha256: "b".repeat(64),
    }),
    captureSubagentRevisions: async () => ({}),
    commitAndPushWorkspace: async () => {
      calls.push("git");
      return "c".repeat(40);
    },
    compareAndSwapPointer: async () => {
      calls.push("cas");
    },
    inspectQuiescence: async () => tracker.inspect(),
    putImmutableManifest: async () => {
      calls.push("manifest");
    },
    quiesce: async () => {
      calls.push("quiesce");
    },
  };
}

function checkpointInput(generation: string) {
  return {
    cwd: "/workspace",
    generation,
    now: new Date("2026-09-15T00:00:00.000Z"),
    previousGeneration: null,
    runtime: {
      claudeCodeVersion: "2.1.270",
      configProfileSha256: "d".repeat(64),
      sdkVersion: "0.3.270",
    },
    sessionId: "session-a",
  };
}
