import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@werft-ai/contracts";
import type {
  ApprovalRequested,
  NativeSdkMessage,
  RuntimeEvent,
} from "@werft-ai/runtime-core";

import { claudeContractRun } from "./contract.ts";
import type {
  AgentFrame,
  DriverRun,
  PermissionDecision,
  RuntimeHooks,
} from "./driver.ts";

function scriptedDriver() {
  const frames: AgentFrame[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let hooks: RuntimeHooks | undefined;
  const driver: DriverRun = {
    abort: () => {},
    close: () => {},
    async *events() {
      for (;;) {
        const frame = frames.shift();
        if (frame !== undefined) {
          yield frame;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    finishInput: () => {},
    holdsInput: async () => false,
    ready: async () => {},
    interrupt: async () => ({ stillQueued: [] }),
    leaseCheckpoint: () => Promise.reject(new Error("not used")),
    prepareCheckpoint: () => Promise.reject(new Error("not used")),
    send: () => {},
    [Symbol.asyncIterator]: () => driver.events()[Symbol.asyncIterator](),
  };
  return {
    start(given: RuntimeHooks) {
      hooks = given;
      return driver;
    },
    push(frame: AgentFrame) {
      frames.push(frame);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    ask(
      toolUseId: string,
      signal = new AbortController().signal,
      tool = "Bash",
      input: Record<string, unknown> = { command: "ls" },
    ) {
      if (hooks === undefined) throw new Error("not started");
      return hooks.onPermission({
        input,
        requestId: toolUseId,
        signal,
        tool,
        toolUseId,
      });
    },
  };
}

function toolUseFrame(toolUseId: string): AgentFrame {
  const message: NativeSdkMessage = {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: {} }],
    },
  };
  const event = {
    event: "tool_use",
    data: { tool_use_id: toolUseId },
  } as unknown as SessionEvent;
  return {
    envelope: {
      correlation_id: "c",
      message,
      schema_version: "sdk-envelope/v1",
      sdk_version: "test",
    },
    events: [event],
  };
}

async function collect(
  iterator: AsyncIterator<RuntimeEvent>,
  count: number,
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  while (events.length < count) {
    const next = await iterator.next();
    if (next.done === true) break;
    events.push(next.value);
  }
  return events;
}

const requestOf = (event: RuntimeEvent | undefined): ApprovalRequested => {
  if (event?.type !== "approval.requested") {
    throw new Error(`expected approval.requested, got ${event?.type}`);
  }
  return event.request;
};

describe("claudeContractRun", () => {
  test("emits a message's public events, then its tool calls, then native, then the approval for the call", async () => {
    const script = scriptedDriver();
    const run = claudeContractRun((hooks) => script.start(hooks));
    const events = run.events()[Symbol.asyncIterator]();
    const pending = collect(events, 4);
    const decision = script.ask("toolu_1");
    script.push(toolUseFrame("toolu_1"));
    const emitted = await pending;

    expect(emitted.map((event) => event.type)).toEqual([
      "public",
      "tool.called",
      "native",
      "approval.requested",
    ]);
    const request = requestOf(emitted[3]);
    expect(request).toMatchObject({
      toolCallId: "toolu_1",
      tool: { name: "Bash", input: { command: "ls" } },
      kind: "permission",
    });
    expect(
      await run.answer({
        localId: request.localId,
        inputHash: request.inputHash,
        kind: "selected",
        optionKind: "allow_once",
      }),
    ).toBe("applied");
    expect(await decision).toEqual({ behavior: "allow" });
    script.end();
  });

  test("refuses a request whose call never reaches the stream, without telling the host", async () => {
    const script = scriptedDriver();
    const run = claudeContractRun((hooks) => script.start(hooks), {
      toolCallWaitMs: 20,
    });
    const events = run.events()[Symbol.asyncIterator]();
    const first = events.next();

    const decision: PermissionDecision = await script.ask("toolu_lost");
    expect(decision).toEqual({
      behavior: "deny",
      message:
        "The events before this request could not be stored: The tool call toolu_lost did not reach the event stream within 20ms",
    });
    script.push(toolUseFrame("toolu_lost"));
    script.end();
    const rest = [(await first).value, ...(await collect(events, 10))];
    expect(rest.map((event) => event?.type)).toEqual([
      "public",
      "tool.called",
      "native",
    ]);
  });

  test("says a request the engine aborted is withdrawn once the host heard of it", async () => {
    const script = scriptedDriver();
    const run = claudeContractRun((hooks) => script.start(hooks));
    const events = run.events()[Symbol.asyncIterator]();
    script.push(toolUseFrame("toolu_2"));
    await collect(events, 3);
    const controller = new AbortController();
    const decision = script.ask("toolu_2", controller.signal);
    const request = requestOf((await collect(events, 1))[0]);
    controller.abort();

    expect(await decision).toEqual({
      behavior: "deny",
      message: "The run stopped before this was answered",
    });
    expect(await collect(events, 1)).toEqual([
      {
        type: "approval.resolved",
        localId: request.localId,
        outcome: "withdrawn",
      },
    ]);
    expect(
      await run.answer({
        localId: request.localId,
        inputHash: request.inputHash,
        kind: "selected",
        optionKind: "allow_once",
      }),
    ).toBe("stale");
    script.end();
  });

  test("refuses on the engine's side what is still held when the run closes", async () => {
    const script = scriptedDriver();
    const run = claudeContractRun((hooks) => script.start(hooks));
    const decision = script.ask("toolu_never");
    await run.close();

    expect(await decision).toEqual({
      behavior: "deny",
      message: "This worker is shutting down",
    });
  });

  test("tells the engine a cancellation's words, or the reason's own", async () => {
    const script = scriptedDriver();
    const run = claudeContractRun((hooks) => script.start(hooks));
    const events = run.events()[Symbol.asyncIterator]();
    script.push(toolUseFrame("toolu_a"));
    script.push(toolUseFrame("toolu_b"));
    await collect(events, 6);
    const first = script.ask("toolu_a");
    const a = requestOf((await collect(events, 1))[0]);
    const second = script.ask("toolu_b");
    const b = requestOf((await collect(events, 1))[0]);
    await run.answer({
      localId: a.localId,
      inputHash: a.inputHash,
      kind: "cancelled",
      reason: "refused",
      message: "No turn is running to ask in",
    });
    await run.answer({
      localId: b.localId,
      inputHash: b.inputHash,
      kind: "cancelled",
      reason: "expired",
    });

    expect(await first).toEqual({
      behavior: "deny",
      message: "No turn is running to ask in",
    });
    expect(await second).toEqual({
      behavior: "deny",
      message: "No answer arrived in time",
    });
    script.end();
  });

  test("throws a failing driver close at once instead of rejecting later", () => {
    const script = scriptedDriver();
    const run = claudeContractRun((hooks) => ({
      ...script.start(hooks),
      close: () => {
        throw new Error("engine would not stop");
      },
    }));

    let thrown: unknown;
    try {
      run.close().catch(() => {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(new Error("engine would not stop"));
  });

  test("hands a question's answers back on the tool input, and ends the turn on a park", async () => {
    const script = scriptedDriver();
    const run = claudeContractRun((hooks) => script.start(hooks));
    const events = run.events()[Symbol.asyncIterator]();
    script.push(toolUseFrame("toolu_q"));
    script.push(toolUseFrame("toolu_p"));
    await collect(events, 6);
    const questions = [{ question: "Which environment?", options: [] }];
    const asked = script.ask("toolu_q", undefined, "AskUserQuestion", {
      questions,
    });
    const question = requestOf((await collect(events, 1))[0]);
    const parked = script.ask("toolu_p");
    const permission = requestOf((await collect(events, 1))[0]);
    expect(question.kind).toBe("question");
    await run.answer({
      localId: question.localId,
      inputHash: question.inputHash,
      kind: "answered",
      answers: { "Which environment?": "production" },
    });
    await run.answer({
      localId: permission.localId,
      inputHash: permission.inputHash,
      kind: "cancelled",
      reason: "park",
    });

    expect(await asked).toEqual({
      behavior: "allow",
      updatedInput: {
        questions,
        answers: { "Which environment?": "production" },
      },
    });
    expect(await parked).toEqual({
      behavior: "deny",
      message: "The approval was set aside for a later turn",
      interrupt: true,
    });
    script.end();
  });
});
