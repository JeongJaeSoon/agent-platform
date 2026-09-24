import { describe, expect, test } from "bun:test";
import type {
  ClaimPrincipal,
  FinalizeRequest,
  FinalizeResponse,
  HeartbeatRequest,
  NextInputRequest,
  ReleaseRequest,
  RuntimeConfig,
} from "@agent-platform/contracts";
import {
  FakeAgentRuntime,
  type FakeStep,
} from "@agent-platform/runtime-claude";
import {
  type AgentRun,
  type CheckpointPreparation,
  type NativeSdkMessage,
  WorkerGatewayRequestError,
} from "@agent-platform/runtime-core";

import { unwiredCheckpoints, type WorkerCheckpointPort } from "./checkpoint.ts";
import { engineProfile } from "./composition.ts";
import type { WorkerTimeouts } from "./config.ts";
import type { EngineExitWatch } from "./engine-processes.ts";
import { FakeWorkerGateway } from "./fake-gateway.ts";
import {
  inputUuid,
  type RuntimeRegistry,
  WorkerHost,
  type WorkerLogger,
} from "./worker-host.ts";
import { noWorkspace, type WorkspacePreparer } from "./workspace.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

const silent: WorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 2,
  claimTimeoutMs: 200,
  drainTimeoutMs: 50,
  heartbeatIntervalMs: 10_000,
  idleTimeoutMs: 60,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 15,
  questionTimeoutMs: 200,
  requestTimeoutMs: 1_000,
  startupTimeoutMs: 60_000,
};

/** The uuid the host derives for the n-th message the fake gateway enqueues. */
function uuidForTurn(turn: number): string {
  return inputUuid(SESSION_ID, String(turn), `msg-${turn}`);
}

function assistantMessage(text: string): NativeSdkMessage {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    session_id: "fake-session",
  };
}

function resultMessage(uuid: string): NativeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: "fake-session",
    is_error: false,
    usage: { input_tokens: 3 },
    user_message_uuid: uuid,
  };
}

function harness(
  steps: FakeStep[],
  overrides: {
    checkpoints?: WorkerCheckpointPort;
    engines?: EngineExitWatch;
    gateway?: FakeWorkerGateway;
    logger?: WorkerLogger;
    /** Input uuids the engine session a resumed run opens already holds. */
    resumedTranscript?: string[];
    sleep?: (ms: number) => Promise<void>;
    timeouts?: Partial<WorkerTimeouts>;
    workspace?: WorkspacePreparer;
    wrap?: (run: AgentRun) => AgentRun;
  } = {},
) {
  const gateway = overrides.gateway ?? new FakeWorkerGateway();
  const runtime = new FakeAgentRuntime(
    steps,
    overrides.resumedTranscript === undefined
      ? {}
      : { resumedTranscript: overrides.resumedTranscript },
  );
  const launched: RuntimeConfig[] = [];
  const budgets: number[] = [];
  const principals: ClaimPrincipal[] = [];
  const claudeMds: Array<string | null> = [];
  const runtimes: RuntimeRegistry = {
    launcherFor: () => ({
      start: ({ runtimeConfig, principal, ...launch }, hooks) => {
        launched.push(runtimeConfig);
        budgets.push(launch.maxBudgetUsd);
        principals.push(principal);
        claudeMds.push(launch.committedClaudeMd());
        const wrap = overrides.wrap ?? ((run: AgentRun) => run);
        return wrap(
          runtime.start(
            {
              claudeConfigDir: "/tmp/fake/config",
              cwd: "/tmp/fake/workspace",
              home: "/tmp/fake/home",
              model: runtimeConfig.model,
              profile: engineProfile(
                runtimeConfig.provider,
                principal.owner_scope,
                "http://egress-proxy.test:3129",
              ),
              tools: runtimeConfig.tools,
              ...launch,
            },
            hooks,
          ),
        );
      },
    }),
  };
  const host = new WorkerHost({
    checkpoints: overrides.checkpoints ?? unwiredCheckpoints,
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger: overrides.logger ?? silent,
    runtimes,
    timeouts: { ...timeouts, ...overrides.timeouts },
    workspace: overrides.workspace ?? noWorkspace,
    ...(overrides.engines === undefined ? {} : { engines: overrides.engines }),
    ...(overrides.sleep === undefined ? {} : { sleep: overrides.sleep }),
  });
  return { budgets, claudeMds, gateway, host, launched, principals, runtime };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let waited = 0; waited < 2_000; waited += 5) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("WorkerHost turn loop", () => {
  test("runs two turns in order and finalizes each one", async () => {
    const { gateway, host, runtime } = harness([
      { type: "await-input" },
      { type: "emit", message: assistantMessage("first answer") },
      { type: "emit", message: resultMessage(uuidForTurn(1)) },
      { type: "await-input" },
      { type: "emit", message: assistantMessage("second answer") },
      { type: "emit", message: resultMessage(uuidForTurn(2)) },
      // A live engine keeps its stream open between turns.
      { type: "await-input" },
    ]);
    gateway.enqueue("first message");
    gateway.enqueue("second message");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
      { turnId: "2", status: "completed", reason: null },
    ]);
    // The launch nonce is only good for the claim; everything after it is
    // signed with the credential the claim issued.
    expect(gateway.credential).toBe("wsc_fake");
    expect(runtime.inputs.map((input) => input.uuid)).toEqual([
      uuidForTurn(1),
      uuidForTurn(2),
    ]);
    expect(runtime.inputs.map((input) => input.message)).toEqual([
      "first message",
      "second message",
    ]);
    expect(gateway.events.map((event) => event.source_sequence)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(gateway.events.map((event) => event.event)).toEqual([
      "assistant",
      "result",
      "assistant",
      "result",
    ]);
    expect(gateway.batches.map((batch) => batch.turn_id)).toEqual([
      "1",
      "1",
      "2",
      "2",
    ]);
    expect(gateway.finalized.map((call) => call.finalize_key)).toEqual([
      "att_fake:1",
      "att_fake:2",
    ]);
    expect(gateway.finalized[0]?.terminal).toMatchObject({
      status: "completed",
      reason: null,
      usage: { input_tokens: 3 },
    });
    // Checkpoints are not wired to this gateway yet (94S-201).
    expect(gateway.finalized[0]?.checkpoint).toBeNull();
    expect(gateway.releases).toHaveLength(1);
  });

  test("makes the turn's events durable before it finalizes", async () => {
    const { gateway, host } = harness([
      { type: "await-input" },
      { type: "emit", message: assistantMessage("only answer") },
      { type: "emit", message: resultMessage(uuidForTurn(1)) },
    ]);
    gateway.enqueue("one message");

    await host.runLoop();

    const finalizeAt = gateway.calls.indexOf("finalize");
    const lastAppendAt = gateway.calls.lastIndexOf("appendEvents");
    expect(finalizeAt).toBeGreaterThan(lastAppendAt);
  });

  test("finalizes at the terminal even when the engine keeps talking after it", async () => {
    const gateway = new FakeWorkerGateway();
    // A slow capture leaves room for a frame to land between the flush and
    // the finalize, which is where a late frame used to move the stream's end.
    const checkpoints: WorkerCheckpointPort = {
      restorePlan: async () => ({ mode: "new" }),
      capture: async () => {
        await Bun.sleep(20);
        return null;
      },
    };
    const { host } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: assistantMessage("answer") },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "delay", delayMs: 5 },
        { type: "emit", message: assistantMessage("after the result") },
        { type: "await-input" },
      ],
      { checkpoints, gateway },
    );
    gateway.enqueue("first message");

    const summary = await host.runLoop();

    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
    const cut = gateway.finalized[0]?.final_source_sequence ?? -1;
    const resultEvent = gateway.events.find(
      (event) => event.event === "result",
    );
    expect(cut).toBe(resultEvent?.source_sequence ?? -2);
    // The late frame is stored, after the finalize, as a session event.
    const late = gateway.batches.find((batch) =>
      batch.events.some((event) => event.source_sequence > cut),
    );
    expect(late?.turn_id).toBeNull();
    expect(gateway.calls.lastIndexOf("appendEvents")).toBeGreaterThan(
      gateway.calls.indexOf("finalize"),
    );
  });

  test("reports a failed engine result as a failed turn", async () => {
    const { gateway, host } = harness([
      { type: "await-input" },
      {
        type: "emit",
        message: {
          type: "result",
          subtype: "error_max_turns",
          session_id: "fake-session",
          is_error: true,
          user_message_uuid: uuidForTurn(1),
        },
      },
    ]);
    gateway.enqueue("one message");

    const summary = await host.runLoop();

    expect(summary.turns).toEqual([
      { turnId: "1", status: "failed", reason: "error_max_turns" },
    ]);
  });

  test("closes a turn the engine attributed to no input as outcome_unknown", async () => {
    const { gateway, host } = harness([
      { type: "await-input" },
      {
        type: "emit",
        message: {
          type: "result",
          subtype: "error_during_execution",
          session_id: "fake-session",
          is_error: true,
        },
      },
    ]);
    gateway.enqueue("one message");

    const summary = await host.runLoop();

    expect(summary.turns[0]?.status).toBe("outcome_unknown");
    expect(gateway.finalized[0]?.terminal.status).toBe("outcome_unknown");
  });

  test("refuses to start when the session needs a checkpoint restored", async () => {
    const gateway = new FakeWorkerGateway({
      restore: {
        revision: 4,
        manifest_ref: "checkpoints/4.json",
        manifest_sha256: "a".repeat(64),
      },
    });
    const { host } = harness([{ type: "await-input" }], { gateway });

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("failed");
    expect(summary.reason).toContain("no restorer bound");
    expect(gateway.finalized).toEqual([]);
  });

  test("leaves cleanly when no session was waiting for it", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.bootstrapClaim = async () => {
      throw new WorkerGatewayRequestError(
        404,
        "NOT_FOUND",
        "No session is waiting in this partition",
        true,
      );
    };
    const { host } = harness([], { gateway, timeouts: { claimTimeoutMs: 10 } });

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("unclaimed");
    expect(gateway.releases).toEqual([]);
  });

  test("leaves at once, unclaimed, when the session waits on an operator instead (94S-288)", async () => {
    const gateway = new FakeWorkerGateway();
    let claims = 0;
    gateway.bootstrapClaim = async () => {
      claims += 1;
      throw new WorkerGatewayRequestError(
        409,
        "RECOVERY_REQUIRED",
        "The session has turns no checkpoint covers; an operator decides how it continues",
        false,
      );
    };
    // A deadline long enough that only the refusal itself can end the loop.
    const { host } = harness([], {
      gateway,
      timeouts: { claimTimeoutMs: 60_000 },
    });

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("unclaimed");
    expect(claims).toBe(1);
    expect(gateway.releases).toEqual([]);
  });

  test("leaves at once, unclaimed, when its session was failed for a catalog mismatch (94S-280)", async () => {
    const gateway = new FakeWorkerGateway();
    let claims = 0;
    gateway.bootstrapClaim = async () => {
      claims += 1;
      throw new WorkerGatewayRequestError(
        409,
        "CATALOG_MISMATCH",
        "The session this launch was reserved for runs as a pair this host's catalog no longer allows",
        false,
      );
    };
    // A claim timeout the test would notice waiting out.
    const { host } = harness([], {
      gateway,
      timeouts: { claimTimeoutMs: 60_000 },
    });

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("unclaimed");
    expect(claims).toBe(1);
    expect(gateway.releases).toEqual([]);
  });
});

