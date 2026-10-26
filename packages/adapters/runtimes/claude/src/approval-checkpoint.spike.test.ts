/**
 * SPIKE 94S-853 (T-7), never merged: can a checkpoint taken while the engine
 * waits in canUseTool be restored in a new process and resumed, with the
 * dangling tool_use closed by a synthetic "interrupted by restart" result?
 *
 * Every run writes its evidence (event log, transcript at K, the resumed
 * Messages request, side-effect counts) to $SPIKE_OUT/<case>.json.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  CheckpointTranscripts,
  TranscriptEntry,
  TranscriptKey,
  TranscriptMirror,
} from "@werft-ai/runtime-core";
import { createMemoryCheckpointObjectStore } from "@werft-ai/testkit/checkpoint-objects";
import {
  type FakeReply,
  type RecordedRequest,
  startFakeAnthropicServer,
  textReply,
  toolsReply,
} from "@werft-ai/testkit/fake-anthropic";
import { createIsolatedWorkspace } from "@werft-ai/testkit/workspace";

import {
  restoreCheckpointTree,
  stageCheckpointBundle,
} from "../../../../../apps/worker/src/checkpoint-restore.ts";
import { captureWorkspace } from "../../../../../apps/worker/src/workspace-capture.ts";
import type { ClaudeRuntimeConfig } from "./config.ts";
import { InputStream } from "./run.ts";
import { buildSdkOptions, ClaudeSdkRuntime } from "./runtime.ts";
import { ClaudeSessionStore } from "./session-store.ts";
import { TurnLedger } from "./turn-ledger.ts";

const OUT = process.env.SPIKE_OUT ?? join(tmpdir(), "ap-94s-853-w4a");
const SYNTHETIC = "Interrupted by a worker restart before this call ran.";
/** What the CLI itself writes for a tool_use it finds unanswered on resume. */
const ENGINE_INTERRUPTED = "[Request interrupted by user for tool use]";
const MODEL = "claude-sonnet-4-5";
const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

type Call = { id: string; name: string; input: Record<string, unknown> };
type Variant = {
  name: string;
  /** Assistant turns before the wait; each is one Messages reply. */
  replies: (ctx: Ctx) => Call[][];
  /** Calls canUseTool answers at once; every other one parks. */
  autoAllow: (ctx: Ctx) => Set<string>;
  /** The call whose wait triggers K. */
  waitFor: string;
};
type Ctx = { execLog: string; workspace: string };
type Event = { t: number; ev: string } & Record<string, unknown>;

const bash = (id: string, ctx: Ctx): Call => ({
  id,
  name: "Bash",
  input: {
    command: `echo ${id} >> marker.txt && echo ${id} >> ${ctx.execLog}`,
    description: `append ${id}`,
  },
});

const VARIANTS: Record<string, Variant> = {
  serial: {
    name: "serial",
    replies: (ctx) => [[bash("toolu_pre", ctx)], [bash("toolu_wait", ctx)]],
    autoAllow: () => new Set(["toolu_pre"]),
    waitFor: "toolu_wait",
  },
  parallelAllowedFirst: {
    name: "parallelAllowedFirst",
    replies: (ctx) => [[bash("toolu_a", ctx), bash("toolu_b", ctx)]],
    autoAllow: () => new Set(["toolu_a"]),
    waitFor: "toolu_b",
  },
  parallelWaitFirst: {
    name: "parallelWaitFirst",
    replies: (ctx) => [[bash("toolu_b", ctx), bash("toolu_a", ctx)]],
    autoAllow: () => new Set(["toolu_a"]),
    waitFor: "toolu_b",
  },
  // Read is concurrency-safe, so the engine may run these two side by side;
  // the one outside the workspace asks, the one inside never does.
  parallelReadsAutoFirst: {
    name: "parallelReadsAutoFirst",
    replies: (ctx) => [
      [
        {
          id: "toolu_ra",
          name: "Read",
          input: { file_path: join(ctx.workspace, "seed.txt") },
        },
        { id: "toolu_rb", name: "Read", input: { file_path: "/etc/hosts" } },
      ],
    ],
    autoAllow: () => new Set(["toolu_ra"]),
    waitFor: "toolu_rb",
  },
  parallelReadsWaitFirst: {
    name: "parallelReadsWaitFirst",
    replies: (ctx) => [
      [
        { id: "toolu_rb", name: "Read", input: { file_path: "/etc/hosts" } },
        {
          id: "toolu_ra",
          name: "Read",
          input: { file_path: join(ctx.workspace, "seed.txt") },
        },
      ],
    ],
    autoAllow: () => new Set(["toolu_ra"]),
    waitFor: "toolu_rb",
  },
};

