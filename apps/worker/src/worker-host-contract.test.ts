import { describe, expect, test } from "bun:test";
import { type SessionEvent, sessionEventSchema } from "@werft-ai/contracts";
import {
  type AgentInput,
  approvalInputHash,
  type RuntimeEvent,
  type TurnEnded,
} from "@werft-ai/runtime-core";

import { unwiredCheckpoints } from "./checkpoint.ts";
import type { WorkerTimeouts } from "./config.ts";
import { FakeWorkerGateway } from "./testing/fake-gateway.ts";
import { ScriptedRun } from "./testing/scripted-run.ts";
import { WorkerHost, type WorkerLogger } from "./worker-host.ts";
import { noWorkspace } from "./workspace.ts";

// The host driven by a run that implements the contract directly, with no
// Claude driver underneath, so nothing here leans on how the Claude adapter
// shapes a request.

const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 2,
  claimTimeoutMs: 200,
  drainTimeoutMs: 50,
  heartbeatIntervalMs: 10_000,
  idleTimeoutMs: 60,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 15,
  questionTimeoutMs: 2_000,
  requestTimeoutMs: 1_000,
  startupTimeoutMs: 60_000,
};

function publicEvent(
  id: string,
  event: string,
  data: unknown,
  inputs?: readonly string[],
): RuntimeEvent {
  return {
    type: "public",
    event: sessionEventSchema.parse({ id, event, data }) as SessionEvent,
    ...(inputs === undefined ? {} : { inputs }),
  };
}

function turnEnded(input: AgentInput, turn: Partial<TurnEnded> = {}) {
  return {
    type: "turn.ended",
    turn: {
      isError: false,
      abortedByStop: false,
      budgetExceeded: false,
      engineResult: { outcome: "done" },
      cost: { countRestarted: false, unknown: true },
      inputs: [input.uuid],
      ...turn,
    },
  } satisfies RuntimeEvent;
}

/** Ends the turn `input` started. */
function finish(
  run: ScriptedRun,
  input: AgentInput,
  turn: Partial<TurnEnded> = {},
): void {
  run.push(
    publicEvent("done", "system", { type: "system", subtype: "done" }, [
      input.uuid,
    ]),
    turnEnded(input, turn),
  );
}

function host(
  run: ScriptedRun,
  logger?: WorkerLogger,
  overrides: Partial<WorkerTimeouts> = {},
) {
  const gateway = new FakeWorkerGateway();
  const worker = new WorkerHost({
    checkpoints: unwiredCheckpoints,
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger: logger ?? { info: () => {}, warn: () => {}, error: () => {} },
    runtimes: { launcherFor: () => ({ start: () => run }) },
    timeouts: { ...timeouts, ...overrides },
    workspace: noWorkspace,
  });
  return { gateway, worker };
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > 2_000) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

/** A tool call in the run's own words: no Claude message shape anywhere. */
function call(run: ScriptedRun, sent: AgentInput, id: string): void {
  const input = { command: `run ${id}` };
  run.push(
    publicEvent(
      id,
      "system",
      { type: "system", subtype: "tool_call", call: id },
      [sent.uuid],
    ),
    { type: "tool.called", toolCallId: id, tool: "shell" },
    {
      type: "approval.requested",
      request: {
        localId: `local-${id}`,
        toolCallId: id,
        tool: { name: "shell", input },
        inputHash: approvalInputHash("shell", input),
        kind: "permission",
        askedAt: performance.now(),
      },
    },
  );
}