describe("WorkerHost approvals", () => {
  test("holds each callback until its own answer arrives", async () => {
    const gateway = new FakeWorkerGateway();
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        {
          type: "permissions",
          requests: [
            {
              input: { command: "ls" },
              requestId: "req-allow",
              tool: "Bash",
              toolUseId: "toolu_allow",
            },
            {
              input: { command: "rm -rf /" },
              requestId: "req-deny",
              tool: "Bash",
              toolUseId: "toolu_deny",
            },
            {
              input: {
                questions: [
                  {
                    header: "where",
                    question: "Which environment?",
                    multiSelect: false,
                    options: [
                      { label: "staging", description: "safe" },
                      { label: "production", description: "not" },
                    ],
                  },
                ],
              },
              requestId: "req-question",
              tool: "AskUserQuestion",
              toolUseId: "toolu_question",
            },
          ],
        },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
      ],
      { gateway },
    );
    gateway.enqueue("do some work");
    const loop = host.runLoop();

    await waitFor(
      () => gateway.questions().length === 3,
      "three question events",
    );
    gateway.answer({
      request_id: gateway.requestIdFor("toolu_allow"),
      kind: "permission",
      decision: "allow",
    });
    gateway.answer({
      request_id: gateway.requestIdFor("toolu_deny"),
      kind: "permission",
      decision: "deny",
      reason: "Not on this workspace",
    });
    gateway.answer({
      request_id: gateway.requestIdFor("toolu_question"),
      kind: "question",
      answers: [{ question_id: "q0", selected_option_ids: ["q0o0"] }],
    });

    const summary = await loop;

    expect(summary.turns[0]?.status).toBe("completed");
    expect(runtime.permissionDecisions).toEqual([
      { behavior: "allow" },
      { behavior: "deny", message: "Not on this workspace" },
      {
        behavior: "allow",
        updatedInput: {
          questions: expect.any(Array),
          answers: { "Which environment?": "staging" },
        },
      },
    ]);
    // Each registration is in the durable stream, ahead of the turn's result.
    const kinds = gateway
      .questions()
      .map((event) => (event.event === "question" ? event.data.kind : null));
    expect(kinds.sort()).toEqual(["permission", "permission", "question"]);
    // Every answer is reported as delivered before the worker lets go.
    expect(gateway.settled.map((item) => item.outcome)).toEqual([
      "answered",
      "answered",
      "answered",
    ]);
    expect(gateway.calls.lastIndexOf("pendingControl")).toBeLessThan(
      gateway.calls.lastIndexOf("release"),
    );
  });

  test("denies a request nobody answered rather than holding the turn open", async () => {
    const gateway = new FakeWorkerGateway();
    // The gateway's expiry, not the worker's own timeout, bounds a request
    // it registered (94S-389).
    const register = gateway.registerPending.bind(gateway);
    gateway.registerPending = async (request) => ({
      ...(await register(request)),
      expires_in_ms: 20,
    });
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        {
          type: "permissions",
          requests: [
            {
              input: { command: "ls" },
              requestId: "req-silent",
              tool: "Bash",
              toolUseId: "toolu_silent",
            },
          ],
        },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
      ],
      { gateway },
    );
    gateway.enqueue("do some work");

    const summary = await host.runLoop();

    expect(runtime.permissionDecisions[0]?.behavior).toBe("deny");
    expect(summary.turns[0]?.status).toBe("completed");
  });
});

describe("WorkerHost ownership and shutdown", () => {
  test("stops writing and exits without finalizing once the lease is gone", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.heartbeatFailure = "LEASE_EXPIRED";
    const { host, runtime } = harness(
      [{ type: "await-input" }, { type: "delay", delayMs: 5_000 }],
      { gateway, timeouts: { heartbeatIntervalMs: 5 } },
    );
    gateway.enqueue("a turn that will outlive its lease");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("lease_lost");
    expect(summary.reason).toContain("LEASE_EXPIRED");
    // The order the ticket asks for: the turn was accepted, the heartbeat
    // failed, and nothing durable followed.
    expect(gateway.calls).toContain("nextInput");
    expect(gateway.calls).toContain("heartbeat");
    expect(gateway.finalized).toEqual([]);
    expect(gateway.releases).toEqual([]);
    expect(runtime.inputs).toHaveLength(1);
    // The engine was interrupted rather than left running behind the process.
    expect(gateway.calls.lastIndexOf("appendEvents")).toBeLessThan(
      gateway.calls.lastIndexOf("heartbeat"),
    );
  });

  // 94S-321: an operator's execution revocation revokes the token, so the
  // beat that follows is refused before it reaches any fence.
  test("stops the running turn without finalizing once its token is revoked", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.heartbeatFailure = "UNAUTHORIZED";
    const { host, runtime } = harness(
      [{ type: "await-input" }, { type: "delay", delayMs: 5_000 }],
      { gateway, timeouts: { heartbeatIntervalMs: 5 } },
    );
    gateway.enqueue("a turn whose execution authority is revoked");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("lease_lost");
    expect(summary.reason).toContain("UNAUTHORIZED");
    expect(gateway.finalized).toEqual([]);
    expect(gateway.releases).toEqual([]);
    expect(runtime.inputs).toHaveLength(1);
  });

  test("waits for the engine process to exit, and kills one that lingers", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.heartbeatFailure = "LEASE_EXPIRED";
    const trail: string[] = [];
    const recording: WorkerLogger = {
      info: (event) => trail.push(event),
      warn: (event) => trail.push(event),
      error: (event) => trail.push(event),
    };
    let alive = true;
    const engines: EngineExitWatch = {
      async exited() {
        trail.push(`exited? ${!alive}`);
        return !alive;
      },
      get running() {
        return alive ? [4242] : [];
      },
      kill() {
        trail.push("kill");
        alive = false;
      },
    };
    const { host } = harness(
      [{ type: "await-input" }, { type: "delay", delayMs: 5_000 }],
      {
        engines,
        gateway,
        logger: recording,
        timeouts: { heartbeatIntervalMs: 5 },
      },
    );
    gateway.enqueue("a turn that will outlive its lease");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("lease_lost");
    expect(trail.slice(trail.indexOf("worker.stopping"))).toEqual([
      "worker.stopping",
      "exited? false",
      "worker.engine.lingering",
      "kill",
      "exited? true",
      "worker.engine.killed",
      "worker.ownership.lost",
    ]);
    expect(gateway.finalized).toEqual([]);
  });

  test("kills the engine at once when the lease is lost, with no grace", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.heartbeatFailure = "LEASE_EXPIRED";
    const waits: number[] = [];
    let alive = true;
    const engines: EngineExitWatch = {
      async exited(timeoutMs) {
        waits.push(timeoutMs);
        return !alive;
      },
      get running() {
        return alive ? [4242] : [];
      },
      kill() {
        alive = false;
      },
    };
    const { host } = harness(
      [{ type: "await-input" }, { type: "delay", delayMs: 5_000 }],
      { engines, gateway, timeouts: { heartbeatIntervalMs: 5 } },
    );
    gateway.enqueue("a turn that will outlive its lease");
    const started = Date.now();

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("lease_lost");
    expect(waits[0]).toBe(0);
    // Not the interrupt grace, the stream grace and the exit grace in turn.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("cuts shutdown waits to what the stop grace has left", async () => {
    const gateway = new FakeWorkerGateway();
    const waits: number[] = [];
    const engines: EngineExitWatch = {
      async exited(timeoutMs) {
        waits.push(timeoutMs);
        return true;
      },
      running: [],
      kill() {},
    };
    const { host } = harness([{ type: "await-input" }], {
      engines,
      gateway,
      timeouts: {
        drainTimeoutMs: 0,
        idleTimeoutMs: 60_000,
        stopGraceMs: 2_500,
      },
    });
    const loop = host.runLoop();
    await waitFor(() => gateway.calls.includes("nextInput"), "the first poll");
    host.drain("received SIGTERM");

    await loop;

    // 2.5 s of grace, 2 s of it kept for the release: nowhere near the 5 s
    // an engine gets when nothing is counting down.
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeLessThanOrEqual(500);
    expect(gateway.releases).toHaveLength(1);
  });

  test("takes no new checkpoint when an idle worker is told to stop", async () => {
    const gateway = new FakeWorkerGateway();
    let captures = 0;
    const checkpoints: WorkerCheckpointPort = {
      restorePlan: async () => ({ mode: "new" }),
      capture: async () => {
        captures += 1;
        return null;
      },
    };
    const { host } = harness([{ type: "await-input" }], {
      checkpoints,
      gateway,
      timeouts: { idleTimeoutMs: 60_000 },
    });
    const loop = host.runLoop();
    await waitFor(() => gateway.calls.includes("nextInput"), "the first poll");
    host.drain("received SIGTERM");

    const summary = await loop;

    expect(summary.outcome).toBe("drained");
    expect(captures).toBe(0);
    expect(gateway.releases).toHaveLength(1);
  });

  test("keeps beating while the shutdown flushes the event tail, until the release (94S-392)", async () => {
    class StalledAppend extends FakeWorkerGateway {
      override appendEvents(): Promise<never> {
        this.calls.push("appendEvents");
        return new Promise(() => {});
      }
    }
    const gateway = new StalledAppend();
    const { host } = harness(
      [
        { type: "emit", message: assistantMessage("before any input") },
        { type: "await-input" },
      ],
      {
        gateway,
        timeouts: {
          drainTimeoutMs: 300,
          heartbeatIntervalMs: 5,
          idleTimeoutMs: 60_000,
        },
      },
    );
    const loop = host.runLoop();
    await waitFor(() => gateway.calls.includes("appendEvents"), "the tail");
    await waitFor(() => gateway.calls.includes("nextInput"), "the first poll");
    host.drain("received SIGTERM");
    const drainedAt = gateway.calls.length;

    await loop;

    const released = gateway.calls.indexOf("release");
    expect(released).toBeGreaterThan(drainedAt);
    // The flush waits out the drain budget on a gateway that never stores
    // the tail; the lease is renewed all the way through it.
    const beatsWhileFlushing = gateway.calls
      .slice(drainedAt, released)
      .filter((call) => call === "heartbeat").length;
    expect(beatsWhileFlushing).toBeGreaterThan(5);
    expect(gateway.calls.slice(released)).not.toContain("heartbeat");
  });

  test("drains on request: finishes the turn in flight, then releases", async () => {
    const gateway = new FakeWorkerGateway();
    const { host } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(2)) },
      ],
      { gateway, timeouts: { drainTimeoutMs: 2_000, idleTimeoutMs: 60_000 } },
    );
    gateway.enqueue("first message");
    const loop = host.runLoop();

    await waitFor(() => gateway.finalized.length === 1, "the first finalize");
    host.drain("received SIGTERM");
    // The gateway hears about the drain at once, not at the next beat.
    await waitFor(
      () =>
        gateway.heartbeats.some((beat) => beat.attempt_state === "draining"),
      "the draining heartbeat",
    );
    gateway.enqueue("second message");

    const summary = await loop;

    expect(summary.outcome).toBe("drained");
    expect(summary.reason).toBe("received SIGTERM");
    // The second message was never started: draining stops new input.
    expect(gateway.finalized).toHaveLength(1);
    expect(gateway.releases[0]?.reason).toBe("received SIGTERM");
    expect(gateway.calls.indexOf("release")).toBeGreaterThan(
      gateway.calls.lastIndexOf("finalize"),
    );
  });

  test("finishes an input the gateway handed over as the drain began", async () => {
    const gateway = new FakeWorkerGateway();
    const { host } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      { gateway, timeouts: { drainTimeoutMs: 2_000, idleTimeoutMs: 60_000 } },
    );
    // The poll in flight read the queue before the drain reached the
    // gateway: the turn is this attempt's now, and dropping it would leave it
    // open for the reconciler.
    gateway.refuseDraining = false;
    const loop = host.runLoop();
    await waitFor(() => gateway.calls.includes("nextInput"), "the first poll");
    host.drain("received SIGTERM");
    gateway.enqueue("first message");

    const summary = await loop;

    expect(summary.outcome).toBe("drained");
    expect(gateway.finalized.map((request) => request.turn_id)).toEqual(["1"]);
    expect(gateway.calls.indexOf("release")).toBeGreaterThan(
      gateway.calls.lastIndexOf("nextInput"),
    );
  });

  test("gives up a turn that outlasts the drain budget without finalizing it", async () => {
    const gateway = new FakeWorkerGateway();
    const { host, runtime } = harness(
      [{ type: "await-input" }, { type: "delay", delayMs: 5_000 }],
      { gateway, timeouts: { drainTimeoutMs: 20 } },
    );
    gateway.enqueue("a turn that will not finish");
    const loop = host.runLoop();

    await waitFor(() => runtime.inputs.length === 1, "the input to be sent");
    host.drain("received SIGTERM");

    const summary = await loop;

    expect(summary.outcome).toBe("drained");
    // Nothing is finalized: an infrastructure stop leaves the turn retryable.
    expect(gateway.finalized).toEqual([]);
    expect(gateway.releases).toHaveLength(1);
  });

  test("takes no further input once the engine stream has ended", async () => {
    const gateway = new FakeWorkerGateway();
    // The fake's stream ends after its last step, the way an engine that
    // crashed would: nothing will ever answer an input sent after it.
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
      ],
      { gateway },
    );
    gateway.enqueue("first message");
    gateway.enqueue("second message");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("failed");
    expect(summary.reason).toBe("The engine stream ended");
    expect(runtime.inputs).toHaveLength(1);
    expect(gateway.finalized).toHaveLength(1);
    expect(gateway.releases).toHaveLength(1);
  });

  test("stops at once when an event write says the lease is gone", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.appendFailure = new WorkerGatewayRequestError(
      409,
      "LEASE_EXPIRED",
      "Lease expired; the attempt must stop writing",
      false,
    );
    const { host } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: assistantMessage("working") },
        { type: "delay", delayMs: 5_000 },
      ],
      { gateway },
    );
    gateway.enqueue("a turn whose events are fenced out");
    const started = Date.now();

    const summary = await host.runLoop();

    // Not the heartbeat (10s away) and not the end of the turn (5s away).
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(summary.outcome).toBe("lease_lost");
    expect(summary.reason).toContain("Lease expired");
    expect(gateway.finalized).toEqual([]);
    expect(gateway.releases).toEqual([]);
  });

  test("gives up events the gateway keeps refusing once the drain budget is spent", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.appendFailure = new WorkerGatewayRequestError(
      503,
      null,
      "gateway unavailable",
      true,
    );
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: assistantMessage("done") },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      { gateway, timeouts: { drainTimeoutMs: 30 } },
    );
    gateway.enqueue("a turn whose events never land");
    const loop = host.runLoop();

    await waitFor(() => runtime.inputs.length === 1, "the input to be sent");
    await waitFor(
      () => gateway.calls.includes("appendEvents"),
      "the first refused append",
    );
    host.drain("received SIGTERM");
    const started = Date.now();

    const summary = await loop;

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(summary.outcome).toBe("drained");
    // A turn whose events are not durable is never declared over.
    expect(gateway.finalized).toEqual([]);
    expect(gateway.releases).toHaveLength(1);
  });

  test("releases the session when it has been idle for long enough", async () => {
    const gateway = new FakeWorkerGateway();
    const { host } = harness([{ type: "await-input" }], {
      gateway,
      timeouts: { idleTimeoutMs: 20 },
    });

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    expect(summary.reason).toContain("No input");
    expect(gateway.releases).toHaveLength(1);
  });
});

