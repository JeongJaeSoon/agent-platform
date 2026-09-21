import { describe, expect, test } from "bun:test";

import { TurnLedger } from "./turn-ledger.ts";

const ready = {
  status: "ready" as const,
  checkpoint: { engine: "claude", resume: "s1", sdkVersion: "0.3.270" },
};
const running = {
  status: "rejected" as const,
  reason: "A turn is still running",
};

describe("turn ledger", () => {
  test("keeps rejecting until a result has consumed every queued uuid", () => {
    const ledger = new TurnLedger();
    expect(ledger.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "No SDK session has started",
    });
    ledger.queued("a");
    ledger.queued("b");
    ledger.observe({ type: "system", subtype: "init", session_id: "s1" });
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "a",
    });
    expect(ledger.prepareCheckpoint()).toEqual(running);
    ledger.observe({ type: "assistant" });
    expect(ledger.prepareCheckpoint()).toEqual(running);
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "b",
    });
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("one result can settle several sends folded into a single turn", () => {
    const ledger = new TurnLedger("s1");
    ledger.queued("a");
    ledger.queued("b");
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "b",
      user_message_uuids: ["a", "b"],
    });
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("a result without uuid attribution settles nothing", () => {
    const ledger = new TurnLedger("s1");
    ledger.queued("a");
    ledger.observe({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      queued_turn_count: 1,
      session_id: "s1",
    });
    expect(ledger.prepareCheckpoint()).toEqual(running);
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "a",
    });
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("refuses to queue a uuid that is already pending", () => {
    const ledger = new TurnLedger("s1");
    ledger.queued("a");
    expect(() => ledger.queued("a")).toThrow("Input uuid is already queued: a");
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "a",
    });
    ledger.queued("a");
    expect(ledger.prepareCheckpoint()).toEqual(running);
  });

  test("informational frames after a result do not reopen an idle turn", () => {
    const ledger = new TurnLedger("s1");
    ledger.queued("a");
    ledger.observe({
      type: "result",
      session_id: "s1",
      user_message_uuid: "a",
    });
    ledger.observe({ type: "tool_use_summary" });
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("a resumed run is checkpointable until new input is queued", () => {
    const ledger = new TurnLedger("s1");
    expect(ledger.prepareCheckpoint()).toEqual(ready);
    ledger.queued("a");
    expect(ledger.prepareCheckpoint()).toEqual(running);
  });

  test("allows exactly one event consumer", () => {
    const ledger = new TurnLedger();
    ledger.claimConsumer();
    expect(() => ledger.claimConsumer()).toThrow(
      "AgentRun events can only be consumed once",
    );
  });
});
