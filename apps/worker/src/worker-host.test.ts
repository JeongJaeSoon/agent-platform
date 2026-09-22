import { describe, expect, test } from "bun:test";
import {
  FakeAgentRuntime,
  type FakeStep,
} from "@agent-platform/runtime-claude";
import type { NativeSdkMessage } from "@agent-platform/runtime-core";

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
  } = {},
) {
  const gateway = overrides.gateway ?? new FakeWorkerGateway();
  const runtime = new FakeAgentRuntime(steps);
  const runtimes: RuntimeRegistry = {
    launcherFor: () => ({
      start: (launch, hooks) =>
        runtime.start(
          {
            claudeConfigDir: "/tmp/fake/config",
            cwd: "/tmp/fake/workspace",
            home: "/tmp/fake/home",
            model: "fake-model",
            profile: {
              kind: "anthropic",
              endpoint: "http://127.0.0.1:4000",
              auth: { kind: "api_key", value: "placeholder" },
            },
            tools: [],
            ...launch,
          },
          hooks,
        ),
    }),
  };
  const host = new WorkerHost({
    checkpoints: overrides.checkpoints ?? unwiredCheckpoints,
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger: overrides.logger ?? silent,
    runtimes,
    timeouts: { ...timeouts, ...overrides.timeouts },
    ...(overrides.engines === undefined ? {} : { engines: overrides.engines }),
  });
  return { gateway, host, runtime };
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