describe("WorkerHost cost and provider failures (94S-131)", () => {
  test("finalizes each turn with its share of the engine's running total", async () => {
    const { gateway, host } = harness([
      { type: "await-input" },
      {
        type: "emit",
        message: { ...resultMessage(uuidForTurn(1)), total_cost_usd: 0.5 },
      },
      { type: "await-input" },
      {
        type: "emit",
        message: { ...resultMessage(uuidForTurn(2)), total_cost_usd: 1.25 },
      },
      { type: "await-input" },
    ]);
    gateway.enqueue("first message");
    gateway.enqueue("second message");

    await host.runLoop();

    expect(gateway.finalized.map((call) => call.terminal.cost_usd)).toEqual([
      0.5, 0.75,
    ]);
  });

  test("a turn the engine gave no total for finalizes with no cost, not zero (94S-275)", async () => {
    const { gateway, host } = harness([
      { type: "await-input" },
      { type: "emit", message: resultMessage(uuidForTurn(1)) },
      { type: "await-input" },
    ]);
    gateway.enqueue("one message");

    await host.runLoop();

    expect(gateway.finalized).toHaveLength(1);
    expect(gateway.finalized[0]?.terminal.cost_usd).toBeNull();
  });

  test("reports a runaway total at the protocol's ceiling instead of a terminal the gateway refuses", async () => {
    const { gateway, host } = harness([
      { type: "await-input" },
      {
        type: "emit",
        message: { ...resultMessage(uuidForTurn(1)), total_cost_usd: 5e6 },
      },
      { type: "await-input" },
    ]);
    gateway.enqueue("one message");

    await host.runLoop();

    expect(gateway.finalized[0]?.terminal.cost_usd).toBe(1_000_000);
  });

  test("a provider that kept refusing fails the turn as api_error with what it answered", async () => {
    const { gateway, host } = harness([
      { type: "await-input" },
      {
        type: "emit",
        message: {
          type: "system",
          subtype: "api_retry",
          error: "server_error",
          error_status: 503,
          session_id: "fake-session",
        },
      },
      {
        type: "emit",
        message: {
          ...assistantMessage("API Error: 500"),
          error: "server_error",
        },
      },
      {
        type: "emit",
        message: {
          ...resultMessage(uuidForTurn(1)),
          is_error: true,
          terminal_reason: "api_error",
          api_error_status: 500,
          total_cost_usd: 0,
        },
      },
    ]);
    gateway.enqueue("one message");

    const summary = await host.runLoop();

    expect(summary.turns).toEqual([
      { turnId: "1", status: "failed", reason: "api_error" },
    ]);
    expect(gateway.finalized[0]?.terminal).toMatchObject({
      status: "failed",
      reason: "api_error",
      cost_usd: 0,
      result: {
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 500,
        provider_error: "server_error",
        last_retry_status: 503,
      },
    });
  });

  test("a turn the engine ended on its budget fails as budget_exceeded, with its cost and its checkpoint (94S-279)", async () => {
    const gateway = new FakeWorkerGateway({ remainingBudgetUsd: 4.5 });
    const { budgets, host } = harness(
      [
        { type: "await-input" },
        {
          type: "emit",
          message: {
            ...resultMessage(uuidForTurn(1)),
            subtype: "error_max_budget_usd",
            is_error: true,
            total_cost_usd: 4.75,
          },
        },
        { type: "await-input" },
      ],
      {
        gateway,
        checkpoints: {
          restorePlan: async () => ({ mode: "new" }),
          capture: async (preparation) =>
            preparation.status === "ready"
              ? {
                  revision: 0,
                  manifest_ref: "checkpoints/0.json",
                  manifest_sha256: "a".repeat(64),
                }
              : null,
        },
      },
    );
    gateway.enqueue("a turn that loops on tools");

    const summary = await host.runLoop();

    // The engine was given what the claim said the session had left.
    expect(budgets).toEqual([4.5]);
    expect(summary.turns).toEqual([
      { turnId: "1", status: "failed", reason: "budget_exceeded" },
    ]);
    expect(gateway.finalized).toHaveLength(1);
    expect(gateway.finalized[0]).toMatchObject({
      terminal: {
        status: "failed",
        reason: "budget_exceeded",
        cost_usd: 4.75,
        result: { subtype: "error_max_budget_usd", is_error: true },
      },
      checkpoint: { revision: 0, manifest_ref: "checkpoints/0.json" },
    });
  });

  test("an engine that started its cost count over finishes the turn and drains (94S-279)", async () => {
    const gateway = new FakeWorkerGateway();
    const { host } = harness(
      [
        { type: "await-input" },
        {
          type: "emit",
          message: { ...resultMessage(uuidForTurn(1)), total_cost_usd: 3 },
        },
        { type: "await-input" },
        // What `/clear` answers: a new engine session that has spent nothing.
        {
          type: "emit",
          message: {
            ...resultMessage(uuidForTurn(2)),
            session_id: "after-clear",
            total_cost_usd: 0,
          },
        },
        { type: "await-input" },
      ],
      { gateway, timeouts: { idleTimeoutMs: 60_000 } },
    );
    gateway.enqueue("spend something");
    gateway.enqueue("/clear");
    gateway.enqueue("a loop the old budget would no longer bound");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("drained");
    expect(summary.reason).toContain("cost count over");
    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
      { turnId: "2", status: "completed", reason: null },
    ]);
    expect(gateway.finalized.map((call) => call.terminal.cost_usd)).toEqual([
      3, 0,
    ]);
    expect(gateway.releases).toHaveLength(1);
  });

  test("gives the slot back as soon as the gateway says the budget is spent", async () => {
    const gateway = new FakeWorkerGateway();
    const { host } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      { gateway, timeouts: { idleTimeoutMs: 60_000 } },
    );
    gateway.enqueue("one message");

    const running = host.runLoop();
    await waitFor(() => gateway.finalized.length === 1, "the first finalize");
    gateway.overBudget = true;
    const summary = await running;

    expect(summary.outcome).toBe("idle");
    expect(summary.reason).toContain("BUDGET_EXCEEDED");
    expect(gateway.releases).toHaveLength(1);
  });
});