describe("WorkerHost over a run that implements the contract itself", () => {
  test("puts a request the run calls a question to the person as one, whatever its tool is named", async () => {
    const run = new ScriptedRun();
    const input = {
      questions: [
        {
          question: "Which environment?",
          options: [{ label: "staging" }, { label: "production" }],
        },
      ],
    };
    run.onSend = (sent) => {
      const block = { type: "tool_use", id: "call_1", name: "ask_human" };
      const message = { role: "assistant", content: [block] };
      run.push(
        publicEvent(
          "call_1",
          "tool_use",
          { type: "assistant", message, parent_tool_use_id: null },
          [sent.uuid],
        ),
        { type: "tool.called", toolCallId: "call_1", tool: "ask_human" },
        {
          type: "approval.requested",
          request: {
            localId: "local-1",
            toolCallId: "call_1",
            tool: { name: "ask_human", input },
            inputHash: approvalInputHash("ask_human", input),
            kind: "question",
            askedAt: performance.now(),
          },
        },
      );
      run.onAnswer = () => finish(run, sent);
    };
    const { gateway, worker } = host(run);
    gateway.enqueue("pick one");
    const loop = worker.runLoop();
    for (let waited = 0; gateway.registered().length === 0; waited += 5) {
      if (waited > 2_000) throw new Error("nothing was registered");
      await Bun.sleep(5);
    }
    const [registration] = gateway.registered();
    expect(registration?.request).toMatchObject({ kind: "question" });
    gateway.answer({
      request_id: registration?.request_id ?? "",
      kind: "question",
      answers: [{ question_id: "q0", selected_option_ids: ["q0o1"] }],
    });

    const summary = await loop;

    expect(run.answers).toEqual([
      {
        localId: "local-1",
        inputHash: approvalInputHash("ask_human", input),
        kind: "answered",
        answers: { "Which environment?": "production" },
      },
    ]);
    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
  });

  test("waits for a run that is still closing before it releases", async () => {
    const run = new ScriptedRun();
    run.onSend = (sent) => finish(run, sent);
    let closed = false;
    run.closing = async () => {
      await Bun.sleep(100);
      closed = true;
    };
    const { gateway, worker } = host(run);
    gateway.enqueue("hello");

    await worker.runLoop();

    expect(closed).toBe(true);
    expect(gateway.releases).toHaveLength(1);
  });

  test("reports a close that fails instead of leaving it unhandled", async () => {
    const run = new ScriptedRun();
    run.onSend = (sent) => finish(run, sent);
    run.closing = () => Promise.reject(new Error("engine would not stop"));
    const warned: Array<{ event: string; fields: unknown }> = [];
    const { gateway, worker } = host(run, {
      info: () => {},
      warn: (event, fields) => warned.push({ event, fields }),
      error: () => {},
    });
    gateway.enqueue("hello");

    const summary = await worker.runLoop();

    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
    expect(warned).toContainEqual({
      event: "worker.close.failed",
      fields: { reason: "engine would not stop" },
    });
  });

  test("asks and settles an approval on each of two turns of a run that publishes no Claude tool_use", async () => {
    const run = new ScriptedRun();
    let turns = 0;
    run.onSend = (sent) => {
      turns += 1;
      const id = `call_${turns}`;
      call(run, sent, id);
      run.onAnswer = (answer) => {
        if (answer.localId === `local-${id}`) finish(run, sent);
      };
    };
    const { gateway, worker } = host(run);
    // The batch carrying the first call is held: nothing may be registered
    // for it until the gateway has stored it.
    let releaseCall: (() => void) | undefined;
    const callHeld = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    let callSent = false;
    const append = gateway.appendEvents.bind(gateway);
    gateway.appendEvents = async (request) => {
      const carries = request.events.some(
        (event) => event.event === "system" && event.data.call === "call_1",
      );
      if (carries) {
        callSent = true;
        await callHeld;
      }
      return append(request);
    };
    gateway.enqueue("first");
    gateway.enqueue("second");
    const loop = worker.runLoop();
    await until(() => callSent, "call_1 sent");
    await Bun.sleep(50);
    expect(gateway.registered()).toEqual([]);
    releaseCall?.();
    for (const id of ["call_1", "call_2"]) {
      await until(
        () =>
          gateway
            .registered()
            .some((entry) => entry.announce?.tool_use_id === id),
        `${id} registered`,
      );
      gateway.answer({
        request_id: gateway.requestIdFor(id),
        kind: "permission",
        decision: "allow",
      });
    }

    const summary = await loop;

    expect(run.answers.map(({ localId, kind }) => ({ localId, kind }))).toEqual(
      [
        { localId: "local-call_1", kind: "selected" },
        { localId: "local-call_2", kind: "selected" },
      ],
    );
    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
      { turnId: "2", status: "completed", reason: null },
    ]);
  });

  test("ends turns whose terminal reports no cost, with no cost recorded", async () => {
    const run = new ScriptedRun();
    run.onSend = (sent) => finish(run, sent);
    const { gateway, worker } = host(run);
    gateway.enqueue("first");
    gateway.enqueue("second");

    const summary = await worker.runLoop();

    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
      { turnId: "2", status: "completed", reason: null },
    ]);
    expect(gateway.finalized.map((entry) => entry.terminal.cost_usd)).toEqual([
      null,
      null,
    ]);
  });

  test("charges a turn what the terminals it did not settle reported", async () => {
    const run = new ScriptedRun();
    run.onSend = (sent) => {
      // A terminal for an input that is not this turn's settles nothing.
      run.push(
        turnEnded(
          { ...sent, uuid: "someone-else" },
          { cost: { deltaUsd: 0.25, countRestarted: false, unknown: false } },
        ),
      );
      finish(run, sent, {
        cost: { deltaUsd: 0.5, countRestarted: false, unknown: false },
      });
    };
    const { gateway, worker } = host(run);
    gateway.enqueue("hello");

    await worker.runLoop();

    expect(gateway.finalized.map((entry) => entry.terminal.cost_usd)).toEqual([
      0.75,
    ]);
  });

  test("leaves what a turn of unknown cost carried for the next turn that reports", async () => {
    const run = new ScriptedRun();
    let turns = 0;
    run.onSend = (sent) => {
      turns += 1;
      if (turns === 1) {
        run.push(
          turnEnded(
            { ...sent, uuid: "someone-else" },
            { cost: { deltaUsd: 0.25, countRestarted: false, unknown: false } },
          ),
        );
        finish(run, sent);
        return;
      }
      finish(run, sent, {
        cost: { deltaUsd: 0.5, countRestarted: false, unknown: false },
      });
    };
    const { gateway, worker } = host(run);
    gateway.enqueue("first");
    gateway.enqueue("second");

    await worker.runLoop();

    expect(gateway.finalized.map((entry) => entry.terminal.cost_usd)).toEqual([
      null,
      0.75,
    ]);
  });

  test("counts the tool call wait from when the run asked, not from when the host heard", async () => {
    const run = new ScriptedRun();
    const waitMs = 400;
    let answeredAfter: number | undefined;
    run.onSend = (sent) => {
      const input = { command: "ls" };
      const pushedAt = performance.now();
      run.onAnswer = () => {
        answeredAfter = performance.now() - pushedAt;
        finish(run, sent);
      };
      // The run held this request most of the wait already; its call never
      // comes.
      run.push({
        type: "approval.requested",
        request: {
          localId: "local-late",
          toolCallId: "call_never",
          tool: { name: "shell", input },
          inputHash: approvalInputHash("shell", input),
          kind: "permission",
          askedAt: pushedAt - (waitMs - 50),
        },
      });
    };
    const { gateway, worker } = host(run, undefined, {
      toolUseFrameWaitMs: waitMs,
    });
    gateway.enqueue("hello");

    await worker.runLoop();

    expect(run.answers).toEqual([
      expect.objectContaining({
        localId: "local-late",
        kind: "cancelled",
        reason: "refused",
      }),
    ]);
    expect(answeredAfter).toBeLessThan(waitMs / 2);
  });

  test("keeps a late event for the previous input out of the turn that named its own", async () => {
    const run = new ScriptedRun();
    const sent: AgentInput[] = [];
    const lifecycle = (id: string, inputs: readonly string[]) =>
      publicEvent(id, "system", { type: "system", subtype: id }, inputs);
    run.onSend = (input) => {
      sent.push(input);
      const [first, second] = sent;
      if (second === undefined) {
        if (first !== undefined) finish(run, first);
        return;
      }
      run.push(
        lifecycle("second_queued", [second.uuid]),
        // The previous input's own word, after the next one was named.
        lifecycle("first_completed", [first?.uuid ?? ""]),
        lifecycle("unnamed", []),
      );
      finish(run, second);
    };
    const { gateway, worker } = host(run);
    gateway.enqueue("first");
    gateway.enqueue("second");

    await worker.runLoop();

    const turnOf = new Map(
      gateway.batches.flatMap((batch) =>
        batch.events.flatMap((event) =>
          event.event === "system" ? [[event.data.subtype, batch.turn_id]] : [],
        ),
      ),
    );
    expect(Object.fromEntries(turnOf)).toMatchObject({
      second_queued: "2",
      first_completed: null,
      unnamed: "2",
    });
  });

  test("enters a turn on an input named by a message that published nothing", async () => {
    const run = new ScriptedRun();
    const sent: AgentInput[] = [];
    run.onSend = (input) => {
      sent.push(input);
      const [first, second] = sent;
      if (second === undefined) {
        if (first !== undefined) finish(run, first);
        return;
      }
      run.push(
        { type: "inputs.named", inputs: [second.uuid] },
        publicEvent("unnamed", "system", {
          type: "system",
          subtype: "unnamed",
        }),
      );
      finish(run, second);
    };
    const { gateway, worker } = host(run);
    gateway.enqueue("first");
    gateway.enqueue("second");

    await worker.runLoop();

    const unnamed = gateway.batches.find((batch) =>
      batch.events.some(
        (event) => event.event === "system" && event.data.subtype === "unnamed",
      ),
    );
    expect(unnamed?.turn_id).toBe("2");
  });
});