function blocksOf(message: unknown): Array<Record<string, unknown>> {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

function toolIds(entries: ReadonlyArray<Record<string, unknown>>): {
  uses: string[];
  results: Array<{ id: string; synthetic: boolean }>;
} {
  const uses: string[] = [];
  const results: Array<{ id: string; synthetic: boolean }> = [];
  for (const entry of entries) {
    for (const block of blocksOf(entry.message ?? entry)) {
      if (block.type === "tool_use") uses.push(block.id as string);
      if (block.type === "tool_result") {
        const content = JSON.stringify(block.content ?? "");
        results.push({
          id: block.tool_use_id as string,
          synthetic:
            content.includes(SYNTHETIC) || content.includes(ENGINE_INTERRUPTED),
        });
      }
    }
  }
  return { uses, results };
}

/** A Messages request the real API would reject: a tool_use with no result in the next user turn. */
function pairingProblems(messages: unknown[]): string[] {
  const problems: string[] = [];
  messages.forEach((message, index) => {
    const m = message as { role?: string };
    if (m.role !== "assistant") return;
    const uses = blocksOf(m)
      .filter((block) => block.type === "tool_use")
      .map((block) => block.id as string);
    if (uses.length === 0) return;
    const next = messages[index + 1] as { role?: string } | undefined;
    const answered = new Set(
      next?.role === "user"
        ? blocksOf(next)
            .filter((block) => block.type === "tool_result")
            .map((block) => block.tool_use_id as string)
        : [],
    );
    for (const id of uses) {
      if (!answered.has(id)) problems.push(`message ${index}: ${id} has no tool_result next`);
    }
  });
  return problems;
}

function inputHash(tool: string, input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([tool, input]))
    .digest("hex")
    .slice(0, 16);
}

async function lines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "spike",
      GIT_AUTHOR_EMAIL: "spike@example.test",
      GIT_COMMITTER_NAME: "spike",
      GIT_COMMITTER_EMAIL: "spike@example.test",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  return stdout;
}

function baseConfig(endpoint: string, workspace: string, home: string) {
  return {
    claudeConfigDir: home,
    correlationId: "spike-853",
    cwd: workspace,
    home,
    maxTurns: 8,
    model: MODEL,
    profile: {
      kind: "anthropic" as const,
      endpoint,
      auth: { kind: "api_key" as const, value: "placeholder-local" },
      principal: { ownerScope: "owner-spike" },
    },
    settingSources: ["project"] as ["project"],
    tools: ["Bash", "Read"],
  };
}

type PhaseA = {
  ctx: Ctx;
  events: Event[];
  k: CheckpointTranscripts;
  kEntries: Array<Record<string, unknown>>;
  sessionId: string;
  bundle: { gitCommit: string; path: string };
  root: string;
  objects: ReturnType<typeof createMemoryCheckpointObjectStore>;
  prefix: string;
  rootKey: TranscriptKey;
  enginePid: number;
  report: Record<string, unknown>;
};