describe("inputUuid", () => {
  test("is stable for one delivered input and distinct across inputs", () => {
    const first = inputUuid(SESSION_ID, "1", "msg-1");
    expect(inputUuid(SESSION_ID, "1", "msg-1")).toBe(first);
    expect(inputUuid(SESSION_ID, "2", "msg-1")).not.toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("WorkerHost before the engine starts", () => {
  test("runs the engine the claim resolved, not one of its own", async () => {
    const gateway = new FakeWorkerGateway({
      ownerScope: "owner-b",
      runtimeConfig: {
        model: "claimed-model",
        tools: ["Read"],
        permission_mode: "plan",
        provider: {
          kind: "litellm",
          endpoint: "http://litellm.internal:4000",
          auth: { kind: "egress_token", token: "claimed" },
        },
      },
    });
    const { host, launched, principals } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      { gateway },
    );
    gateway.enqueue("hello");

    await host.runLoop();

    // The checkpoint principal is the claim's owner, never a worker default.
    expect(principals).toEqual([{ owner_scope: "owner-b" }]);
    expect(launched).toEqual([
      {
        model: "claimed-model",
        tools: ["Read"],
        permission_mode: "plan",
        provider: {
          kind: "litellm",
          endpoint: "http://litellm.internal:4000",
          auth: { kind: "egress_token", token: "claimed" },
        },
      },
    ]);
  });

  test("prepares the claimed workspace before the engine starts, and never logs its URL", async () => {
    const order: string[] = [];
    const logged: string[] = [];
    const gateway = new FakeWorkerGateway();
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      {
        gateway,
        logger: {
          info: (event, fields) => logged.push(event, JSON.stringify(fields)),
          warn: (event, fields) => logged.push(event, JSON.stringify(fields)),
          error: (event, fields) => logged.push(event, JSON.stringify(fields)),
        },
        workspace: {
          committedClaudeMd: () => null,
          instructionsCommit: () => null,
          async prepare({ descriptor }) {
            order.push(`prepare ${descriptor.repository.branch}`);
            expect(runtime.inputs).toHaveLength(0);
            return "clone";
          },
        },
      },
    );
    gateway.enqueue("hello");

    await host.runLoop();

    expect(order).toEqual(["prepare main"]);
    expect(logged).toContain("worker.workspace.prepared");
    expect(logged.join("\n")).not.toContain("git.example.test");
  });

  test("a failure that quotes the claim's secrets reaches the log without them (94S-386)", async () => {
    const providerValue = "wep_provider-log-one";
    const repositoryValue = "wep_repository-log-one";
    const gateway = new FakeWorkerGateway({
      runtimeConfig: {
        model: "fake-model",
        tools: [],
        permission_mode: "default",
        provider: {
          kind: "anthropic",
          endpoint: "https://api.anthropic.com",
          auth: { kind: "egress_token", token: providerValue },
        },
      },
      workspace: {
        repository: {
          id: "sample-app",
          url: "https://git.example.test/sample.git",
          branch: "main",
          access: { kind: "egress_token", token: repositoryValue },
        },
      },
    });
    const logged: string[] = [];
    const { host } = harness([{ type: "await-input" }], {
      gateway,
      logger: {
        info: (event, fields) => logged.push(event, JSON.stringify(fields)),
        warn: (event, fields) => logged.push(event, JSON.stringify(fields)),
        error: (event, fields) => logged.push(event, JSON.stringify(fields)),
      },
      workspace: {
        committedClaudeMd: () => null,
        instructionsCommit: () => null,
        async prepare() {
          throw new Error(
            `clone of ${repositoryValue} failed; provider ${providerValue}, nonce wln_test`,
          );
        },
      },
    });

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("failed");
    const text = logged.join("\n");
    expect(text).toContain("worker.failed");
    expect(text).toContain("<redacted>");
    for (const held of [providerValue, repositoryValue, "wln_test"]) {
      expect(text).not.toContain(held);
    }
  });

  test("gives the session back without starting an engine when the workspace is refused", async () => {
    const gateway = new FakeWorkerGateway();
    const { host, launched } = harness([{ type: "await-input" }], {
      gateway,
      workspace: {
        committedClaudeMd: () => null,
        instructionsCommit: () => null,
        async prepare() {
          throw new Error("Workspace /workspace refused: not a git checkout");
        },
      },
    });

    const summary = await host.runLoop();

    expect(summary).toMatchObject({ outcome: "failed", turns: [] });
    expect(summary.reason).toContain("refused");
    expect(launched).toEqual([]);
    expect(gateway.finalized).toEqual([]);
    expect(gateway.releases).toHaveLength(1);
    // A failure: the session counts it against its startups (94S-302).
    expect(gateway.releases[0]).not.toHaveProperty("stop_kind");
  });

  test("a drain during preparation aborts it and releases, with no engine", async () => {
    const gateway = new FakeWorkerGateway();
    let aborted = false;
    let started!: () => void;
    const preparing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { host, launched } = harness([{ type: "await-input" }], {
      gateway,
      workspace: {
        committedClaudeMd: () => null,
        instructionsCommit: () => null,
        prepare: ({ signal }) =>
          new Promise((_, reject) => {
            started();
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(signal.reason);
            });
          }),
      },
    });
    const loop = host.runLoop();
    await preparing;

    host.drain("received SIGTERM");
    const summary = await loop;

    expect(aborted).toBe(true);
    expect(summary.outcome).toBe("drained");
    expect(launched).toEqual([]);
    expect(gateway.releases).toHaveLength(1);
    // Asked to stop, not failed: not a failed startup (94S-302).
    expect(gateway.releases[0]).toMatchObject({
      reason: "received SIGTERM",
      stop_kind: "drain",
    });
  });

  test("a gateway older than stop_kind still gets the drained session back", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.predatesStopKind = true;
    let started!: () => void;
    const preparing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { host } = harness([{ type: "await-input" }], {
      gateway,
      workspace: {
        committedClaudeMd: () => null,
        instructionsCommit: () => null,
        prepare: ({ signal }) =>
          new Promise((_, reject) => {
            started();
            signal.addEventListener("abort", () => reject(signal.reason));
          }),
      },
    });
    const loop = host.runLoop();
    await preparing;

    host.drain("received SIGTERM");
    const summary = await loop;

    expect(summary.outcome).toBe("drained");
    // The strict gateway refused the field it does not know; the release
    // without it is the one it kept (94S-361).
    expect(gateway.releases).toHaveLength(2);
    expect(gateway.releases[0]).toMatchObject({ stop_kind: "drain" });
    expect(gateway.releases[1]).toMatchObject({ reason: "received SIGTERM" });
    expect(gateway.releases[1]).not.toHaveProperty("stop_kind");
  });
});

