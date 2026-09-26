import { describe, expect, test } from "bun:test";
import {
  type ApiErrorCode,
  apiErrorResponseSchema,
  listPendingRequestsResponseSchema,
} from "@agent-platform/contracts";
import {
  type AnswerRequestInput,
  type AnswerRequestResult,
  allowAllPolicy,
  createPendingRequestService,
  type PendingRequestStore,
} from "@agent-platform/platform";
import { createApiApp } from "../app.ts";
import { registerPendingRoutes } from "./pending.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";

function app(overrides: Partial<PendingRequestStore> = {}) {
  const service = createPendingRequestService({
    authorization: allowAllPolicy,
    store: {
      listOpen: async () => null,
      answerAtomic: async () => {
        throw new Error("not reached");
      },
      ...overrides,
    },
  });
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) => registerPendingRoutes(router, service),
  });
}

function answer(
  result: AnswerRequestResult,
  body: unknown = {
    request_id: "req_1",
    kind: "permission",
    decision: "allow",
  },
  headers: Record<string, string> = { "Idempotency-Key": "key-1" },
) {
  const seen: AnswerRequestInput[] = [];
  const response = app({
    answerAtomic: async (input) => {
      seen.push(input);
      return result;
    },
  }).request(`/v1/sessions/${SESSION}/answers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Owner-Id": "owner-a",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { response, seen };
}

async function errorOf(response: Response | Promise<Response>) {
  const settled = await response;
  return {
    status: settled.status,
    code: apiErrorResponseSchema.parse(await settled.json()).error.code,
  };
}

describe("pending-request routes", () => {
  test("GET lists the owner's open requests", async () => {
    const response = await app({
      listOpen: async (ownerId, sessionId) =>
        ownerId === "owner-a" && sessionId === SESSION
          ? [
              {
                request_id: "req_1",
                kind: "permission",
                turn_id: "1",
                attempt_id: "att_1",
                tool: "Bash",
                input: { command: "ls" },
                created_at: "2026-09-23T00:00:00.000Z",
                expires_at: "2026-09-23T00:30:00.000Z",
              },
            ]
          : null,
    }).request(`/v1/sessions/${SESSION}/pending-requests`, {
      headers: { "X-Owner-Id": "owner-a" },
    });
    expect(response.status).toBe(200);
    const body = listPendingRequestsResponseSchema.parse(await response.json());
    expect(body.items.map((item) => item.request_id)).toEqual(["req_1"]);
  });

  test("GET answers 404 for a session the caller cannot see", async () => {
    expect(
      await errorOf(
        app().request(`/v1/sessions/${SESSION}/pending-requests`, {
          headers: { "X-Owner-Id": "owner-a" },
        }),
      ),
    ).toEqual({ status: 404, code: "NOT_FOUND" });
  });

  test("POST accepts with 202 and hands the store the body and key", async () => {
    const { response, seen } = answer({
      outcome: "accepted",
      response: {
        receipt_id: "019a0000-0000-7000-8000-000000000001",
        receipt_status: "accepted",
      },
    });
    const settled = await response;
    expect(settled.status).toBe(202);
    expect(await settled.json()).toEqual({
      receipt_id: "019a0000-0000-7000-8000-000000000001",
      receipt_status: "accepted",
    });
    expect(seen[0]).toMatchObject({
      principal: { ownerId: "owner-a" },
      sessionId: SESSION,
      idempotencyKey: "key-1",
      answer: { request_id: "req_1", kind: "permission", decision: "allow" },
    });
  });

  test("POST maps each refusal to its status and code", async () => {
    const cases: Array<[AnswerRequestResult, number, ApiErrorCode]> = [
      [{ outcome: "expired" }, 409, "REQUEST_EXPIRED"],
      [{ outcome: "stale" }, 409, "REQUEST_STALE"],
      [{ outcome: "conflict" }, 409, "IDEMPOTENCY_CONFLICT"],
      [{ outcome: "not_found" }, 404, "NOT_FOUND"],
      [
        { outcome: "invalid", reason: "Question q0 has no option x" },
        400,
        "BAD_REQUEST",
      ],
    ];
    for (const [result, status, code] of cases) {
      expect(await errorOf(answer(result).response)).toEqual({ status, code });
    }
  });

  test("POST needs an Idempotency-Key and a well-formed answer", async () => {
    const accepted: AnswerRequestResult = { outcome: "not_found" };
    expect(await errorOf(answer(accepted, undefined, {}).response)).toEqual({
      status: 400,
      code: "BAD_REQUEST",
    });
    // A denial without a reason gives the model nothing to act on.
    expect(
      await errorOf(
        answer(accepted, {
          request_id: "req_1",
          kind: "permission",
          decision: "deny",
        }).response,
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
  });
});
