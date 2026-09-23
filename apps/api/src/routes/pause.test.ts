import { describe, expect, test } from "bun:test";
import {
  type ApiErrorCode,
  apiErrorResponseSchema,
} from "@agent-platform/contracts";
import {
  createSessionService,
  ownerScopedPolicy,
  type PauseSessionResult,
  type SessionControl,
} from "@agent-platform/platform";
import { createApiApp } from "../app.ts";
import { registerPauseRoutes } from "./pause.ts";

const sessionId = "019a0000-0000-7000-8000-000000000001";
const path = `/v1/sessions/${sessionId}/pause`;

const notReached = async (): Promise<never> => {
  throw new Error("not reached");
};

function pause(
  body: unknown,
  pauseAtomic: SessionControl["pauseAtomic"] = notReached,
  headers: Record<string, string> = {},
  at = path,
) {
  const service = createSessionService({
    authorization: ownerScopedPolicy,
    catalog: { profiles: {}, repositories: {} },
    inputs: { acceptInputAtomic: notReached, appendInputAtomic: notReached },
    controls: {
      terminateAtomic: notReached,
      pauseAtomic,
      decideRecoveryAtomic: notReached,
      resumeAtomic: notReached,
    },
    reader: {
      listSessions: notReached,
      getSession: notReached,
      listTurns: notReached,
      getTurn: notReached,
      getReceipt: notReached,
      readEvents: notReached,
    },
  });
  const app = createApiApp({
    authMode: "none",
    registerRoutes: (router) => registerPauseRoutes(router, service),
  });
  return app.request(at, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Owner-Id": "owner-a",
      "Idempotency-Key": "key-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function errorCode(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

const answering =
  (result: PauseSessionResult): SessionControl["pauseAtomic"] =>
  async () =>
    result;

describe("POST /v1/sessions/{id}/pause", () => {
  test("answers 202 with the receipt, passing revision and reason through", async () => {
    const receiptId = crypto.randomUUID();
    const response = await pause(
      { expected_revision: 3, reason: "overnight" },
      async (input) => {
        expect(input).toMatchObject({
          principal: { ownerId: "owner-a" },
          sessionId,
          idempotencyKey: "key-1",
          expectedRevision: 3,
          reason: "overnight",
        });
        return {
          outcome: "accepted",
          response: { receipt_id: receiptId, receipt_status: "accepted" },
        };
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      receipt_id: receiptId,
      receipt_status: "accepted",
    });
  });

  test("requires Idempotency-Key and expected_revision, and rejects extra fields", async () => {
    expect(
      (
        await pause({ expected_revision: 1 }, notReached, {
          "Idempotency-Key": "",
        })
      ).status,
    ).toBe(400);
    expect((await pause({ reason: "no revision" })).status).toBe(400);
    expect((await pause({ expected_revision: 1, force: true })).status).toBe(
      400,
    );
    expect(
      (
        await pause(
          { expected_revision: 1 },
          notReached,
          {},
          "/v1/sessions/not-a-uuid/pause",
        )
      ).status,
    ).toBe(404);
  });

  test("maps each refusal to its status and code", async () => {
    const cases: Array<[PauseSessionResult, number, ApiErrorCode]> = [
      [
        { outcome: "revision_conflict", currentRevision: 4 },
        409,
        "REVISION_CONFLICT",
      ],
      [{ outcome: "conflict" }, 409, "IDEMPOTENCY_CONFLICT"],
      [
        { outcome: "rejected", admissionState: "pausing" },
        409,
        "SESSION_PAUSED",
      ],
      [
        { outcome: "rejected", admissionState: "paused" },
        409,
        "SESSION_PAUSED",
      ],
      [
        { outcome: "rejected", admissionState: "resuming" },
        409,
        "SESSION_RESUMING",
      ],
      [
        { outcome: "rejected", admissionState: "stopped" },
        409,
        "SESSION_STOPPED",
      ],
      [
        { outcome: "rejected", admissionState: "recovery_required" },
        409,
        "RECOVERY_REQUIRED",
      ],
      [
        { outcome: "rejected", admissionState: "closed" },
        409,
        "SESSION_CLOSED",
      ],
      [{ outcome: "checkpoint_unavailable" }, 409, "CHECKPOINT_UNAVAILABLE"],
      [{ outcome: "unsupported" }, 422, "UNSUPPORTED_CAPABILITY"],
      [{ outcome: "not_found" }, 404, "NOT_FOUND"],
    ];
    for (const [result, status, code] of cases) {
      const response = await pause({ expected_revision: 1 }, answering(result));
      expect([response.status, await errorCode(response)]).toEqual([
        status,
        code,
      ]);
    }
  });
});