describe("WorkerHost shutdown with a wedged engine", () => {
  test("does not wait on an interrupt that never answers", async () => {
    const gateway = new FakeWorkerGateway();
    const { host, runtime } = harness(
      [{ type: "await-input" }, { type: "delay", delayMs: 30_000 }],
      {
        gateway,
        timeouts: { drainTimeoutMs: 20, stopGraceMs: 2_500 },
        wrap: (run) =>
          new Proxy(run, {
            get(target, property) {
              if (property === "interrupt") return () => new Promise(() => {});
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
      },
    );
    gateway.enqueue("a turn the engine will sit on");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "the input to be sent");
    const began = Date.now();

    host.drain("received SIGTERM");
    const summary = await loop;

    expect(summary.outcome).toBe("drained");
    expect(gateway.releases).toHaveLength(1);
    // The grace minus the release reserve, not the interrupt's forever.
    expect(Date.now() - began).toBeLessThan(2_500);
  }, 10_000);
});

describe("WorkerHost outcomes a drain must not hide", () => {
  function recording() {
    const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const logger: WorkerLogger = {
      info: (event, fields = {}) => lines.push({ event, fields }),
      warn: (event, fields = {}) => lines.push({ event, fields }),
      error: (event, fields = {}) => lines.push({ event, fields }),
    };
    return { lines, logger };
  }

  test("a finalize refused during the drain reports a failure", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.finalizeFailure = new WorkerGatewayRequestError(
      409,
      "REVISION_CONFLICT",
      "the stream moved",
      false,
    );
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "delay", delayMs: 30 },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      { gateway, timeouts: { drainTimeoutMs: 2_000 } },
    );
    gateway.enqueue("a turn that finishes during the drain");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "the input to be sent");

    host.drain("received SIGTERM");
    const summary = await loop;

    expect(summary.outcome).toBe("failed");
    expect(summary.reason).toContain("the stream moved");
  });

  test("events refused during the drain report a failure", async () => {
    const gateway = new FakeWorkerGateway();
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "delay", delayMs: 30 },
        { type: "emit", message: assistantMessage("written after the stop") },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      { gateway, timeouts: { drainTimeoutMs: 2_000 } },
    );
    gateway.enqueue("a turn whose tail cannot be stored");
    const loop = host.runLoop();
    await waitFor(() => runtime.inputs.length === 1, "the input to be sent");

    host.drain("received SIGTERM");
    gateway.appendFailure = new WorkerGatewayRequestError(
      400,
      "BAD_REQUEST",
      "not storable",
      false,
    );
    const summary = await loop;

    expect(summary.outcome).toBe("failed");
    expect(gateway.finalized).toEqual([]);
  });

  describe("checkpoint lease (94S-208)", () => {
    const committed: WorkerCheckpointPort = {
      restorePlan: async () => ({ mode: "new" }),
      capture: async (preparation) =>
        preparation.status === "ready"
          ? {
              revision: 0,
              manifest_ref: "checkpoints/0.json",
              manifest_sha256: "a".repeat(64),
            }
          : null,
    };
    const oneTurn = [
      { type: "await-input" as const },
      { type: "emit" as const, message: resultMessage(uuidForTurn(1)) },
      { type: "await-input" as const },
    ];

    test("is held from the verdict until the finalize carrying the checkpoint answers", async () => {
      let run: AgentRun | undefined;
      const during: CheckpointPreparation[] = [];
      class Observing extends FakeWorkerGateway {
        override async finalize(
          request: FinalizeRequest,
        ): Promise<FinalizeResponse> {
          if (run !== undefined) during.push(await run.prepareCheckpoint());
          return super.finalize(request);
        }
      }
      const gateway = new Observing();
      const { host } = harness(oneTurn, {
        checkpoints: committed,
        gateway,
        wrap: (started) => {
          run = started;
          return started;
        },
      });
      gateway.enqueue("a turn that checkpoints");

      const summary = await host.runLoop();

      expect(summary.turns).toEqual([
        { turnId: "1", status: "completed", reason: null },
      ]);
      expect(gateway.finalized[0]?.checkpoint?.revision).toBe(0);
      expect(during).toEqual([
        {
          status: "rejected",
          reason: "checkpoint_lease_held",
          detail: "Another checkpoint holds the lease",
        },
      ]);
      expect(await run?.prepareCheckpoint()).not.toMatchObject({
        reason: "checkpoint_lease_held",
      });
    });

    test("outlives a finalize the host stopped waiting for, until it answers", async () => {
      let run: AgentRun | undefined;
      let host: WorkerHost | undefined;
      const answer = Promise.withResolvers<void>();
      class Late extends FakeWorkerGateway {
        override async finalize(
          request: FinalizeRequest,
        ): Promise<FinalizeResponse> {
          // The drain budget runs out while this request is still out.
          host?.drain("received SIGTERM");
          await answer.promise;
          return super.finalize(request);
        }
      }
      const gateway = new Late();
      const built = harness(oneTurn, {
        checkpoints: committed,
        gateway,
        wrap: (started) => {
          run = started;
          return started;
        },
      });
      host = built.host;
      gateway.enqueue("a turn whose finalize outlasts the drain");

      await built.host.runLoop();

      // Given up on, not answered: a CAS could still land, so no writer may
      // start before it does.
      expect(await run?.prepareCheckpoint()).toMatchObject({
        reason: "checkpoint_lease_held",
      });
      answer.resolve();
      await waitFor(() => gateway.finalized.length === 1, "the late finalize");
      await Bun.sleep(1);
      expect(await run?.prepareCheckpoint()).not.toMatchObject({
        reason: "checkpoint_lease_held",
      });
    });

    test("stays held when the finalize fails without an answer that decides it", async () => {
      let run: AgentRun | undefined;
      let host: WorkerHost | undefined;
      let failed = false;
      class Unanswered extends FakeWorkerGateway {
        override async finalize(): Promise<FinalizeResponse> {
          host?.drain("received SIGTERM");
          // Past the drain budget, so the retry gives up; the server may
          // still be committing what this request carried.
          await Bun.sleep(timeouts.drainTimeoutMs * 2);
          failed = true;
          throw new WorkerGatewayRequestError(
            0,
            null,
            "POST /finalize did not reach the gateway: timed out",
            true,
          );
        }
      }
      const gateway = new Unanswered();
      const built = harness(oneTurn, {
        checkpoints: committed,
        gateway,
        wrap: (started) => {
          run = started;
          return started;
        },
      });
      host = built.host;
      gateway.enqueue("a turn whose finalize never answers");

      await built.host.runLoop();
      await waitFor(() => failed, "the finalize to fail");
      await Bun.sleep(5);

      expect(await run?.prepareCheckpoint()).toMatchObject({
        reason: "checkpoint_lease_held",
      });
    });

    test("stays held when a retry is refused after an earlier attempt went unanswered", async () => {
      let run: AgentRun | undefined;
      let calls = 0;
      class TimedOutThenRefused extends FakeWorkerGateway {
        override async finalize(): Promise<FinalizeResponse> {
          calls += 1;
          if (calls === 1) {
            // The server may still be verifying and committing this one.
            throw new WorkerGatewayRequestError(
              0,
              null,
              "POST /finalize did not reach the gateway: timed out",
              true,
            );
          }
          throw new WorkerGatewayRequestError(
            409,
            "CHECKPOINT_UNAVAILABLE",
            "Checkpoint manifest rejected: verifier unavailable",
            false,
          );
        }
      }
      const gateway = new TimedOutThenRefused();
      const { host } = harness(oneTurn, {
        checkpoints: committed,
        gateway,
        wrap: (started) => {
          run = started;
          return started;
        },
      });
      gateway.enqueue("a turn whose first finalize times out");

      await host.runLoop();
      await Bun.sleep(5);

      expect(calls).toBe(2);
      // The refusal answers the retry, not the request that timed out.
      expect(await run?.prepareCheckpoint()).toMatchObject({
        reason: "checkpoint_lease_held",
      });
    });

    test("is released when the gateway refuses the finalize outright", async () => {
      let run: AgentRun | undefined;
      const gateway = new FakeWorkerGateway();
      gateway.finalizeFailure = new WorkerGatewayRequestError(
        409,
        "CHECKPOINT_UNAVAILABLE",
        "Checkpoint manifest rejected: digest mismatch",
        false,
      );
      const { host } = harness(oneTurn, {
        checkpoints: committed,
        gateway,
        wrap: (started) => {
          run = started;
          return started;
        },
      });
      gateway.enqueue("a turn whose checkpoint the gateway refuses");

      await host.runLoop();
      await Bun.sleep(1);

      expect(await run?.prepareCheckpoint()).not.toMatchObject({
        reason: "checkpoint_lease_held",
      });
    });

    test("is given back at once when there is nothing to commit", async () => {
      let run: AgentRun | undefined;
      const during: CheckpointPreparation[] = [];
      class Observing extends FakeWorkerGateway {
        override async finalize(
          request: FinalizeRequest,
        ): Promise<FinalizeResponse> {
          if (run !== undefined) during.push(await run.prepareCheckpoint());
          return super.finalize(request);
        }
      }
      const gateway = new Observing();
      const { host } = harness(oneTurn, {
        gateway,
        wrap: (started) => {
          run = started;
          return started;
        },
      });
      gateway.enqueue("a turn the unwired port captures nothing for");

      await host.runLoop();

      expect(gateway.finalized[0]?.checkpoint).toBeNull();
      expect(during[0]?.status).toBe("ready");
    });

    test("a run that is not quiescent finalizes without a checkpoint", async () => {
      const { gateway, host } = harness(
        [
          { type: "await-input" },
          {
            type: "emit",
            message: {
              type: "system",
              subtype: "background_tasks_changed",
              tasks: [{ task_id: "bash_1", task_type: "local_bash" }],
            },
          },
          { type: "emit", message: resultMessage(uuidForTurn(1)) },
          { type: "await-input" },
        ],
        { checkpoints: committed },
      );
      gateway.enqueue("start a dev server in the background");

      const summary = await host.runLoop();

      expect(summary.turns).toEqual([
        { turnId: "1", status: "completed", reason: null },
      ]);
      // The previous generation stays the one to resume from.
      expect(gateway.finalized[0]?.checkpoint).toBeNull();
    });
  });

  test("a lease lost while the checkpoint is captured is never finalized", async () => {
    const gateway = new FakeWorkerGateway();
    let host: WorkerHost | undefined;
    const checkpoints: WorkerCheckpointPort = {
      restorePlan: async () => ({ mode: "new" }),
      capture: async () => {
        // A stop beats at once, and that beat learns the lease is gone.
        gateway.heartbeatFailure = "LEASE_EXPIRED";
        const before = gateway.heartbeats.length;
        host?.drain("received SIGTERM");
        await waitFor(
          () => gateway.heartbeats.length > before,
          "the beat that finds the lease gone",
        );
        await Bun.sleep(5);
        return null;
      },
    };
    const built = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      { checkpoints, gateway },
    );
    host = built.host;
    gateway.enqueue("a turn whose lease runs out at the end");

    const summary = await built.host.runLoop();

    expect(summary.outcome).toBe("lease_lost");
    // Not even attempted: the write would land on a lease this attempt lost.
    expect(gateway.calls).not.toContain("finalize");
  });

  test("a poll that comes back after the release is not a lease loss", async () => {
    let releaseCalled!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseCalled = resolve;
    });
    class StalePoll extends FakeWorkerGateway {
      override async nextInput(): Promise<never> {
        await released;
        throw new WorkerGatewayRequestError(
          409,
          "STALE_EPOCH",
          "the session was given back",
          false,
        );
      }
      override async release(
        request: Parameters<FakeWorkerGateway["release"]>[0],
      ) {
        const response = await super.release(request);
        releaseCalled();
        await Bun.sleep(5);
        return response;
      }
    }
    const gateway = new StalePoll();
    const { lines, logger } = recording();
    const { host } = harness([{ type: "await-input" }], {
      gateway,
      logger,
      timeouts: { drainTimeoutMs: 20 },
    });
    const loop = host.runLoop();
    await waitFor(() => gateway.calls.includes("bootstrapClaim"), "the claim");
    await Bun.sleep(5);

    host.drain("received SIGTERM");
    const summary = await loop;
    await Bun.sleep(10);

    expect(summary.outcome).toBe("drained");
    expect(
      lines.filter(
        (line) =>
          line.event === "worker.stopping" && line.fields.kind === "lost",
      ),
    ).toEqual([]);
  });

  test("a release the gateway never answers ends with the stop grace", async () => {
    class SilentRelease extends FakeWorkerGateway {
      override release(): Promise<never> {
        this.calls.push("release");
        return new Promise(() => {});
      }
    }
    const gateway = new SilentRelease();
    const { lines, logger } = recording();
    const { host } = harness([{ type: "await-input" }], {
      gateway,
      logger,
      timeouts: { drainTimeoutMs: 20, stopGraceMs: 1_500 },
    });
    const loop = host.runLoop();
    await waitFor(() => gateway.calls.includes("bootstrapClaim"), "the claim");
    const began = Date.now();

    host.drain("received SIGTERM");
    await loop;

    expect(Date.now() - began).toBeLessThan(2_500);
    expect(gateway.calls).toContain("release");
    expect(lines.map((line) => line.event)).toContain("worker.release.failed");
  }, 10_000);

  test("a lease lost while the shutdown waits is not released, and is reported lost", async () => {
    let failPoll!: () => void;
    const pollFails = new Promise<void>((resolve) => {
      failPoll = resolve;
    });
    class LatePoll extends FakeWorkerGateway {
      override async nextInput(): Promise<never> {
        this.calls.push("nextInput");
        await pollFails;
        throw new WorkerGatewayRequestError(
          409,
          "LEASE_EXPIRED",
          "the lease ran out during the shutdown",
          false,
        );
      }
    }
    const gateway = new LatePoll();
    const engines: EngineExitWatch = {
      async exited() {
        // The shutdown is past its first ownership check by now.
        failPoll();
        await Bun.sleep(10);
        return true;
      },
      running: [],
      kill() {},
    };
    const { host } = harness([{ type: "await-input" }], {
      engines,
      gateway,
      timeouts: { drainTimeoutMs: 20 },
    });
    const loop = host.runLoop();
    await waitFor(() => gateway.calls.includes("nextInput"), "the poll");

    host.drain("received SIGTERM");
    const summary = await loop;

    expect(summary.outcome).toBe("lease_lost");
    expect(gateway.releases).toEqual([]);
  });

  test("a claim still unanswered when the stop grace runs out is given up", async () => {
    class SilentClaim extends FakeWorkerGateway {
      override bootstrapClaim(): Promise<never> {
        this.calls.push("bootstrapClaim");
        return new Promise(() => {});
      }
    }
    const gateway = new SilentClaim();
    const { host } = harness([{ type: "await-input" }], {
      gateway,
      timeouts: { requestTimeoutMs: 60_000, stopGraceMs: 2_500 },
    });
    const loop = host.runLoop();
    await waitFor(() => gateway.calls.includes("bootstrapClaim"), "the claim");
    const began = Date.now();

    host.drain("received SIGTERM");
    const summary = await loop;

    // The grace less the reserve the release would have needed.
    expect(Date.now() - began).toBeLessThan(1_500);
    expect(summary.outcome).toBe("unclaimed");
  }, 10_000);

  test("a claim that answers after the stop, within the grace, is released", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    class SlowClaim extends FakeWorkerGateway {
      override async bootstrapClaim(
        request: Parameters<FakeWorkerGateway["bootstrapClaim"]>[0],
      ) {
        await answered;
        return super.bootstrapClaim(request);
      }
    }
    const gateway = new SlowClaim();
    const { host, runtime } = harness([{ type: "await-input" }], {
      gateway,
      timeouts: { stopGraceMs: 2_500 },
    });
    const loop = host.runLoop();
    await Bun.sleep(5);

    host.drain("received SIGTERM");
    answer();
    const summary = await loop;

    expect(summary.outcome).toBe("drained");
    expect(gateway.releases).toHaveLength(1);
    expect(runtime.inputs).toEqual([]);
  });
});

/** A worker whose claim restored an engine session rather than opening one. */
function resumedFrom(capture: () => void = () => {}): WorkerCheckpointPort {
  return {
    restorePlan: async () => ({
      mode: "resume",
      resume: "fake-session",
      localTranscriptResume: true,
    }),
    capture: async () => {
      capture();
      return null;
    },
  };
}

