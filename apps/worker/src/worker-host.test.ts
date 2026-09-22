import { describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "@agent-platform/contracts";
import {
  FakeAgentRuntime,
  type FakeStep,
} from "@agent-platform/runtime-claude";
import type { AgentRun, NativeSdkMessage } from "@agent-platform/runtime-core";

import { unwiredCheckpoints, type WorkerCheckpointPort } from "./checkpoint.ts";
import type { WorkerTimeouts } from "./config.ts";
import type { EngineExitWatch } from "./engine-processes.ts";
import { FakeWorkerGateway } from "./fake-gateway.ts";
import { WorkerGatewayRequestError } from "./gateway-client.ts";
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
  nextInputWaitMs: 15,
  questionTimeoutMs: 200,
  requestTimeoutMs: 1_000,
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
    timeouts?: Partial<WorkerTimeouts>;
    workspace?: WorkspacePreparer;
    wrap?: (run: AgentRun) => AgentRun;
  } = {},
) {
  const gateway = overrides.gateway ?? new FakeWorkerGateway();
  const runtime = new FakeAgentRuntime(steps);
  const launched: RuntimeConfig[] = [];
  const runtimes: RuntimeRegistry = {
    launcherFor: () => ({
      start: ({ runtimeConfig, ...launch }, hooks) => {
        launched.push(runtimeConfig);
        const wrap = overrides.wrap ?? ((run: AgentRun) => run);
        return wrap(
          runtime.start(
            {
              claudeConfigDir: "/tmp/fake/config",
              cwd: "/tmp/fake/workspace",
              home: "/tmp/fake/home",
              model: runtimeConfig.model,
              profile: runtimeConfig.provider,
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
  });
  return { gateway, host, launched, runtime };
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
    expect(summary.reason).toContain("94S-201");
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
      request_id: "req-allow",
      kind: "permission",
      decision: "allow",
    });
    gateway.answer({
      request_id: "req-deny",
      kind: "permission",
      decision: "deny",
      reason: "Not on this workspace",
    });
    gateway.answer({
      request_id: "req-question",
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
  });

  test("denies a request nobody answered rather than holding the turn open", async () => {
    const gateway = new FakeWorkerGateway();
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
      { gateway, timeouts: { questionTimeoutMs: 20 } },
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
      runtimeConfig: {
        model: "claimed-model",
        tools: ["Read"],
        permission_mode: "plan",
        provider: {
          kind: "litellm",
          endpoint: "http://litellm.internal:4000",
          auth: { kind: "bearer", value: "claimed" },
        },
      },
    });
    const { host, launched } = harness(
      [
        { type: "await-input" },
        { type: "emit", message: resultMessage(uuidForTurn(1)) },
        { type: "await-input" },
      ],
      { gateway },
    );
    gateway.enqueue("hello");

    await host.runLoop();

    expect(launched).toEqual([
      {
        model: "claimed-model",
        tools: ["Read"],
        permission_mode: "plan",
        provider: {
          kind: "litellm",
          endpoint: "http://litellm.internal:4000",
          auth: { kind: "bearer", value: "claimed" },
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

  test("gives the session back without starting an engine when the workspace is refused", async () => {
    const gateway = new FakeWorkerGateway();
    const { host, launched } = harness([{ type: "await-input" }], {
      gateway,
      workspace: {
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
