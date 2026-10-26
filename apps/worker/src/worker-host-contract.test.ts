import { describe, expect, test } from "bun:test";
import { type SessionEvent, sessionEventSchema } from "@werft-ai/contracts";
import {
  type AgentInput,
  approvalInputHash,
  type NativeSdkMessage,
  type RuntimeEvent,
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

function publicEvent(id: string, event: string, data: unknown): RuntimeEvent {
  return {
    type: "public",
    event: sessionEventSchema.parse({ id, event, data }) as SessionEvent,
  };
}

function native(message: NativeSdkMessage, input: AgentInput): RuntimeEvent {
  return { type: "native", message, inputs: [input.uuid] };
}

/** Ends the turn `input` started. */
function finish(run: ScriptedRun, input: AgentInput): void {
  const result = {
    type: "result",
    subtype: "success",
    session_id: "scripted-session",
    is_error: false,
    usage: { input_tokens: 1 },
  };
  run.push(
    publicEvent("result", "result", result),
    native({ ...result, user_message_uuid: input.uuid }, input),
  );
}

function host(run: ScriptedRun, logger?: WorkerLogger) {
  const gateway = new FakeWorkerGateway();
  const worker = new WorkerHost({
    checkpoints: unwiredCheckpoints,
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger: logger ?? { info: () => {}, warn: () => {}, error: () => {} },
    runtimes: { launcherFor: () => ({ start: () => run }) },
    timeouts,
    workspace: noWorkspace,
  });
  return { gateway, worker };
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
        publicEvent("call_1", "tool_use", {
          type: "assistant",
          message,
          parent_tool_use_id: null,
        }),
        { type: "tool.called", toolCallId: "call_1", tool: "ask_human" },
        native({ type: "assistant", message }, sent),
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
});
