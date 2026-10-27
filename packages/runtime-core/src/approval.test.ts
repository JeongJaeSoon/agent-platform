import { describe, expect, test } from "bun:test";

import {
  ApprovalChannel,
  type ApprovalGrant,
  type ApprovalRequested,
  approvalInputHash,
} from "./approval.ts";

function requested(localId: string, command = "ls"): ApprovalRequested {
  const input = { command };
  return {
    localId,
    toolCallId: `toolu_${localId}`,
    tool: { name: "Bash", input },
    inputHash: approvalInputHash("Bash", input),
    askedAt: performance.now(),
    kind: "permission",
    display: input,
  };
}

const allow = (request: ApprovalRequested) => ({
  localId: request.localId,
  inputHash: request.inputHash,
  kind: "selected" as const,
  optionKind: "allow_once" as const,
});

describe("ApprovalChannel", () => {
  test("settles a request once: the first fitting answer wins, a repeat is stale", async () => {
    const channel = new ApprovalChannel();
    const request = requested("a");
    const settled = channel.request(request, new AbortController().signal);

    expect(channel.answer(allow(request))).toBe("applied");
    expect(
      channel.answer({
        ...allow(request),
        kind: "selected",
        optionKind: "reject_once",
      }),
    ).toBe("stale");
    expect(await settled).toEqual(allow(request));
    expect(channel.open).toBe(0);
  });

  test("leaves a request open to an answer meant for other arguments", async () => {
    const channel = new ApprovalChannel();
    const request = requested("a");
    const settled = channel.request(request, new AbortController().signal);

    expect(
      channel.answer({
        ...allow(request),
        inputHash: approvalInputHash("Bash", { command: "rm -rf /" }),
      }),
    ).toBe("stale");
    expect(channel.open).toBe(1);
    expect(channel.answer(allow(request))).toBe("applied");
    expect((await settled).kind).toBe("selected");
  });

  test("calls an answer for a request it never had unknown", () => {
    const channel = new ApprovalChannel();
    expect(channel.answer(allow(requested("never")))).toBe("unknown");
  });

  test("settles a request whose call is aborted as an interrupt", async () => {
    const channel = new ApprovalChannel();
    const controller = new AbortController();
    const request = requested("a");
    const settled = channel.request(request, controller.signal);
    controller.abort();

    expect(await settled).toEqual({
      localId: "a",
      inputHash: request.inputHash,
      kind: "cancelled",
      reason: "interrupt",
    });
    expect(channel.answer(allow(request))).toBe("stale");
  });

  test("refuses the same request id twice, even once settled", () => {
    const channel = new ApprovalChannel();
    const request = requested("a");
    void channel.request(request, new AbortController().signal);
    channel.answer(allow(request));

    expect(() =>
      channel.request(request, new AbortController().signal),
    ).toThrow("already requested");
  });

  test("cancels everything open with the reason and words given", async () => {
    const channel = new ApprovalChannel();
    const first = channel.request(requested("a"), new AbortController().signal);
    const second = channel.request(
      requested("b", "pwd"),
      new AbortController().signal,
    );
    channel.cancelAll("shutdown", "going away");

    for (const settled of [await first, await second]) {
      expect(settled).toMatchObject({
        kind: "cancelled",
        reason: "shutdown",
        message: "going away",
      });
    }
    expect(channel.open).toBe(0);
  });

  test("spends a grant once, for its turn, tool and arguments only", () => {
    const hash = approvalInputHash("Bash", { command: "ls" });
    const grant: ApprovalGrant = {
      turnUuid: "turn-1",
      tool: "Bash",
      inputHash: hash,
      decision: { kind: "selected", optionKind: "allow_once" },
    };
    const channel = new ApprovalChannel([grant]);

    expect(channel.consumeGrant("turn-2", "Bash", hash)).toBeUndefined();
    expect(channel.consumeGrant("turn-1", "Edit", hash)).toBeUndefined();
    expect(channel.consumeGrant("turn-1", "Bash", "0".repeat(64))).toBe(
      undefined,
    );
    expect(channel.consumeGrant("turn-1", "Bash", hash)).toEqual(
      grant.decision,
    );
    expect(channel.consumeGrant("turn-1", "Bash", hash)).toBeUndefined();
  });

  test("drops what is left of a turn's grants and keeps the others", () => {
    const hash = approvalInputHash("Bash", { command: "ls" });
    const decision = { kind: "selected", optionKind: "allow_once" } as const;
    const channel = new ApprovalChannel([
      { turnUuid: "turn-1", tool: "Bash", inputHash: hash, decision },
      { turnUuid: "turn-2", tool: "Bash", inputHash: hash, decision },
    ]);
    channel.dropGrants("turn-1");

    expect(channel.consumeGrant("turn-1", "Bash", hash)).toBeUndefined();
    expect(channel.consumeGrant("turn-2", "Bash", hash)).toEqual(decision);
  });
});

describe("approvalInputHash", () => {
  test("does not depend on key order, and does on every value", () => {
    expect(approvalInputHash("Bash", { a: 1, b: 2 })).toBe(
      approvalInputHash("Bash", { b: 2, a: 1 }),
    );
    expect(approvalInputHash("Bash", { a: 1 })).not.toBe(
      approvalInputHash("Edit", { a: 1 }),
    );
    expect(approvalInputHash("Bash", { a: 1 })).not.toBe(
      approvalInputHash("Bash", { a: 2 }),
    );
  });
});