describe("WorkerHost with a resumed engine session (94S-242)", () => {
  test("closes an input the resumed transcript already holds as outcome_unknown, without sending it", async () => {
    let captures = 0;
    const { gateway, host, runtime } = harness(
      [{ type: "await-input" }, { type: "await-input" }],
      {
        checkpoints: resumedFrom(() => {
          captures += 1;
        }),
        resumedTranscript: [uuidForTurn(1)],
      },
    );
    gateway.enqueue("a turn an earlier engine already took");

    const summary = await host.runLoop();

    expect(summary.turns).toEqual([
      {
        turnId: "1",
        status: "outcome_unknown",
        reason: "input_already_consumed",
      },
    ]);
    // Never sent, and never under a new uuid either: nothing ran twice.
    expect(runtime.inputs).toEqual([]);
    expect(gateway.finalized[0]?.terminal).toMatchObject({
      status: "outcome_unknown",
      reason: "input_already_consumed",
    });
    // Nothing ran, so there is nothing new to checkpoint.
    expect(captures).toBe(0);
    expect(gateway.finalized[0]?.checkpoint).toBeNull();
    // The next decision is recovery's: the worker gives the session back.
    expect(summary.outcome).toBe("drained");
    expect(summary.reason).toBe("Turn 1 needs a recovery decision");
    expect(gateway.releases).toHaveLength(1);
  });

  test("sends a redelivered input under its own uuid when the resumed transcript does not hold it", async () => {
    const { gateway, host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      {
        checkpoints: resumedFrom(),
        resumedTranscript: ["some-earlier-input"],
      },
    );
    gateway.enqueue("a turn the checkpoint predates");

    const summary = await host.runLoop();

    expect(runtime.inputs.map((input) => input.uuid)).toEqual([uuidForTurn(1)]);
    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
  });

  test("a transcript that cannot be read fails closed: nothing is sent or finalized", async () => {
    const { gateway, host, runtime } = harness([{ type: "await-input" }], {
      checkpoints: resumedFrom(),
      wrap: (run) =>
        new Proxy(run, {
          get(target, property) {
            if (property === "holdsInput") {
              return async () => {
                throw new Error("The resumed transcript could not be read");
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    gateway.enqueue("a turn nobody can place");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("failed");
    expect(summary.reason).toContain("could not be read");
    expect(runtime.inputs).toEqual([]);
    // Left open for the reconciler, which records it as unknown.
    expect(gateway.finalized).toEqual([]);
    expect(gateway.releases).toHaveLength(1);
  });

  test("a transcript check that hangs is ended by the turn deadline, not the drain budget", async () => {
    const { gateway, host, runtime } = harness(
      [{ type: "await-input" }, { type: "await-input" }],
      {
        checkpoints: resumedFrom(),
        timeouts: { maxTurnMs: 30, drainTimeoutMs: 60_000 },
        wrap: (run) =>
          new Proxy(run, {
            get(target, property) {
              if (property === "holdsInput") return () => new Promise(() => {});
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
      },
    );
    gateway.enqueue("a turn whose transcript never loads");
    const began = Date.now();

    const summary = await host.runLoop();

    expect(Date.now() - began).toBeLessThan(10_000);
    expect(runtime.inputs).toEqual([]);
    expect(summary.turns).toEqual([
      { turnId: "1", status: "outcome_unknown", reason: "turn_timeout" },
    ]);
    expect(gateway.releases).toHaveLength(1);
  }, 15_000);

  test("an input whose check answers only after the deadline is never sent", async () => {
    const { gateway, host, runtime } = harness(
      [{ type: "await-input" }, { type: "await-input" }],
      {
        checkpoints: resumedFrom(),
        timeouts: { maxTurnMs: 30, drainTimeoutMs: 60_000 },
        wrap: (run) =>
          new Proxy(run, {
            get(target, property) {
              if (property === "holdsInput") {
                return () => Bun.sleep(80).then(() => false);
              }
              // The interrupt is asked for and never lands, so nothing
              // closes the turn before the late check answers.
              if (property === "interrupt") return () => new Promise(() => {});
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
      },
    );
    gateway.enqueue("a turn whose check comes back too late");

    const summary = await host.runLoop();

    expect(runtime.inputs).toEqual([]);
    expect(summary.turns).toEqual([
      { turnId: "1", status: "outcome_unknown", reason: "turn_timeout" },
    ]);
  }, 15_000);

  test("a check that fails only after the deadline leaves the timeout to finalize", async () => {
    const { gateway, host, runtime } = harness(
      [{ type: "await-input" }, { type: "await-input" }],
      {
        checkpoints: resumedFrom(),
        timeouts: { maxTurnMs: 30, drainTimeoutMs: 60_000 },
        wrap: (run) =>
          new Proxy(run, {
            get(target, property) {
              if (property === "holdsInput") {
                return () =>
                  Bun.sleep(80).then(() => {
                    throw new Error("The transcript store went away");
                  });
              }
              if (property === "interrupt") return () => new Promise(() => {});
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
      },
    );
    gateway.enqueue("a turn whose check fails too late");

    const summary = await host.runLoop();

    expect(runtime.inputs).toEqual([]);
    expect(summary.turns).toEqual([
      { turnId: "1", status: "outcome_unknown", reason: "turn_timeout" },
    ]);
    expect(gateway.finalized).toHaveLength(1);
  }, 15_000);

  test("a drain budget shorter than the interrupt grace still gets the timeout finalized", async () => {
    const { gateway, host } = harness(
      [{ type: "await-input" }, { type: "await-input" }],
      {
        timeouts: { maxTurnMs: 30, drainTimeoutMs: 50 },
        wrap: (run) =>
          new Proxy(run, {
            get(target, property) {
              if (property === "interrupt") return () => new Promise(() => {});
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
      },
    );
    gateway.enqueue("a turn with almost no drain budget");

    const summary = await host.runLoop();

    expect(summary.turns).toEqual([
      { turnId: "1", status: "outcome_unknown", reason: "turn_timeout" },
    ]);
    expect(gateway.finalized).toHaveLength(1);
    expect(summary.outcome).toBe("failed");
  });

  test("a drain begun before the deadline still leaves room to finalize the timeout", async () => {
    const { gateway, host } = harness(
      [{ type: "await-input" }, { type: "await-input" }],
      {
        timeouts: { maxTurnMs: 300, drainTimeoutMs: 200 },
        wrap: (run) =>
          new Proxy(run, {
            get(target, property) {
              if (property === "interrupt") return () => new Promise(() => {});
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
      },
    );
    gateway.enqueue("a turn the drain would give up first");
    // Gives the turn up at 400ms; the deadline fires at 300ms.
    setTimeout(() => host.drain("stopping"), 200);

    const summary = await host.runLoop();

    expect(summary.turns).toEqual([
      { turnId: "1", status: "outcome_unknown", reason: "turn_timeout" },
    ]);
    expect(gateway.finalized).toHaveLength(1);
    expect(summary.outcome).toBe("failed");
  });

  test("with no drain budget left the timeout closes at once and fails the worker", async () => {
    const { gateway, host } = harness(
      [{ type: "await-input" }, { type: "await-input" }],
      {
        timeouts: { maxTurnMs: 30, drainTimeoutMs: 0 },
        wrap: (run) =>
          new Proxy(run, {
            get(target, property) {
              if (property === "interrupt") return () => new Promise(() => {});
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
      },
    );
    gateway.enqueue("a turn with no drain budget at all");
    const began = Date.now();

    const summary = await host.runLoop();

    expect(Date.now() - began).toBeLessThan(5_000);
    expect(summary.outcome).toBe("failed");
  });

  test("a timed-out turn the engine answers for no input fails the worker", async () => {
    const { gateway, host } = harness(
      [
        { type: "await-input" },
        { type: "delay", delayMs: 80 },
        {
          type: "emit",
          message: {
            type: "result",
            subtype: "error_during_execution",
            session_id: "fake-session",
            is_error: true,
          },
        },
        { type: "await-input" },
      ],
      {
        timeouts: { maxTurnMs: 30, drainTimeoutMs: 10_000 },
        wrap: (run) =>
          new Proxy(run, {
            get(target, property) {
              if (property === "interrupt") return () => new Promise(() => {});
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
      },
    );
    gateway.enqueue("a turn answered for nobody after its deadline");

    const summary = await host.runLoop();

    expect(summary.turns).toEqual([
      { turnId: "1", status: "outcome_unknown", reason: "turn_timeout" },
    ]);
    expect(summary.outcome).toBe("failed");
    expect(summary.reason).toContain("answered for no input");
  });

  test("an interrupt that ends the stream still closes the turn as a timeout", async () => {
    const { gateway, host } = harness(
      [{ type: "await-input" }, { type: "await-input" }],
      {
        timeouts: { maxTurnMs: 30, drainTimeoutMs: 10_000 },
        wrap: (run) =>
          new Proxy(run, {
            get(target, property) {
              if (property === "interrupt") {
                return async () => {
                  target.close();
                  return { stillQueued: [] };
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
      },
    );
    gateway.enqueue("a turn whose engine dies on interrupt");

    const summary = await host.runLoop();

    expect(summary.turns).toEqual([
      { turnId: "1", status: "outcome_unknown", reason: "turn_timeout" },
    ]);
    expect(summary.outcome).toBe("failed");
    expect(summary.reason).toContain("stream ended after the turn ran out");
  });

  test("an engine that swallows the input is closed by the turn deadline, not left leased", async () => {
    // What the fix guards against, reproduced: the check is bypassed, the
    // engine deduplicates the send and answers nothing — not even the
    // interrupt. Without a deadline this turn would never end.
    const { gateway, host, runtime } = harness(
      [{ type: "await-input" }, { type: "await-input" }],
      {
        resumedTranscript: [uuidForTurn(1)],
        checkpoints: resumedFrom(),
        timeouts: { maxTurnMs: 30, drainTimeoutMs: 10_000 },
        wrap: (run) =>
          new Proxy(run, {
            get(target, property) {
              if (property === "holdsInput") return async () => false;
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
      },
    );
    gateway.enqueue("a turn the engine will never answer");

    const summary = await host.runLoop();

    expect(runtime.inputs.map((input) => input.uuid)).toEqual([uuidForTurn(1)]);
    expect(summary.turns).toEqual([
      { turnId: "1", status: "outcome_unknown", reason: "turn_timeout" },
    ]);
    expect(gateway.finalized[0]?.checkpoint).toBeNull();
    // An engine that ignores an interrupt is not trusted with anything else.
    expect(summary.outcome).toBe("failed");
    expect(summary.reason).toContain("did not answer the interrupt");
    expect(gateway.releases).toHaveLength(1);
  }, 15_000);

  test("a turn past its budget is interrupted and closed as failed, approval wait included", async () => {
    const { gateway, host, runtime } = harness(
      [
        { type: "await-input" },
        {
          type: "permissions",
          requests: [
            {
              input: { command: "sleep 3600" },
              requestId: "req-slow",
              tool: "Bash",
              toolUseId: "toolu_slow",
            },
          ],
        },
        { type: "delay", delayMs: 10_000 },
      ],
      {
        timeouts: {
          maxTurnMs: 40,
          questionTimeoutMs: 10_000,
          drainTimeoutMs: 10_000,
        },
      },
    );
    gateway.enqueue("a turn that runs too long");
    const began = Date.now();

    const summary = await host.runLoop();

    // Stuck on an approval nobody gives: the budget, not the 10s question
    // timeout, is what ends it.
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(runtime.inputs).toHaveLength(1);
    // The engine answered the interrupt, but the budget is what ended it.
    expect(summary.turns).toEqual([
      { turnId: "1", status: "failed", reason: "turn_timeout" },
    ]);
    expect(gateway.finalized[0]?.terminal).toMatchObject({
      status: "failed",
      reason: "turn_timeout",
      result: { terminal_reason: "aborted_tools" },
    });
    expect(summary.outcome).toBe("drained");
    expect(summary.reason).toBe("Turn 1 ran past its 0.04s budget");
    expect(gateway.releases).toHaveLength(1);
  });

  test("a turn longer than the idle timeout does not end the worker on the next poll", async () => {
    const gateway = new FakeWorkerGateway();
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "delay", delayMs: 150 },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(2)) },
        { type: "await-input" },
      ],
      { gateway, timeouts: { idleTimeoutMs: 80 } },
    );
    gateway.enqueue("a long first turn");
    const loop = host.runLoop();
    await waitFor(() => gateway.finalized.length === 1, "the first finalize");
    await Bun.sleep(20);
    gateway.enqueue("a follow-up soon after");

    const summary = await loop;

    expect(runtime.inputs).toHaveLength(2);
    expect(summary.turns.map((turn) => turn.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(summary.outcome).toBe("idle");
  });
});

/** A gateway 503: transient, so the worker keeps retrying it. */
function unavailable(): WorkerGatewayRequestError {
  return new WorkerGatewayRequestError(
    503,
    "BACKEND_UNAVAILABLE",
    "The gateway is unavailable",
    true,
  );
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe("WorkerHost stalls the turn deadline does not cover (94S-269)", () => {
  test("a nextInput the gateway keeps failing ends the worker within its retry budget, heartbeats and all", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.enqueue("committed but never answered");
    let polls = 0;
    gateway.nextInput = async () => {
      polls += 1;
      throw unavailable();
    };
    const { host, runtime } = harness([{ type: "await-input" }], {
      gateway,
      sleep: () => Bun.sleep(5),
      timeouts: { heartbeatIntervalMs: 5, nextInputRetryTimeoutMs: 300 },
    });

    const began = performance.now();
    const summary = await host.runLoop();

    expect(summary.outcome).toBe("failed");
    expect(summary.reason).toContain("nextInput");
    expect(performance.now() - began).toBeLessThan(3_000);
    // The lease was still being extended the whole time: only the budget ended it.
    expect(gateway.heartbeats.length).toBeGreaterThan(1);
    expect(polls).toBeGreaterThan(1);
    // The turn the server may have committed is not run and not finalized;
    // the release leaves it to confirmExecutionGone as outcome_unknown.
    expect(runtime.inputs).toEqual([]);
    expect(gateway.finalized).toEqual([]);
    expect(gateway.releases).toHaveLength(1);
  });

  test("events the gateway keeps failing end the worker within the retry budget instead of holding the turn's finalize (94S-392)", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.appendFailure = unavailable();
    gateway.enqueue("a turn whose events never land");
    const { host } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: assistantMessage("answer") },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      {
        gateway,
        timeouts: {
          drainTimeoutMs: 60_000,
          heartbeatIntervalMs: 5,
          idleTimeoutMs: 60_000,
          nextInputRetryTimeoutMs: 300,
        },
      },
    );

    const began = performance.now();
    const summary = await host.runLoop();

    expect(summary.outcome).toBe("failed");
    expect(summary.reason).toContain("The gateway is unavailable");
    expect(performance.now() - began).toBeLessThan(3_000);
    expect(gateway.heartbeats.length).toBeGreaterThan(1);
    expect(gateway.finalized).toEqual([]);
    expect(gateway.releases).toHaveLength(1);
  });

  test("sends no further poll once the budget has run out mid-backoff", async () => {
    const gateway = new FakeWorkerGateway();
    let polls = 0;
    gateway.nextInput = async () => {
      polls += 1;
      throw unavailable();
    };
    const { host } = harness([{ type: "await-input" }], {
      gateway,
      // The backoff outlasts the budget: the expiry lands while it sleeps.
      sleep: () => Bun.sleep(200),
      timeouts: { nextInputRetryTimeoutMs: 20 },
    });

    const summary = await host.runLoop();
    await Bun.sleep(250);

    expect(summary.outcome).toBe("failed");
    expect(polls).toBe(1);
  });

  test("a poll that answers only after the budget is never run", async () => {
    const gateway = new FakeWorkerGateway();
    const real = gateway.nextInput.bind(gateway);
    gateway.enqueue("late input");
    let polls = 0;
    gateway.nextInput = async (request) => {
      polls += 1;
      if (polls === 1) throw unavailable();
      await Bun.sleep(150);
      return real(request);
    };
    const { host, runtime } = harness([{ type: "await-input" }], {
      gateway,
      sleep: () => Bun.sleep(1),
      timeouts: { nextInputRetryTimeoutMs: 40 },
    });

    const summary = await host.runLoop();
    await Bun.sleep(200);

    expect(summary.outcome).toBe("failed");
    expect(runtime.inputs).toEqual([]);
    expect(gateway.finalized).toEqual([]);
  });

  test("a poll that recovers within the budget runs the turn, and the budget starts over", async () => {
    const gateway = new FakeWorkerGateway();
    const real = gateway.nextInput.bind(gateway);
    gateway.enqueue("first message");
    let polls = 0;
    gateway.nextInput = async (request) => {
      polls += 1;
      // Two failures before each success: together they would outlast the
      // budget, each run alone does not.
      if (polls % 3 !== 0) {
        await Bun.sleep(150);
        throw unavailable();
      }
      return real(request);
    };
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      {
        gateway,
        sleep: () => Bun.sleep(1),
        timeouts: { nextInputRetryTimeoutMs: 400, idleTimeoutMs: 150 },
      },
    );

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
    expect(runtime.inputs.map((input) => input.uuid)).toEqual([uuidForTurn(1)]);
  });

  test("a restorePlan that never returns fails the worker within the startup budget and releases", async () => {
    const gateway = new FakeWorkerGateway();
    const { host, launched } = harness([{ type: "await-input" }], {
      gateway,
      checkpoints: { restorePlan: never, capture: async () => null },
      timeouts: { heartbeatIntervalMs: 5, startupTimeoutMs: 300 },
    });

    const began = performance.now();
    const summary = await host.runLoop();

    expect(summary.outcome).toBe("failed");
    expect(summary.reason).toContain("budget");
    expect(performance.now() - began).toBeLessThan(3_000);
    expect(gateway.heartbeats.length).toBeGreaterThan(1);
    expect(launched).toEqual([]);
    expect(gateway.finalized).toEqual([]);
    expect(gateway.releases).toHaveLength(1);
  });

  test("a preparation that ignores its abort is ended by the startup budget", async () => {
    const gateway = new FakeWorkerGateway();
    let aborted = false;
    const { host, launched } = harness([{ type: "await-input" }], {
      gateway,
      workspace: {
        committedClaudeMd: () => null,
        instructionsCommit: () => null,
        prepare: ({ signal }) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          return never();
        },
      },
      timeouts: { startupTimeoutMs: 50 },
    });

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("failed");
    expect(aborted).toBe(true);
    expect(launched).toEqual([]);
    expect(gateway.releases).toHaveLength(1);
  });

  test("a capture that never returns fails the worker within its budget and releases", async () => {
    const gateway = new FakeWorkerGateway();
    const { host } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      {
        gateway,
        checkpoints: {
          restorePlan: async () => ({ mode: "new" }),
          capture: never,
        },
        timeouts: { heartbeatIntervalMs: 5, startupTimeoutMs: 300 },
      },
    );
    gateway.enqueue("a turn whose checkpoint hangs");

    const began = performance.now();
    const summary = await host.runLoop();

    expect(summary.outcome).toBe("failed");
    expect(summary.reason).toBe(
      "Checkpointing the turn ran past its 0.3s budget",
    );
    expect(performance.now() - began).toBeLessThan(3_000);
    expect(gateway.finalized).toEqual([]);
    expect(gateway.releases).toHaveLength(1);
  });

  test("a restore plan that arrives after the budget starts no engine, and a late rejection is not unhandled", async () => {
    let answer!: (plan: { mode: "new" }) => void;
    let refuse!: (error: Error) => void;
    const plans: WorkerCheckpointPort[] = [
      {
        restorePlan: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
        capture: async () => null,
      },
      {
        restorePlan: () =>
          new Promise((_, reject) => {
            refuse = reject;
          }),
        capture: async () => null,
      },
    ];
    for (const checkpoints of plans) {
      const gateway = new FakeWorkerGateway();
      const { host, launched } = harness([{ type: "await-input" }], {
        gateway,
        checkpoints,
        timeouts: { startupTimeoutMs: 30 },
      });

      const summary = await host.runLoop();
      if (checkpoints === plans[0]) answer({ mode: "new" });
      else refuse(new Error("object store read failed late"));
      await Bun.sleep(20);

      expect(summary.outcome).toBe("failed");
      expect(launched).toEqual([]);
      expect(gateway.releases).toHaveLength(1);
    }
  });

  test("a drain while restorePlan hangs releases without starting the engine", async () => {
    const gateway = new FakeWorkerGateway();
    let asked!: () => void;
    const restoring = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const { host, launched } = harness([{ type: "await-input" }], {
      gateway,
      checkpoints: {
        restorePlan: () => {
          asked();
          return never();
        },
        capture: async () => null,
      },
    });
    const loop = host.runLoop();
    await restoring;

    host.drain("received SIGTERM");
    const summary = await loop;

    // The drain came first: the outcome is the drain's, not a timeout's.
    expect(summary).toMatchObject({
      outcome: "drained",
      reason: "received SIGTERM",
    });
    expect(launched).toEqual([]);
    expect(gateway.releases).toHaveLength(1);
  });

  test("a lease lost while restorePlan hangs is reported lost and never released", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.heartbeatFailure = "LEASE_EXPIRED";
    const { host, launched } = harness([{ type: "await-input" }], {
      gateway,
      checkpoints: { restorePlan: never, capture: async () => null },
      timeouts: { heartbeatIntervalMs: 5 },
    });

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("lease_lost");
    expect(launched).toEqual([]);
    expect(gateway.releases).toEqual([]);
  });

  test("the startup budget stops counting once the engine is running", async () => {
    const { host, gateway } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      { timeouts: { startupTimeoutMs: 150, idleTimeoutMs: 500 } },
    );
    gateway.enqueue("first message");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    expect(summary.turns).toHaveLength(1);
  });
});

describe("WorkerHost restoring a checkpoint (94S-246)", () => {
  test("hands the engine the CLAUDE.md the checkpoint pinned, not the preparer's", async () => {
    const { claudeMds, host } = harness([{ type: "await-input" }], {
      checkpoints: {
        restorePlan: async () => ({
          mode: "resume",
          resume: "fake-session",
          committedClaudeMd: () => "as pinned\n",
        }),
        capture: async () => null,
      },
      workspace: { ...noWorkspace, committedClaudeMd: () => "as prepared\n" },
    });

    await host.runLoop();

    expect(claudeMds).toEqual(["as pinned\n"]);
  });

  test("a stop during the restore waits for it to stop before releasing", async () => {
    const order: string[] = [];
    const gateway = new (class extends FakeWorkerGateway {
      override async release(request: ReleaseRequest) {
        order.push("release");
        return super.release(request);
      }
    })();
    let host: WorkerHost | undefined;
    const built = harness([{ type: "await-input" }], {
      checkpoints: {
        restorePlan: (_claim, signal) =>
          new Promise((_resolve, reject) => {
            // The step in flight finishes before the abort is noticed.
            signal.addEventListener("abort", () =>
              setTimeout(() => {
                order.push("restore stopped");
                reject(signal.reason);
              }, 30),
            );
            host?.drain("received SIGTERM");
          }),
        capture: async () => null,
      },
      gateway,
    });
    host = built.host;

    const summary = await built.host.runLoop();

    expect(summary.outcome).toBe("drained");
    expect(order).toEqual(["restore stopped", "release"]);
  });

  test("a restore that never stops is waited for only as long as the release can spare", async () => {
    const warnings: string[] = [];
    let host: WorkerHost | undefined;
    const built = harness([{ type: "await-input" }], {
      checkpoints: {
        restorePlan: () => {
          host?.drain("received SIGTERM");
          return new Promise(() => {});
        },
        capture: async () => null,
      },
      logger: {
        info: () => {},
        warn: (event) => warnings.push(event),
        error: () => {},
      },
      timeouts: { requestTimeoutMs: 50 },
    });
    host = built.host;

    const summary = await built.host.runLoop();

    expect(summary.outcome).toBe("drained");
    expect(warnings).toContain("worker.restore.unsettled");
    expect(built.gateway.releases).toHaveLength(1);
  });
});

describe("WorkerHost checkpoint publishing (94S-246)", () => {
  const publishing: WorkerCheckpointPort = {
    restorePlan: async () => ({ mode: "new" }),
    capture: async (preparation) =>
      preparation.status === "ready"
        ? {
            revision: 0,
            manifest_ref: "checkpoints/0.json",
            manifest_sha256: "a".repeat(64),
          }
        : null,
  };
  const oneTurn: FakeStep[] = [
    { type: "await-input" },
    { type: "emit", message: resultMessage(uuidForTurn(1)) },
    { type: "await-input" },
  ];
  const refused = () =>
    new WorkerGatewayRequestError(
      409,
      "CHECKPOINT_UNAVAILABLE",
      "Checkpoint manifest rejected: bundle digest mismatch",
      false,
    );

  test("a manifest the gateway refuses is dropped, and the turn is recorded without it", async () => {
    const warnings: string[] = [];
    const gateway = new FakeWorkerGateway({
      checkpoints: {
        commit: async () => {
          throw refused();
        },
        requestCheckpoint: async () => ({
          status: "blocked",
          reason: "tool_in_flight",
          detail: "unused: the port under test never asks",
        }),
        restorePlan: async () => ({ status: "none" }),
      },
    });
    const recorded: Array<{ detail: string; turn: string | null }> = [];
    const { host } = harness(oneTurn, {
      checkpoints: {
        ...publishing,
        finalizeRefused: async (detail, scope) => {
          recorded.push({ detail, turn: scope.turn_id });
        },
      },
      gateway,
      logger: { ...silent, warn: (event) => warnings.push(event) },
    });
    gateway.enqueue("a turn whose manifest is refused");

    const summary = await host.runLoop();

    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
    expect(gateway.finalized.map((call) => call.checkpoint)).toEqual([null]);
    expect(gateway.calls.filter((call) => call === "finalize").length).toBe(2);
    expect(warnings).toContain("worker.checkpoint.failed");
    // The session shows the turn went without its checkpoint (94S-312).
    expect(recorded).toEqual([
      {
        detail: "Checkpoint manifest rejected: bundle digest mismatch",
        turn: "1",
      },
    ]);
  });

  test("a refusal after an unanswered finalize is not retried without the checkpoint", async () => {
    const sent: Array<FinalizeRequest["checkpoint"]> = [];
    class Undecided extends FakeWorkerGateway {
      override async finalize(
        request: FinalizeRequest,
      ): Promise<FinalizeResponse> {
        sent.push(request.checkpoint);
        // The first may have committed for all this worker knows; whatever
        // a retry is told cannot prove it did not.
        if (sent.length === 1) {
          throw new WorkerGatewayRequestError(
            503,
            null,
            "the gateway is restarting",
            true,
          );
        }
        throw refused();
      }
    }
    const gateway = new Undecided();
    let recorded = 0;
    const { host } = harness(oneTurn, {
      checkpoints: {
        ...publishing,
        finalizeRefused: async () => {
          recorded += 1;
        },
      },
      gateway,
    });
    gateway.enqueue("a turn whose finalize goes unanswered first");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("failed");
    expect(sent.every((checkpoint) => checkpoint !== null)).toBe(true);
    // The first request may yet commit it: nothing says it went without.
    expect(recorded).toBe(0);
  });

  test("a tool the engine starts while the checkpoint publishes is refused", async () => {
    const slowPublish: WorkerCheckpointPort = {
      restorePlan: async () => ({ mode: "new" }),
      capture: async (preparation) => {
        // Long enough for the engine's next step to land mid-publish.
        await Bun.sleep(150);
        return publishing.capture(preparation, {
          scope: {} as never,
          recheck: async () => preparation,
        });
      },
    };
    const gateway = new FakeWorkerGateway();
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "delay", delayMs: 50 },
        { type: "tool-start", toolUseId: "toolu_mid_publish" },
        { type: "await-input" },
      ],
      { checkpoints: slowPublish, gateway },
    );
    gateway.enqueue("a turn whose publish is slow");

    const summary = await host.runLoop();

    expect(summary.turns[0]?.status).toBe("completed");
    expect(gateway.finalized[0]?.checkpoint?.revision).toBe(0);
    expect(runtime.toolAdmissions).toEqual([
      {
        toolUseId: "toolu_mid_publish",
        admission: { allowed: false, message: expect.any(String) },
      },
    ]);
  });

  test("the heartbeat carries when the mirror last wrote and the error it latched", async () => {
    const persistedAt = new Date("2026-09-23T01:02:03.000Z");
    const gateway = new FakeWorkerGateway();
    const { host } = harness(
      [
        { type: "await-input" },
        {
          type: "emit",
          message: {
            type: "system",
            subtype: "mirror_error",
            session_id: "fake-session",
            error: "bucket unreachable",
          },
        },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      {
        checkpoints: { ...publishing, mirror: () => ({ persistedAt }) },
        gateway,
      },
    );
    gateway.enqueue("a turn whose mirror fails");

    await host.runLoop();

    expect(gateway.heartbeats.at(-1)?.transcript).toEqual({
      persisted_at: persistedAt.toISOString(),
      mirror_error: "Transcript mirror dropped a batch: bucket unreachable",
    });
  });

  test("a mirror error after a turn drains before the next input and is reported at once", async () => {
    const gateway = new FakeWorkerGateway();
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        {
          type: "emit",
          message: {
            type: "system",
            subtype: "mirror_error",
            session_id: "fake-session",
            error: "bucket unreachable",
          },
        },
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(2)) },
        { type: "await-input" },
      ],
      {
        checkpoints: { ...publishing, mirror: () => ({ persistedAt: null }) },
        gateway,
        // Nothing but the latch itself may send the beat that records it.
        timeouts: { heartbeatIntervalMs: 60_000 },
      },
    );
    gateway.enqueue("first");
    gateway.enqueue("second");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("drained");
    expect(summary.turns.map((turn) => turn.turnId)).toEqual(["1"]);
    expect(runtime.inputs).toHaveLength(1);
    expect(
      gateway.heartbeats.some(
        (beat) => beat.transcript?.mirror_error?.includes("bucket") === true,
      ),
    ).toBe(true);
    // A drain it decided itself, which before any input would be a failed
    // startup: not reported as one asked of it (94S-302).
    expect(gateway.releases[0]).not.toHaveProperty("stop_kind");
  });

  test("a mirror error latched while the next input is polled for stops that input being handed out", async () => {
    // The poll after turn 1 is answered only once the latch's beat is in,
    // as a gateway would whose queue read raced the error.
    const gateway = new (class extends FakeWorkerGateway {
      private polls = 0;
      override async nextInput(request: NextInputRequest) {
        this.polls += 1;
        if (this.polls === 2) {
          for (let waited = 0; waited < 2_000; waited += 2) {
            if (this.heartbeats.some((beat) => beat.transcript?.mirror_error))
              break;
            await Bun.sleep(2);
          }
        }
        return super.nextInput(request);
      }
    })();
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        // After the loop has gone back to polling.
        { type: "delay", delayMs: 30 },
        {
          type: "emit",
          message: {
            type: "system",
            subtype: "mirror_error",
            session_id: "fake-session",
            error: "bucket unreachable",
          },
        },
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(2)) },
        { type: "await-input" },
      ],
      {
        checkpoints: { ...publishing, mirror: () => ({ persistedAt: null }) },
        gateway,
        timeouts: { heartbeatIntervalMs: 60_000 },
      },
    );
    gateway.enqueue("first");
    gateway.enqueue("second");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("drained");
    expect(summary.turns.map((turn) => turn.turnId)).toEqual(["1"]);
    expect(runtime.inputs).toHaveLength(1);
  });

  test("an input the gateway handed out before the mirror error's beat is not run", async () => {
    // Turn 2 is taken off the queue first, and its answer held until the
    // latch's beat is in: delivered on the server, late at the worker.
    const gateway = new (class extends FakeWorkerGateway {
      private polls = 0;
      override async nextInput(request: NextInputRequest) {
        this.polls += 1;
        const answer = await super.nextInput(request);
        if (this.polls === 2) {
          for (let waited = 0; waited < 2_000; waited += 2) {
            if (this.heartbeats.some((beat) => beat.transcript?.mirror_error))
              break;
            await Bun.sleep(2);
          }
        }
        return answer;
      }
    })();
    const { host, runtime } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "delay", delayMs: 30 },
        {
          type: "emit",
          message: {
            type: "system",
            subtype: "mirror_error",
            session_id: "fake-session",
            error: "bucket unreachable",
          },
        },
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(2)) },
        { type: "await-input" },
      ],
      {
        checkpoints: { ...publishing, mirror: () => ({ persistedAt: null }) },
        gateway,
        timeouts: { heartbeatIntervalMs: 60_000 },
      },
    );
    gateway.enqueue("first");
    gateway.enqueue("second");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("drained");
    expect(summary.turns.map((turn) => turn.turnId)).toEqual(["1"]);
    // Handed out, never sent: left open for the reconciler.
    expect(runtime.inputs).toHaveLength(1);
    expect(gateway.finalized.map((request) => request.turn_id)).toEqual(["1"]);
  });

  test("a mirror error the gateway never recorded leaves the session unreleased", async () => {
    // Up, but refusing every beat that carries the error.
    const gateway = new (class extends FakeWorkerGateway {
      override async heartbeat(request: HeartbeatRequest) {
        if (request.transcript?.mirror_error != null) {
          this.heartbeats.push(request);
          throw new WorkerGatewayRequestError(503, null, "restarting", true);
        }
        return super.heartbeat(request);
      }
    })();
    const errors: string[] = [];
    const { host } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        {
          type: "emit",
          message: {
            type: "system",
            subtype: "mirror_error",
            session_id: "fake-session",
            error: "bucket unreachable",
          },
        },
        { type: "await-input" },
      ],
      {
        checkpoints: { ...publishing, mirror: () => ({ persistedAt: null }) },
        gateway,
        logger: {
          info: () => {},
          warn: () => {},
          error: (event) => errors.push(event),
        },
        timeouts: { heartbeatIntervalMs: 60_000 },
      },
    );
    gateway.enqueue("first");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("drained");
    expect(
      gateway.heartbeats.filter((beat) => beat.transcript?.mirror_error != null)
        .length,
    ).toBeGreaterThanOrEqual(2);
    expect(errors).toContain("worker.mirror_error.unrecorded");
    expect(gateway.releases).toEqual([]);
  });

  test("a port without a mirror heartbeats as before", async () => {
    const gateway = new FakeWorkerGateway();
    const { host } = harness(oneTurn, { checkpoints: publishing, gateway });
    gateway.enqueue("a turn");

    await host.runLoop();

    expect(gateway.heartbeats.length).toBeGreaterThan(0);
    expect(
      gateway.heartbeats.every((beat) => beat.transcript === undefined),
    ).toBe(true);
  });
});

describe("secrets in what the engine prints (94S-252)", () => {
  test("a Bash that dumps the environment and the remote leaves no secret in events", async () => {
    const providerHeld = "wep_provider-attempt-one";
    const repositoryHeld = "wep_repository-attempt-one";
    const gateway = new FakeWorkerGateway({
      runtimeConfig: {
        model: "fake-model",
        tools: ["Bash"],
        permission_mode: "default",
        provider: {
          kind: "anthropic",
          endpoint: "https://api.anthropic.com",
          auth: { kind: "egress_token", token: providerHeld },
        },
      },
      workspace: {
        repository: {
          id: "sample-app",
          url: "https://git.example.test/sample.git",
          branch: "main",
          access: { kind: "egress_token", token: repositoryHeld },
        },
      },
    });
    const claim = await new FakeWorkerGateway().bootstrapClaim({
      execution_id: "exec-1",
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: "wln_test" },
    });
    const sessionHeld = claim.session_credential;
    // What `env; git remote -v` prints inside the engine: its own key, and
    // whatever it can read of the worker's environment through /proc.
    const dump = [
      `ANTHROPIC_API_KEY=${providerHeld}`,
      "ANTHROPIC_BASE_URL=http://egress-proxy.test:3129/provider",
      "WORKER_BOOTSTRAP_NONCE=wln_test",
      // A header line would be dropped whole by the mapper's own patterns;
      // a bare value is what only the scrubber catches.
      `GIT_REPOSITORY_ACCESS=${repositoryHeld}`,
      `session=${sessionHeld}`,
      "origin\thttps://git.example.test/sample.git (fetch)",
    ].join("\n");
    const toolResult: NativeSdkMessage = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_env", content: dump },
        ],
      },
      parent_tool_use_id: null,
      session_id: "fake-session",
    };
    const { host } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: toolResult },
        // The model saw the real values and may repeat them.
        { type: "emit", message: assistantMessage(`key is ${providerHeld}`) },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      { gateway },
    );
    gateway.enqueue("print your environment");

    const summary = await host.runLoop();

    expect(summary.turns).toHaveLength(1);
    const stored = JSON.stringify(gateway.events);
    expect(stored).toContain("tool_result");
    expect(stored).toContain("<redacted>");
    // Nothing that is not a secret is lost with them.
    expect(stored).toContain("https://git.example.test/sample.git");
    for (const held of [
      providerHeld,
      repositoryHeld,
      sessionHeld,
      "wln_test",
    ]) {
      expect(stored).not.toContain(held);
    }
  });
});
