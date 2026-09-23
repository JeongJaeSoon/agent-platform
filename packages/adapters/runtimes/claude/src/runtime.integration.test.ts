import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentFrame, TranscriptKey } from "@agent-platform/runtime-core";
import { createMemoryCheckpointObjectStore } from "@agent-platform/testkit/checkpoint-objects";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "@agent-platform/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@agent-platform/testkit/workspace";
import { ClaudeSdkRuntime } from "./runtime.ts";
import { ClaudeSessionStore } from "./session-store.ts";

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

describe("actual Claude SDK adapter with local Messages API", () => {
  test("keeps a streaming process across turns with explicit isolated options", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-18-" });
    const { home, workspace } = isolated;
    server = startFakeAnthropicServer((_request, index) =>
      textReply(`turn-${index + 1}`),
    );
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
      mode: "new" as const,
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
    const run = runtime.start(runtimeConfig, {
      onPermission: async () => ({
        behavior: "deny",
        message: "No tools expected",
      }),
    });

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
    expect(await run.prepareCheckpoint()).toEqual({
      status: "ready",
      checkpoint: {
        engine: "claude",
        resume: sessionId,
        sdkVersion: "0.3.270",
      },
    });
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
      {
        ...runtimeConfig,
        correlationId: "actual-resume",
        // This run has no checkpoint behind it: the resume handle points at the
        // transcript the first run just wrote to this container's own disk.
        localTranscriptResume: true,
        mode: "resume",
        resume: sessionId,
      },
      {
        onPermission: async () => ({
          behavior: "deny",
          message: "No tools expected",
        }),
      },
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
    isolated = await createIsolatedWorkspace({ prefix: "94s-18-" });
    const { home, workspace } = isolated;
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            {
              command: `printf denied > ${JSON.stringify(join(workspace, "permission-denied.txt"))}`,
            },
            "toolu_permission",
          )
        : textReply("permission handled"),
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
        mode: "new",
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
      {
        onPermission: async (request) => {
          permissionRequests.push({
            requestId: request.requestId,
            toolUseId: request.toolUseId,
          });
          return { behavior: "deny", message: "Permission denied by host" };
        },
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
    isolated = await createIsolatedWorkspace({ prefix: "94s-18-" });
    const { home, workspace } = isolated;
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    server = startFakeAnthropicServer(async (_request, index) => {
      requestStarted?.();
      if (index === 0) {
        await Bun.sleep(500);
        return textReply("INTERRUPTED_RESPONSE_MUST_NOT_SURFACE");
      }
      return textReply("FOLLOW_UP_AFTER_INTERRUPT");
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
        mode: "new",
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
      {
        onPermission: async () => ({
          behavior: "deny",
          message: "No tools expected",
        }),
      },
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
    isolated = await createIsolatedWorkspace({ prefix: "94s-18-" });
    const { home, workspace } = isolated;
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    server = startFakeAnthropicServer(async (request) => {
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
        mode: "new",
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
      {
        onPermission: async () => ({
          behavior: "deny",
          message: "No tools expected",
        }),
      },
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

describe("transcript mirror against the actual SDK", () => {
  test("mirrors every local transcript entry to the session store", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-124-" });
    const { home, workspace } = isolated;
    server = startFakeAnthropicServer((_request, index) =>
      textReply(`mirrored-turn-${index + 1}`),
    );
    const objects = createMemoryCheckpointObjectStore();
    const mirror = new ClaudeSessionStore({
      generation: 1,
      objects,
      prefix: "sessions/direct-local/mirror",
    });
    const mirrored: TranscriptKey[] = [];
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });
    const run = runtime.start(
      {
        claudeConfigDir: home,
        correlationId: "actual-mirror",
        mode: "new",
        cwd: workspace,
        home,
        maxTurns: 2,
        model: "claude-sonnet-4-5",
        profile: {
          kind: "anthropic",
          endpoint: server.url,
          auth: { kind: "api_key", value: "placeholder-local" },
        },
        sessionStore: {
          append: async (key, entries) => {
            mirrored.push(key);
            await mirror.append(key, entries);
          },
          listSubkeys: (key) => mirror.listSubkeys(key),
          load: (key) => mirror.load(key),
        },
        settingSources: ["project"],
        tools: [],
      },
      {
        onPermission: async () => ({
          behavior: "deny",
          message: "No tools expected",
        }),
      },
    );
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();
    run.send({ message: "mirror this turn", uuid: crypto.randomUUID() });
    run.finishInput();
    await withTimeout(consume, 20_000, "Mirrored adapter did not settle");

    expect(
      frames.some(
        (frame) =>
          frame.envelope.message.type === "system" &&
          frame.envelope.message.subtype === "mirror_error",
      ),
    ).toBe(false);
    const rootKey = mirrored.find((key) => key.subpath === undefined);
    if (rootKey === undefined) throw new Error("The SDK mirrored nothing");

    const local = await readTranscript(home, workspace, rootKey.sessionId);
    const stored = (await mirror.load(rootKey)) ?? [];
    expect(Object.keys(byUuid(local)).length).toBeGreaterThan(0);
    expect(byUuid(stored)).toEqual(byUuid(local));
    // A checkpoint is only meaningful because the pinned revision restores to
    // exactly those bytes, whatever the mirror does next.
    const revision = await mirror.captureRevision(rootKey);
    if (revision === null) throw new Error("expected a revision");
    expect(byUuid(await mirror.loadRevision(revision))).toEqual(byUuid(local));
    expect(await run.prepareCheckpoint()).toMatchObject({ status: "ready" });
  }, 40_000);

  test("resumes a new generation from the pinned checkpoint, never from an old worker's later writes", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-203-" });
    const { home, root, workspace } = isolated;
    server = startFakeAnthropicServer((_request, index) =>
      textReply(index === 0 ? "TURN_ONE_CONTEXT" : "TURN_TWO_RESUMED"),
    );
    const objects = createMemoryCheckpointObjectStore();
    const prefix = "sessions/resume/mirror";
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });
    const baseConfig = {
      correlationId: "actual-generation-resume",
      cwd: workspace,
      maxTurns: 2,
      model: "claude-sonnet-4-5",
      profile: {
        kind: "anthropic" as const,
        endpoint: server.url,
        auth: { kind: "api_key" as const, value: "placeholder-local" },
      },
      settingSources: ["project"] as ["project"],
      tools: [],
    };
    const hooks = {
      onPermission: async () => ({
        behavior: "deny" as const,
        message: "No tools expected",
      }),
    };

    const first = new ClaudeSessionStore({ generation: 1, objects, prefix });
    const mirrored: TranscriptKey[] = [];
    const firstFrames = await drive(
      runtime.start(
        {
          ...baseConfig,
          claudeConfigDir: home,
          home,
          mode: "new",
          sessionStore: {
            append: async (key, entries) => {
              mirrored.push(key);
              await first.append(key, entries);
            },
            listSubkeys: (key) => first.listSubkeys(key),
            load: (key) => first.load(key),
          },
        },
        hooks,
      ),
      "remember the first turn",
    );
    const sessionId = sessionIdOf(firstFrames);
    const rootKey = mirrored.find(
      (key) => key.subpath === undefined && key.sessionId === sessionId,
    );
    if (rootKey === undefined) throw new Error("The SDK mirrored nothing");
    const transcripts = await first.captureTranscripts(sessionId);
    if (transcripts === null) throw new Error("expected transcripts");
    const pinned = transcripts.root;

    // The first worker lost its lease and keeps writing: a well-formed entry
    // that continues its own conversation, so only the generation boundary
    // stands between it and the resumed run.
    const stored = (await first.load(rootKey)) ?? [];
    const tail = [...stored]
      .reverse()
      .find((item) => typeof item.uuid === "string");
    if (tail === undefined) throw new Error("expected a stored entry");
    await first.append(rootKey, [
      {
        ...tail,
        message: { content: "ZOMBIE_SUFFIX", role: "user" },
        parentUuid: tail.uuid,
        type: "user",
        uuid: crypto.randomUUID(),
      },
    ]);

    const resumedHome = join(root, "home-resumed");
    await mkdir(resumedHome);
    const second = new ClaudeSessionStore({
      generation: 2,
      inherit: { sessionId, transcripts },
      objects,
      prefix,
    });
    const secondFrames = await drive(
      runtime.start(
        {
          ...baseConfig,
          claudeConfigDir: resumedHome,
          home: resumedHome,
          mode: "resume",
          resume: sessionId,
          sessionStore: second,
        },
        hooks,
      ),
      "what did I ask you to remember?",
    );

    expect(server.requests).toHaveLength(2);
    const resumedRequest = JSON.stringify(server.requests[1]?.body.messages);
    expect(resumedRequest).toContain("remember the first turn");
    expect(resumedRequest).toContain("TURN_ONE_CONTEXT");
    expect(resumedRequest).not.toContain("ZOMBIE_SUFFIX");
    expect(sessionIdOf(secondFrames)).toBe(sessionId);

    // The next checkpoint is the adopted parts followed by the second
    // generation's own, and restores to the conversation the engine had.
    const next = (await second.captureTranscripts(sessionId))?.root;
    if (next === undefined) throw new Error("expected a revision");
    expect(next.parts.slice(0, pinned.parts.length)).toEqual([...pinned.parts]);
    expect(
      next.parts
        .slice(pinned.parts.length)
        .every((part) => part.key.includes("/generation-0000000002/")),
    ).toBe(true);
    const restored = JSON.stringify(await second.loadRevision(next));
    expect(restored).toContain("remember the first turn");
    expect(restored).toContain("TURN_TWO_RESUMED");
    expect(restored).not.toContain("ZOMBIE_SUFFIX");
  }, 60_000);
});

describe("resumed history against the actual SDK (94S-242)", () => {
  test("a checkpoint resume holds exactly the inputs the engine loaded", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-242-" });
    const { home, root, workspace } = isolated;
    server = startFakeAnthropicServer((_request, index) =>
      textReply(`resumed-turn-${index + 1}`),
    );
    const objects = createMemoryCheckpointObjectStore();
    const prefix = "sessions/resume/history";
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });
    const base = {
      correlationId: "actual-resumed-history",
      cwd: workspace,
      maxTurns: 2,
      model: "claude-sonnet-4-5",
      profile: {
        kind: "anthropic" as const,
        endpoint: server.url,
        auth: { kind: "api_key" as const, value: "placeholder-local" },
      },
      settingSources: ["project"] as ["project"],
      tools: [],
    };
    const hooks = {
      onPermission: async () => ({
        behavior: "deny" as const,
        message: "No tools expected",
      }),
    };
    const consumed = crypto.randomUUID();
    const first = new ClaudeSessionStore({ generation: 1, objects, prefix });
    const mirrored: TranscriptKey[] = [];
    const firstRun = runtime.start(
      {
        ...base,
        claudeConfigDir: home,
        home,
        mode: "new",
        sessionStore: {
          append: async (key, entries) => {
            mirrored.push(key);
            await first.append(key, entries);
          },
          listSubkeys: (key) => first.listSubkeys(key),
          load: (key) => first.load(key),
        },
      },
      hooks,
    );
    const frames: AgentFrame[] = [];
    const firstDone = (async () => {
      for await (const frame of firstRun) frames.push(frame);
    })();
    firstRun.send({ message: "remember this", uuid: consumed });
    firstRun.finishInput();
    await withTimeout(firstDone, 20_000, "First run did not settle");
    const sessionId = sessionIdOf(frames);
    const transcripts = await first.captureTranscripts(sessionId);
    if (transcripts === null) throw new Error("expected transcripts");
    // Written past the checkpoint by a worker that lost its lease: the
    // resumed engine never loads it, so it is not held either.
    const rootKey = mirrored.find(
      (key) => key.subpath === undefined && key.sessionId === sessionId,
    );
    if (rootKey === undefined) throw new Error("The SDK mirrored nothing");
    const late = crypto.randomUUID();
    await first.append(rootKey, [
      { type: "user", uuid: late, message: { role: "user", content: "late" } },
    ]);

    const resumedHome = join(root, "home-resumed");
    await mkdir(resumedHome);
    const resumed = runtime.start(
      {
        ...base,
        claudeConfigDir: resumedHome,
        home: resumedHome,
        mode: "resume",
        resume: sessionId,
        sessionStore: new ClaudeSessionStore({
          generation: 2,
          inherit: { sessionId, transcripts },
          objects,
          prefix,
        }),
      },
      hooks,
    );
    const resumedDone = (async () => {
      for await (const _frame of resumed) void _frame;
    })();

    expect(
      await withTimeout(resumed.holdsInput(consumed), 10_000, "No history"),
    ).toBe(true);
    expect(await resumed.holdsInput(late)).toBe(false);
    expect(await resumed.holdsInput(crypto.randomUUID())).toBe(false);
    // Nothing was sent to find that out.
    expect(server.requests).toHaveLength(1);
    resumed.close();
    await withTimeout(
      resumedDone.catch(() => {}),
      10_000,
      "Did not close",
    );
  }, 60_000);
});

