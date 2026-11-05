import { describe, expect, test } from "bun:test";
import type { PushSourceResult } from "../checkpoints/checkpoint-service.ts";
import { pushApprovability } from "./push-approvability.ts";

const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const session = (checkpointRevision: number | null) => ({
  id: "11111111-1111-4111-8111-111111111111",
  checkpointRevision,
});
const request = (
  state: "requested" | "approved" | "rejected" = "requested",
  checkpointRevision = 3,
) => ({ state, checkpointRevision, gitCommit: COMMIT });
const source = (read: () => Promise<PushSourceResult>) => ({
  readPushSource: read,
  readPushSourceAt: read,
});

describe("pushApprovability", () => {
  test("a decided request is not approvable", async () => {
    for (const state of ["approved", "rejected"] as const) {
      expect(await pushApprovability(session(3), request(state))).toEqual({
        approvable: false,
        reason: "not_requested",
      });
    }
  });

  test("the request's own revision is approvable without reading anything", async () => {
    let reads = 0;
    const verdict = await pushApprovability(
      session(3),
      request(),
      source(async () => {
        reads += 1;
        return { status: "none" };
      }),
    );
    expect(verdict).toEqual({ approvable: true });
    expect(reads).toBe(0);
  });

  test("another revision of the same commit is approvable", async () => {
    const verdict = await pushApprovability(
      session(4),
      request(),
      source(async () => ({ status: "ready", revision: 4, gitCommit: COMMIT })),
    );
    expect(verdict).toEqual({ approvable: true });
  });

  test("another revision of another commit is checkpoint_moved", async () => {
    const verdict = await pushApprovability(
      session(4),
      request(),
      source(async () => ({ status: "ready", revision: 4, gitCommit: OTHER })),
    );
    expect(verdict).toEqual({ approvable: false, reason: "checkpoint_moved" });
  });

  test("a manifest that cannot be read leaves the revision rule alone", async () => {
    for (const read of [
      async (): Promise<PushSourceResult> => ({
        status: "unavailable",
        reason: "x",
      }),
      async (): Promise<PushSourceResult> => ({ status: "none" }),
      async (): Promise<PushSourceResult> => {
        throw new Error("store down");
      },
    ]) {
      expect(
        await pushApprovability(session(4), request(), source(read)),
      ).toEqual({ approvable: false, reason: "checkpoint_moved" });
    }
  });

  test("a pointer that moved during the read answers as the server would", async () => {
    // Read at revision 5 while the session row said 4: the server's FOR
    // SHARE check would find the pointer moved past what it was told.
    const verdict = await pushApprovability(
      session(4),
      request(),
      source(async () => ({ status: "ready", revision: 5, gitCommit: COMMIT })),
    );
    expect(verdict).toEqual({ approvable: false, reason: "checkpoint_moved" });
  });

  test("without a source a moved revision counts as approvable", async () => {
    expect(await pushApprovability(session(4), request())).toEqual({
      approvable: true,
    });
    expect(await pushApprovability(session(null), request())).toEqual({
      approvable: true,
    });
    expect(await pushApprovability(session(4), request("approved"))).toEqual({
      approvable: false,
      reason: "not_requested",
    });
  });
});
