import { describe, expect, test } from "bun:test";
import type { NativeSdkMessage } from "@agent-platform/runtime-core";
import { TurnAccounting } from "./turn-accounting.ts";

function result(total: unknown, sessionId = "s"): NativeSdkMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: sessionId,
    total_cost_usd: total,
  } as NativeSdkMessage;
}

function charges(totals: unknown[]): number[] {
  const accounting = new TurnAccounting();
  return totals.map((total) => {
    accounting.observe(result(total));
    return accounting.settle().costUsd;
  });
}

describe("TurnAccounting", () => {
  test("charges each turn the difference from the previous running total", () => {
    expect(charges([0.25, 0.75, 1])).toEqual([0.25, 0.5, 0.25]);
  });

  test("a total that drops counts the new total in full", () => {
    expect(charges([1, 0.25, 0.5])).toEqual([1, 0.25, 0.25]);
  });

  test("a new engine session counts its total in full even when it is higher", () => {
    const accounting = new TurnAccounting();
    accounting.observe(result(0.25, "first"));
    expect(accounting.settle().costUsd).toBe(0.25);
    accounting.observe(result(0.75, "after-clear"));
    expect(accounting.settle().costUsd).toBe(0.75);
    accounting.observe(result(1, "after-clear"));
    expect(accounting.settle().costUsd).toBe(0.25);
  });

  test("a zero total after spending charges nothing and keeps the baseline", () => {
    expect(charges([1, 0, 1.5])).toEqual([1, 0, 0.5]);
  });

  test("ignores totals that are missing or not a cost", () => {
    expect(charges([undefined, -1, Number.NaN, 0.5])).toEqual([0, 0, 0, 0.5]);
  });

  test("a result nobody settled rides on the next settlement", () => {
    const accounting = new TurnAccounting();
    accounting.observe(result(0.25));
    accounting.observe(result(0.75));
    expect(accounting.settle().costUsd).toBe(0.75);
    expect(accounting.settle().costUsd).toBe(0);
  });

  test("remembers the last retry status, and forgets it once a request succeeds", () => {
    const accounting = new TurnAccounting();
    accounting.observe({
      type: "system",
      subtype: "api_retry",
      error: "rate_limit",
      error_status: 429,
      session_id: "s",
    } as NativeSdkMessage);
    accounting.observe({
      type: "assistant",
      error: "rate_limit",
    } as NativeSdkMessage);
    expect(accounting.settle().providerFailure).toEqual({
      error: "rate_limit",
      status: 429,
    });

    accounting.observe({
      type: "system",
      subtype: "api_retry",
      error_status: 500,
      session_id: "s",
    } as NativeSdkMessage);
    accounting.observe({ type: "assistant" } as NativeSdkMessage);
    expect(accounting.settle().providerFailure).toBeUndefined();
  });

  test("a connection failure has no status", () => {
    const accounting = new TurnAccounting();
    accounting.observe({
      type: "system",
      subtype: "api_retry",
      error: "unknown",
      error_status: null,
      session_id: "s",
    } as NativeSdkMessage);
    expect(accounting.settle().providerFailure).toEqual({
      error: "unknown",
      status: null,
    });
  });
});