/** Gen 1: drive the engine into canUseTool, take K there, then SIGKILL the engine. */
async function runUntilWait(
  variant: Variant,
  afterK: "kill" | "answer" = "kill",
): Promise<PhaseA> {
  const isolated = await createIsolatedWorkspace({ prefix: `spike-853-${variant.name}-` });
  cleanups.push(() => isolated.dispose());
  const { home, root, workspace } = isolated;
  const ctx: Ctx = { execLog: join(root, "exec.log"), workspace };
  await writeFile(join(workspace, "seed.txt"), "seed\n");
  await git(workspace, "init", "--quiet", "--initial-branch=main");
  await git(workspace, "add", "seed.txt");
  await git(workspace, "commit", "--quiet", "-m", "seed");

  const start = performance.now();
  const events: Event[] = [];
  const log = (ev: string, data: Record<string, unknown> = {}) =>
    events.push({ t: Math.round(performance.now() - start), ev, ...data });

  const turns = variant.replies(ctx);
  const server = startFakeAnthropicServer((request) => {
    const answered = new Set(
      toolIds((request.body.messages ?? []) as Array<Record<string, unknown>>).results.map(
        (r) => r.id,
      ),
    );
    const next = turns.find((calls) => calls.some((call) => !answered.has(call.id)));
    log("model.request", { answered: [...answered] });
    return next === undefined ? textReply("done") : toolsReply(next);
  });
  cleanups.push(async () => server.stop());

  const objects = createMemoryCheckpointObjectStore();
  const prefix = `sessions/spike-${variant.name}/mirror`;
  const store = new ClaudeSessionStore({ generation: 1, objects, prefix });
  const keys: TranscriptKey[] = [];
  const mirror: TranscriptMirror = {
    append: async (key, entries) => {
      if (!keys.some((k) => k.sessionId === key.sessionId && k.subpath === key.subpath)) {
        keys.push(key);
      }
      const ids = toolIds(entries as Array<Record<string, unknown>>);
      log("mirror.append.start", { n: entries.length, subpath: key.subpath, ...ids });
      await store.append(key, entries);
      log("mirror.append.done", { n: entries.length, ...ids });
    },
    listSubkeys: (key) => store.listSubkeys(key),
    load: (key) => store.load(key),
  };

  const ledger = new TurnLedger();
  const input = new InputStream();
  const abortController = new AbortController();
  const pids: number[] = [];
  const allow = variant.autoAllow(ctx);
  const waiting = Promise.withResolvers<void>();
  const parked: Array<() => void> = [];
  const config = {
    ...baseConfig(server.url, workspace, home),
    mode: "new" as const,
    sessionStore: mirror,
  } satisfies ClaudeRuntimeConfig;
  const options = buildSdkOptions(
    config,
    {
      onPermission: async (request) => {
        log("canUseTool", { id: request.toolUseId, tool: request.tool });
        if (allow.has(request.toolUseId)) return { behavior: "allow" };
        if (ledger.waitingToolUseIds().includes(variant.waitFor)) waiting.resolve();
        // Parks until the run dies, as a question nobody has answered yet,
        // or until afterK "answer" allows every parked call.
        return new Promise((resolve, reject) => {
          parked.push(() => resolve({ behavior: "allow" }));
          request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    },
    ledger,
    abortController,
    { onSpawn: (pid) => pids.push(pid) },
  );
  const hooks = options.hooks ?? {};
  for (const name of ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const) {
    hooks[name] = [
      {
        hooks: [
          async (hookInput) => {
            log(`hook.${name}`, {
              id: "tool_use_id" in hookInput ? hookInput.tool_use_id : undefined,
            });
            return {};
          },
        ],
      },
      ...(hooks[name] ?? []),
    ];
  }
  const sdkQuery = query({ prompt: input, options: { ...options, hooks } });
  let sessionId: string | undefined;
  const consume = (async () => {
    for await (const message of sdkQuery as AsyncIterable<SDKMessage>) {
      ledger.observe(message as never);
      if (typeof message.session_id === "string") sessionId = message.session_id;
      if (message.type === "assistant" || message.type === "user") {
        log(`sdk.${message.type}`, toolIds([message as never]));
      }
    }
  })().catch((error: unknown) => log("sdk.stream.error", { error: String(error) }));

  input.push({ message: "START", uuid: crypto.randomUUID() });
  await Promise.race([
    waiting.promise,
    Bun.sleep(30_000).then(() => {
      throw new Error(`never parked on ${variant.waitFor}: ${JSON.stringify(events)}`);
    }),
  ]);
  // canUseTool sees the call before the frame loop does; let it catch up once.
  await Bun.sleep(0);
  log("parked", {
    waiting: ledger.waitingToolUseIds(),
    running: ledger.runningToolUseIds(),
  });

  const turnEndVerdict = ledger.prepareCheckpoint();
  const approvalVerdict = ledger.prepareCheckpoint("approval_wait");
  log("verdicts", { turnEndVerdict, approvalVerdict });

  // Barrier: the mirror must hold the parked call's tool_use and the result of
  // every call PostToolUse settled before the wait.
  const rootKey = () => keys.find((k) => k.subpath === undefined);
  const barrierHolds = async () => {
    const key = rootKey();
    if (key === undefined) return { holds: false, missing: ["root key"] };
    const settled = events
      .filter((e) => e.ev === "hook.PostToolUse" || e.ev === "hook.PostToolUseFailure")
      .map((e) => e.id as string);
    const ids = toolIds(((await store.load(key)) ?? []) as Array<Record<string, unknown>>);
    const missing = [
      ...ledger.runningToolUseIds().map((id) => `running:${id}`),
      ...ledger.waitingToolUseIds().filter((id) => !ids.uses.includes(id)),
      ...settled.filter((id) => !ids.results.some((r) => r.id === id)),
    ];
    return { holds: missing.length === 0, missing };
  };
  const atPark = await barrierHolds();
  log("barrier.atPark", atPark);
  const barrierStart = performance.now();
  let barrier = atPark;
  while (!barrier.holds && performance.now() - barrierStart < 5_000) {
    await Bun.sleep(25);
    barrier = await barrierHolds();
  }
  log("barrier.final", { ...barrier, waitedMs: Math.round(performance.now() - barrierStart) });

  const grant = ledger.leaseCheckpoint("approval_wait");
  if (grant.lease === null || sessionId === undefined) {
    throw new Error(`no approval lease: ${JSON.stringify(grant.preparation)}`);
  }
  const captureStart = performance.now();
  const k = await store.captureTranscripts(sessionId);
  const bundlePath = join(root, "k.bundle");
  const workspaceCapture = await captureWorkspace({
    root: workspace,
    bundlePath,
    signal: new AbortController().signal,
    markNewFiles: true,
  });
  const captureMs = Math.round(performance.now() - captureStart);
  grant.lease.release();
  if (k === null) throw new Error("no transcript to pin");
  if (workspaceCapture.status !== "captured") {
    throw new Error(`workspace capture refused: ${workspaceCapture.reason}`);
  }
  const kEntries = (await store.loadRevision(k.root)) as Array<Record<string, unknown>>;
  log("captured", {
    captureMs,
    kParts: k.root.parts.length,
    kSubagents: Object.keys(k.subagents),
    kIds: toolIds(kEntries),
    bundleBytes: workspaceCapture.capture.bundle.bytes,
  });
  const markerAtK = await lines(join(workspace, "marker.txt"));
  if (afterK === "answer") {
    // Which engine callbacks follow K once the parked call is allowed: the
    // places an invalidation of K has to hook.
    log("answer.delivered");
    while (parked.length > 0) {
      parked.shift()?.();
      await Bun.sleep(300);
    }
    input.finish();
    await Promise.race([consume, Bun.sleep(10_000)]);
  }

  // Worker death: no interrupt, no answer, no finalize. The engine is the only
  // process this test started, and only its recorded pid is killed.
  const enginePid = pids[0];
  if (enginePid === undefined || pids.length !== 1) throw new Error(`pids: ${pids}`);
  if (afterK === "kill") {
    process.kill(enginePid, "SIGKILL");
    log("killed", { enginePid });
    abortController.abort();
    input.finish();
    await Promise.race([consume, Bun.sleep(5_000)]);
  }
  server.stop();

  return {
    bundle: { gitCommit: workspaceCapture.capture.gitCommit, path: bundlePath },
    ctx,
    enginePid,
    events,
    k,
    kEntries,
    objects,
    prefix,
    rootKey: rootKey() as TranscriptKey,
    report: {
      variant: variant.name,
      requestsBeforeKill: server.requests.length,
      markerAtK,
      execLogAtKill: await lines(ctx.execLog),
    },
    root,
    sessionId,
  };
}

/** The synthetic results the adapter would add to K's transcript at load time. */
function repairEntries(
  entries: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const { uses, results } = toolIds(entries);
  const answered = new Set(results.map((r) => r.id));
  const dangling = uses.filter((id) => !answered.has(id));
  if (dangling.length === 0) return [];
  const last = [...entries].reverse().find((e) => typeof e.uuid === "string");
  const template = [...entries].reverse().find((e) => e.type === "assistant");
  if (last === undefined || template === undefined) throw new Error("no entry to extend");
  return [
    {
      cwd: template.cwd,
      gitBranch: template.gitBranch,
      isSidechain: false,
      message: {
        role: "user",
        content: dangling.map((id) => ({
          type: "tool_result",
          tool_use_id: id,
          content: SYNTHETIC,
          is_error: true,
        })),
      },
      parentUuid: last.uuid,
      sessionId: template.sessionId,
      timestamp: new Date().toISOString(),
      toolUseResult: `Error: ${SYNTHETIC}`,
      type: "user",
      userType: template.userType,
      uuid: crypto.randomUUID(),
      version: template.version,
    },
  ];
}

/** Gen 2: restore the workspace and K into a fresh home, then resume. */
async function resumeFromK(
  a: PhaseA,
  variant: Variant,
  /**
   * none: the engine's own repair on resume. repair: synthetic results added
   * only in what load() answers. append: the same results written to this
   * generation's mirror before the engine starts.
   */
  repair: "none" | "repair" | "append",
): Promise<Record<string, unknown>> {
  const events: Event[] = [];
  const start = performance.now();
  const log = (ev: string, data: Record<string, unknown> = {}) =>
    events.push({ t: Math.round(performance.now() - start), ev, ...data });

  const signal = new AbortController().signal;
  const staged = await stageCheckpointBundle({
    bundle: a.bundle.path,
    gitCommit: a.bundle.gitCommit,
    repository: join(a.root, `staged-${repair}.git`),
    signal,
  });
  await restoreCheckpointTree({ origin: null, root: a.ctx.workspace, signal, staged });
  const markerAfterRestore = await lines(join(a.ctx.workspace, "marker.txt"));
  const execBefore = await lines(a.ctx.execLog);

  const original = new Map<string, Call>();
  for (const calls of variant.replies(a.ctx)) for (const c of calls) original.set(c.id, c);
  const server = startFakeAnthropicServer((request: RecordedRequest): FakeReply => {
    const messages = (request.body.messages ?? []) as Array<Record<string, unknown>>;
    const { results } = toolIds(messages);
    const real = new Set(results.filter((r) => !r.synthetic).map((r) => r.id));
    // The scripted model retries, once and with the same input, every
    // original call that never produced a real result.
    const retries = [...original.values()]
      .filter((c) => !real.has(c.id) && !real.has(`${c.id}_retry`))
      .map((c) => ({ ...c, id: `${c.id}_retry` }));
    log("model.request", {
      results,
      pairingProblems: pairingProblems(messages),
      retries: retries.map((c) => c.id),
    });
    return retries.length === 0 ? textReply("finished") : toolsReply(retries);
  });
  cleanups.push(async () => server.stop());

  const home = join(a.root, `home-gen2-${repair}`);
  await mkdir(home, { recursive: true });
  const store = new ClaudeSessionStore({
    generation: 2,
    inherit: { sessionId: a.sessionId, transcripts: a.k },
    objects: a.objects,
    prefix: a.prefix,
  });
  if (repair === "append") {
    const added = repairEntries(a.kEntries);
    await store.append(a.rootKey, added as TranscriptEntry[]);
    log("repair.appended", { added: added.map((e) => toolIds([e]).results) });
  }
  const mirror: TranscriptMirror = {
    revisionScoped: true,
    append: (key, entries) => store.append(key, entries),
    listSubkeys: (key) => store.listSubkeys(key),
    load: async (key) => {
      const loaded = await store.load(key);
      if (loaded === null || key.subpath !== undefined || repair !== "repair") return loaded;
      const added = repairEntries(loaded as Array<Record<string, unknown>>);
      log("repair", { added: added.map((e) => toolIds([e]).results) });
      return [...loaded, ...(added as TranscriptEntry[])];
    },
    resumedEntryIds: () => store.resumedEntryIds(),
  };
  const permissions: Array<Record<string, unknown>> = [];
  const runtime = new ClaudeSdkRuntime({ endpoints: [server.url], models: [MODEL] });
  const run = runtime.start(
    {
      ...baseConfig(server.url, a.ctx.workspace, home),
      mode: "resume",
      resume: a.sessionId,
      sessionStore: mirror,
    },
    {
      onPermission: async (request) => {
        const retried = original.get(request.toolUseId.replace(/_retry$/, ""));
        permissions.push({
          id: request.toolUseId,
          tool: request.tool,
          inputHash: inputHash(request.tool, request.input),
          originalHash:
            retried === undefined ? null : inputHash(retried.name, retried.input),
        });
        return { behavior: "allow" };
      },
    },
  );
  const frames: unknown[] = [];
  const consume = (async () => {
    for await (const frame of run) {
      const message = frame.envelope.message as Record<string, unknown>;
      if (message.type === "assistant" || message.type === "user") {
        log(`sdk.${message.type}`, toolIds([message]));
      }
      if (message.type === "result") {
        log("sdk.result", { subtype: message.subtype, is_error: message.is_error });
        run.finishInput();
      }
      frames.push(message);
    }
  })();
  run.send({
    message:
      "CONTINUE: the worker restarted while a tool call waited for approval. The approval is granted; retry the call.",
    uuid: crypto.randomUUID(),
  });
  await Promise.race([
    consume,
    Bun.sleep(30_000).then(() => {
      throw new Error(`resume did not settle: ${JSON.stringify(events)}`);
    }),
  ]);
  server.stop();

  // The turn-end checkpoint gen 2 would commit, and a gen 3 resumed from it:
  // does the repaired history survive a second hand-off?
  const k2 = await store.captureTranscripts(a.sessionId);
  if (k2 === null) throw new Error("gen 2 pinned nothing");
  const k2Entries = (await store.loadRevision(k2.root)) as Array<Record<string, unknown>>;
  const gen3 = startFakeAnthropicServer(() => textReply("gen3"));
  cleanups.push(async () => gen3.stop());
  const home3 = join(a.root, `home-gen3-${repair}`);
  await mkdir(home3, { recursive: true });
  const store3 = new ClaudeSessionStore({
    generation: 3,
    inherit: { sessionId: a.sessionId, transcripts: k2 },
    objects: a.objects,
    prefix: a.prefix,
  });
  const run3 = new ClaudeSdkRuntime({ endpoints: [gen3.url], models: [MODEL] }).start(
    {
      ...baseConfig(gen3.url, a.ctx.workspace, home3),
      mode: "resume",
      resume: a.sessionId,
      sessionStore: store3,
    },
    { onPermission: async () => ({ behavior: "deny", message: "no tools in gen 3" }) },
  );
  const consume3 = (async () => {
    for await (const frame of run3) {
      if ((frame.envelope.message as { type?: string }).type === "result") run3.finishInput();
    }
  })();
  run3.send({ message: "GEN3", uuid: crypto.randomUUID() });
  await Promise.race([consume3, Bun.sleep(30_000)]);
  gen3.stop();
  const gen3Messages = (gen3.requests[0]?.body.messages ?? []) as Array<Record<string, unknown>>;

  const firstResumed = server.requests[0]?.body.messages as unknown[] | undefined;
  return {
    gen2Pinned: {
      parts: k2.root.parts.length,
      ids: toolIds(k2Entries),
      brokenParents: brokenParents(k2Entries),
    },
    gen3: {
      requests: gen3.requests.length,
      ids: toolIds(gen3Messages),
      pairingProblems: pairingProblems(gen3Messages),
    },
    repair,
    events,
    permissions,
    markerAfterRestore,
    markerFinal: await lines(join(a.ctx.workspace, "marker.txt")),
    execLogBeforeResume: execBefore,
    execLogFinal: await lines(a.ctx.execLog),
    requests: server.requests.length,
    firstResumedRequestTail: firstResumed?.slice(-3),
  };
}

async function record(name: string, body: unknown): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
}

describe("SPIKE 94S-853: approval-wait checkpoint K", () => {
  for (const variant of Object.values(VARIANTS)) {
    for (const repair of ["repair", "none", "append"] as const) {
      test(`${variant.name} / ${repair}`, async () => {
        const a = await runUntilWait(variant);
        let b: Record<string, unknown> | { error: string };
        try {
          b = await resumeFromK(a, variant, repair);
        } catch (error) {
          b = { error: String(error) };
        }
        await record(`${variant.name}-${repair}`, {
          phaseA: { ...a.report, events: a.events, kEntries: a.kEntries.map(summarize) },
          phaseB: b,
        });
        expect(a.events.some((e) => e.ev === "killed")).toBe(true);
      }, 90_000);
    }
  }

  for (const name of ["serial", "parallelWaitFirst"]) {
    test(`${name} / answered after K`, async () => {
      const variant = VARIANTS[name] as Variant;
      const a = await runUntilWait(variant, "answer");
      const afterK = a.events.filter(
        (e) => e.t >= (a.events.find((x) => x.ev === "answer.delivered")?.t ?? 0),
      );
      await record(`${name}-answered`, { phaseA: { ...a.report, events: a.events }, afterK });
      expect(afterK.length).toBeGreaterThan(0);
    }, 90_000);
  }
});

/** Entries whose parentUuid names no entry in the same transcript. */
function brokenParents(entries: ReadonlyArray<Record<string, unknown>>): string[] {
  const uuids = new Set(entries.map((e) => e.uuid).filter((u) => typeof u === "string"));
  return entries
    .filter((e) => typeof e.parentUuid === "string" && !uuids.has(e.parentUuid))
    .map((e) => `${e.type}:${e.uuid} -> ${e.parentUuid}`);
}

/** Transcript lines without the bulk: type, uuid chain, and tool blocks. */
function summarize(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    type: entry.type,
    uuid: entry.uuid,
    parentUuid: entry.parentUuid,
    ...toolIds([entry]),
    text:
      typeof (entry.message as { content?: unknown } | undefined)?.content === "string"
        ? (entry.message as { content: string }).content.slice(0, 80)
        : undefined,
  };
}