/** Sends one prompt, closes input, and collects every frame the run emits. */
async function drive(
  run: AsyncIterable<AgentFrame> & {
    finishInput(): void;
    send(input: { message: string; uuid: string }): void;
  },
  message: string,
): Promise<AgentFrame[]> {
  const frames: AgentFrame[] = [];
  const consume = (async () => {
    for await (const frame of run) frames.push(frame);
  })();
  run.send({ message, uuid: crypto.randomUUID() });
  run.finishInput();
  await withTimeout(consume, 20_000, "SDK run did not settle");
  expect(
    frames.some(
      (frame) =>
        frame.envelope.message.type === "system" &&
        frame.envelope.message.subtype === "mirror_error",
    ),
  ).toBe(false);
  return frames;
}

function sessionIdOf(frames: readonly AgentFrame[]): string {
  const ids = new Set(
    frames
      .map((frame) => frame.envelope.message.session_id)
      .filter((value): value is string => typeof value === "string"),
  );
  const [only] = ids;
  if (ids.size !== 1 || only === undefined) {
    throw new Error(`expected one SDK session id, saw ${[...ids].join(", ")}`);
  }
  return only;
}

/**
 * Where the CLI writes a session's JSONL: `<config dir>/projects/<sanitized
 * cwd>/<session id>.jsonl`. Spelled out here rather than imported, because the
 * adapter package does not depend on the storage package.
 */
async function readTranscript(
  claudeHome: string,
  cwd: string,
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  const path = join(
    claudeHome,
    "projects",
    cwd.replaceAll(/[^a-zA-Z0-9]/g, "-"),
    `${sessionId}.jsonl`,
  );
  return (await Bun.file(path).text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Entries keyed by uuid; entries without one are not mirror-deduplicated. */
function byUuid(
  entries: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    entries
      .filter((entry) => typeof entry.uuid === "string")
      .map((entry) => [entry.uuid as string, entry]),
  );
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
