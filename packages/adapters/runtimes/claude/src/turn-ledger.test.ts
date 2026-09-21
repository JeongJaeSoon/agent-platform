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
  test("keeps rejecting until every queued input has produced a result", () => {
    const ledger = new TurnLedger();
    expect(ledger.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "No SDK session has started",
    });
    ledger.queued();
    ledger.queued();
    ledger.observe({ type: "system", subtype: "init", session_id: "s1" });
    ledger.observe({ type: "result", session_id: "s1" });
    expect(ledger.prepareCheckpoint()).toEqual(running);
    ledger.observe({ type: "assistant" });
    expect(ledger.prepareCheckpoint()).toEqual(running);
    ledger.observe({ type: "result", session_id: "s1" });
    expect(ledger.prepareCheckpoint()).toEqual(ready);
  });

  test("a resumed run is checkpointable until new input is queued", () => {
    const ledger = new TurnLedger("s1");
    expect(ledger.prepareCheckpoint()).toEqual(ready);
    ledger.queued();
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
