import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  listPushRequestsResponseSchema,
  type PushRequest,
  pushRequestSchema,
  type SessionScope,
} from "@agent-platform/contracts";
import {
  type CreatePushRequestInput,
  createPushRequestService,
  type DecidePushRequestInput,
  type PushRefusalRecord,
  type PushRequestStore,
  type PushSourceResult,
} from "@agent-platform/platform";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerPushRequestRoutes } from "./push-requests.ts";

const createApiApp = recordRouteErrors("routes/push-requests.test.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
const PUSH = "22222222-2222-4222-8222-222222222222";
const RECEIPT = "33333333-3333-4333-8333-333333333333";
const COMMIT = "a".repeat(40);
const KEYS: Record<string, readonly SessionScope[]> = {
  csp_writer: ["sessions:read", "sessions:write"],
  csp_approver: ["sessions:read", "sessions:approve"],
};

const PINNED: PushRequest = {
  id: PUSH,
  session_id: SESSION,
  repository_id: "sample-app",
  checkpoint_revision: 2,
  git_commit: COMMIT,
  target_branch: `agent/${SESSION}`,
  state: "requested",
  requested_by: {
    principal: { kind: "api_key", id: "key-csp_writer" },
    actor_user_id: null,
    agent_id: null,
  },
  requested_at: "2026-10-13T00:00:00.000Z",
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  request_receipt_id: RECEIPT,
  decision_receipt_id: null,
};

type Seen = {
  created: CreatePushRequestInput[];
  decided: DecidePushRequestInput[];
  refusals: PushRefusalRecord[];
};

function app(
  options: {
    store?: Partial<PushRequestStore>;
    source?: PushSourceResult;
    authMode?: "none";
  } = {},
) {
  const seen: Seen = { created: [], decided: [], refusals: [] };
  const store: PushRequestStore = {
    findSession: async (ownerId, sessionId) =>
      ownerId === "owner-a" && sessionId === SESSION
        ? { repositoryId: "sample-app" }
        : null,
    recordRefusal: async (input) => {
      seen.refusals.push(input);
      return RECEIPT;
    },
    replayCreate: async () => null,
    create: async (input) => {
      seen.created.push(input);
      return { outcome: "written", request: PINNED };
    },
    list: async (ownerId, sessionId) =>
      ownerId === "owner-a" && sessionId === SESSION ? [PINNED] : null,
    get: async (ownerId, _sessionId, id) =>
      ownerId === "owner-a" && id === PUSH ? PINNED : null,
    decide: async (input) => {
      seen.decided.push(input);
      return {
        outcome: "written",
        request: { ...PINNED, state: "approved" },
      };
    },
    claimNextApproved: async () => null,
    finish: async () => false,
    ...options.store,
  };
  const service = createPushRequestService({
    store,
    source: {
      readPushSource: async () =>
        options.source ?? { status: "ready", revision: 2, gitCommit: COMMIT },
    },
  });
  const api = createApiApp({
    authMode: options.authMode ?? "api-key",
    keyStore: {
      async find(hash) {
        const token = Object.keys(KEYS).find((candidate) =>
          Buffer.from(hash).equals(Buffer.from(hashApiKey(candidate))),
        );
        return token
          ? {
              id: `key-${token}`,
              ownerId: "owner-a",
              workspaceId: null,
              scopes: [...(KEYS[token] ?? [])],
            }
          : null;
      },
    },
    registerRoutes: (router) => registerPushRequestRoutes(router, service),
  });
  return { api, seen };
}

function post(
  target: ReturnType<typeof app>,
  path: string,
  body: unknown,
  token = "csp_writer",
  headers: Record<string, string> = { "Idempotency-Key": "key-1" },
) {
  return target.api.request(`/v1/sessions/${SESSION}/push-requests${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const decide = (
  target: ReturnType<typeof app>,
  body: unknown,
  token = "csp_approver",
  headers?: Record<string, string>,
) => post(target, `/${PUSH}/decision`, body, token, headers);

async function errorOf(response: Response | Promise<Response>) {
  const settled = await response;
  const { error } = apiErrorResponseSchema.parse(await settled.json());
  return { status: settled.status, code: error.code, details: error.details };
}

describe("push request routes", () => {
  test("POST pins the latest checkpoint and the platform's branch", async () => {
    const target = app();
    const response = await post(target, "", {});
    expect(response.status).toBe(201);
    expect(pushRequestSchema.parse(await response.json()).id).toBe(PUSH);
    expect(target.seen.created).toEqual([
      {
        ownerId: "owner-a",
        sessionId: SESSION,
        actor: {
          principal: { kind: "api_key", id: "key-csp_writer" },
          actor_user_id: null,
          agent_id: null,
        },
        idempotencyKey: "key-1",
        payloadHash: expect.any(String),
        repositoryId: "sample-app",
        checkpointRevision: 2,
        gitCommit: COMMIT,
      },
    ]);
  });

  test("POST takes no say over the commit, repository or branch", async () => {
    const target = app();
    expect(
      await errorOf(post(target, "", { target_branch: "main" })),
    ).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(await errorOf(post(target, "", {}, "csp_writer", {}))).toMatchObject(
      { status: 400, code: "BAD_REQUEST" },
    );
    expect(
      await errorOf(post(target, "", { pad: "x".repeat(65 * 1024) })),
    ).toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
    expect(target.seen.created).toEqual([]);
  });

  test("POST refuses a session with nothing to push and records why", async () => {
    const cases: Array<[Parameters<typeof app>[0], string, string]> = [
      [
        { store: { findSession: async () => ({ repositoryId: null }) } },
        "PUSH_SOURCE_MISSING",
        "no_repository",
      ],
      [{ source: { status: "none" } }, "PUSH_SOURCE_MISSING", "no_checkpoint"],
      [
        { source: { status: "unavailable", reason: "manifest missing" } },
        "CHECKPOINT_UNAVAILABLE",
        "checkpoint_unavailable",
      ],
    ];
    for (const [options, code, refusal] of cases) {
      const target = app(options);
      expect(await errorOf(post(target, "", {}))).toEqual({
        status: 409,
        code: code as never,
        details: { refusal, receipt_id: RECEIPT },
      });
      expect(target.seen.refusals).toMatchObject([
        {
          ownerId: "owner-a",
          sessionId: SESSION,
          operation: "request_push",
          refusal,
          result: { verdict: "refuse", refusal, git_commit: null },
        },
      ]);
      expect(target.seen.created).toEqual([]);
    }
  });

  test("POST maps the store's refusals and conflicts", async () => {
    const refusedOpen = app({
      store: {
        create: async () => ({
          outcome: "refused",
          refusal: "request_open",
          receiptId: RECEIPT,
        }),
      },
    });
    expect(await errorOf(post(refusedOpen, "", {}))).toEqual({
      status: 409,
      code: "PUSH_REQUEST_OPEN",
      details: { refusal: "request_open", receipt_id: RECEIPT },
    });
    const moved = app({
      store: {
        create: async () => ({
          outcome: "refused",
          refusal: "checkpoint_moved",
          receiptId: RECEIPT,
        }),
      },
    });
    expect(await errorOf(post(moved, "", {}))).toMatchObject({
      status: 409,
      code: "CHECKPOINT_MOVED",
    });
    const conflict = app({
      store: { create: async () => ({ outcome: "conflict" }) },
    });
    expect(await errorOf(post(conflict, "", {}))).toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  test("POST answers 404 for another owner's session, with no receipt", async () => {
    const target = app({ store: { findSession: async () => null } });
    expect(await errorOf(post(target, "", {}))).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(target.seen.refusals).toEqual([]);
  });

  test("POST replays a created request without re-reading the checkpoint", async () => {
    const target = app({
      store: {
        replayCreate: async () => ({ outcome: "replayed", request: PINNED }),
      },
      source: { status: "unavailable", reason: "object store down" },
    });
    const response = await post(target, "", {});
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(PINNED);
    expect(target.seen.refusals).toEqual([]);
    expect(target.seen.created).toEqual([]);
  });

  test("GET lists and reads the owner's requests", async () => {
    const target = app();
    const listed = await target.api.request(
      `/v1/sessions/${SESSION}/push-requests`,
      { headers: { Authorization: "Bearer csp_writer" } },
    );
    expect(listed.status).toBe(200);
    expect(
      listPushRequestsResponseSchema.parse(await listed.json()).items,
    ).toHaveLength(1);
    const one = await target.api.request(
      `/v1/sessions/${SESSION}/push-requests/${PUSH}`,
      { headers: { Authorization: "Bearer csp_writer" } },
    );
    expect(pushRequestSchema.parse(await one.json()).git_commit).toBe(COMMIT);
    const otherSession = await target.api.request(
      `/v1/sessions/${PUSH}/push-requests`,
      { headers: { Authorization: "Bearer csp_writer" } },
    );
    expect(otherSession.status).toBe(404);
    const unknown = await target.api.request(
      `/v1/sessions/${SESSION}/push-requests/${RECEIPT}`,
      { headers: { Authorization: "Bearer csp_writer" } },
    );
    expect(unknown.status).toBe(404);
  });

  test("decision: a holder of sessions:approve decides the reviewed commit", async () => {
    const target = app();
    const response = await decide(target, {
      decision: "approve",
      git_commit: COMMIT,
      reason: "looks right",
    });
    expect(response.status).toBe(200);
    expect(pushRequestSchema.parse(await response.json()).state).toBe(
      "approved",
    );
    expect(target.seen.decided).toMatchObject([
      {
        ownerId: "owner-a",
        sessionId: SESSION,
        pushRequestId: PUSH,
        decision: "approve",
        gitCommit: COMMIT,
        reason: "looks right",
        idempotencyKey: "key-1",
      },
    ]);
  });

  test("decision: a credential without sessions:approve is refused with a receipt, body unread", async () => {
    const target = app();
    expect(await errorOf(decide(target, "{not json", "csp_writer"))).toEqual({
      status: 403,
      code: "FORBIDDEN",
      details: { refusal: "missing_scope", receipt_id: RECEIPT },
    });
    expect(target.seen.refusals).toMatchObject([
      {
        operation: "decide_push",
        refusal: "missing_scope",
        actor: { principal: { kind: "api_key", id: "key-csp_writer" } },
        result: { push_request_id: PUSH, verdict: "refuse" },
      },
    ]);
    expect(target.seen.decided).toEqual([]);
  });

  test("decision: an unverified caller (AUTH_MODE=none) decides nothing and writes nothing", async () => {
    const target = app({ authMode: "none" });
    for (const response of [
      decide(target, { decision: "approve", git_commit: COMMIT }, "", {
        "Idempotency-Key": "key-1",
        "X-Owner-Id": "owner-a",
      }),
      target.api.request(`/v1/sessions/${SESSION}/push-requests`, {
        method: "POST",
        headers: {
          "X-Owner-Id": "owner-a",
          "Idempotency-Key": "key-1",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    ]) {
      expect(await errorOf(response)).toEqual({
        status: 403,
        code: "FORBIDDEN",
        details: { refusal: "unverified_principal" },
      });
    }
    expect(target.seen).toEqual({ created: [], decided: [], refusals: [] });
  });

  test("decision: the store's refusals map to 409 and 404", async () => {
    const cases = [
      ["already_decided", 409, "PUSH_REQUEST_DECIDED"],
      ["checkpoint_moved", 409, "CHECKPOINT_MOVED"],
      ["commit_mismatch", 409, "CHECKPOINT_MOVED"],
      ["not_found", 404, "NOT_FOUND"],
    ] as const;
    for (const [refusal, status, code] of cases) {
      const target = app({
        store: {
          decide: async () => ({
            outcome: "refused",
            refusal,
            receiptId: RECEIPT,
          }),
        },
      });
      expect(
        await errorOf(
          decide(target, { decision: "reject", git_commit: COMMIT }),
        ),
      ).toEqual({ status, code, details: { refusal, receipt_id: RECEIPT } });
    }
  });

  test("decision: body, key and size are checked", async () => {
    const target = app();
    for (const body of [
      { decision: "approve" },
      { decision: "merge", git_commit: COMMIT },
      { decision: "approve", git_commit: "HEAD" },
    ]) {
      expect(await errorOf(decide(target, body))).toMatchObject({
        status: 400,
        code: "BAD_REQUEST",
      });
    }
    expect(
      await errorOf(
        decide(
          target,
          { decision: "reject", git_commit: COMMIT },
          undefined,
          {},
        ),
      ),
    ).toMatchObject({ status: 400, code: "BAD_REQUEST" });
    expect(
      await errorOf(
        decide(target, {
          decision: "reject",
          git_commit: COMMIT,
          reason: "x".repeat(65 * 1024),
        }),
      ),
    ).toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
    const conflict = app({
      store: { decide: async () => ({ outcome: "conflict" }) },
    });
    expect(
      await errorOf(
        decide(conflict, { decision: "reject", git_commit: COMMIT }),
      ),
    ).toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(target.seen.decided).toEqual([]);
  });
});
