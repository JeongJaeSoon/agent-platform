import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  listTakeoversResponseSchema,
  takeOverSessionResponseSchema,
} from "@agent-platform/contracts";
import {
  type AuthorizationPolicy,
  type Caller,
  createAuthorizationPolicy,
  createMemberService,
  type MemberService,
  type MemberStore,
} from "@agent-platform/platform";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerMemberRoutes } from "./members.ts";

const createApiApp = recordRouteErrors("routes/members.test.ts");

const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const DEPARTED = "019a0000-0000-7000-8000-0000000000c1";
const OWNER_USER = "019a0000-0000-7000-8000-0000000000a1";
const RECEIPT = "4d6d1a3e-1f1c-4c3a-9f3e-2b1c1d1e1f10";

// Who may manage members is the policy's (policy.test.ts); these cases stand
// in a policy that allows so the route's own mapping is what is under test.
const allowing: AuthorizationPolicy = {
  authorize: async () => ({
    outcome: "allow",
    reason_code: "ok",
    effective_scopes: [],
    policy_version: "test",
    decision_id: crypto.randomUUID(),
  }),
};

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );

function store(overrides: Partial<MemberStore> = {}): MemberStore {
  return {
    offboard: async () => ({ outcome: "not_found" }),
    listAwaitingTakeover: async () => [
      {
        sessionId: SESSION,
        departedUserId: DEPARTED,
        status: "running",
        createdAt: new Date("2026-10-11T00:00:00.000Z"),
        takeoverRequiredAt: new Date("2026-10-11T01:00:00.000Z"),
      },
    ],
    takeOver: async () => ({ outcome: "taken_over", receiptId: RECEIPT }),
    ...overrides,
  };
}

// AUTH_MODE=none authenticates every request as a key; a cookie caller
// carries the person behind it, which is what takeover renames to.
function asPerson(caller: Caller): Caller {
  return {
    ...caller,
    actor: {
      principal: { kind: "user", id: OWNER_USER },
      userId: OWNER_USER,
      workspaceId: caller.ownerId,
      apiKeyId: null,
    },
  };
}

function app(
  memberStore: MemberStore = store(),
  options: { authorization?: AuthorizationPolicy; person?: boolean } = {},
) {
  const service = createMemberService({
    authorization: options.authorization ?? allowing,
    store: memberStore,
  });
  const routed: Pick<MemberService, "listTakeovers" | "takeOverSession"> =
    options.person === false
      ? service
      : {
          listTakeovers: (caller) => service.listTakeovers(asPerson(caller)),
          takeOverSession: (caller, id) =>
            service.takeOverSession(asPerson(caller), id),
        };
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) => registerMemberRoutes(router, routed),
  });
}

const owner = { "X-Owner-Id": "owner-a" };

async function errorOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}

describe("GET /v1/takeovers", () => {
  test("lists the workspace's sessions awaiting takeover", async () => {
    const response = await app().request("/v1/takeovers", { headers: owner });
    expect(response.status).toBe(200);
    expect(listTakeoversResponseSchema.parse(await response.json())).toEqual({
      items: [
        {
          session_id: SESSION,
          departed_user_id: DEPARTED,
          status: "running",
          created_at: "2026-10-11T00:00:00.000Z",
          takeover_required_at: "2026-10-11T01:00:00.000Z",
        },
      ],
    });
  });

  test("refuses an API key whatever its scopes", async () => {
    const response = await app(store(), {
      authorization: createAuthorizationPolicy(),
      person: false,
    }).request("/v1/takeovers", { headers: owner });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe("FORBIDDEN");
  });

  test("requires authentication", async () => {
    const response = await app().request("/v1/takeovers");
    expect(response.status).toBe(401);
  });

  test("maps a storage outage to 503", async () => {
    const response = await app(store({ listAwaitingTakeover: outage })).request(
      "/v1/takeovers",
      { headers: owner },
    );
    expect(response.status).toBe(503);
  });
});

describe("POST /v1/sessions/{id}/takeover", () => {
  const post = (
    api: ReturnType<typeof app>,
    id = SESSION,
    headers: Record<string, string> = owner,
  ) => api.request(`/v1/sessions/${id}/takeover`, { method: "POST", headers });

  test("the person taking over becomes the requester", async () => {
    let renamed: string | undefined;
    const response = await post(
      app(
        store({
          takeOver: async (input) => {
            renamed = input.newRequesterId;
            return { outcome: "taken_over", receiptId: RECEIPT };
          },
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(takeOverSessionResponseSchema.parse(await response.json())).toEqual({
      receipt_id: RECEIPT,
      receipt_status: "succeeded",
    });
    expect(renamed).toBe(OWNER_USER);
  });

  test("an API key cannot take a session over", async () => {
    const response = await post(
      app(store(), {
        authorization: createAuthorizationPolicy(),
        person: false,
      }),
    );
    expect(response.status).toBe(403);
  });

  test("a caller with nobody behind it never reaches the store", async () => {
    let reached = false;
    const response = await post(
      app(
        store({
          takeOver: async () => {
            reached = true;
            return { outcome: "taken_over", receiptId: RECEIPT };
          },
        }),
        { person: false },
      ),
    );
    expect(response.status).toBe(403);
    expect(reached).toBe(false);
  });

  test("requires authentication", async () => {
    expect((await post(app(), SESSION, {})).status).toBe(401);
  });

  test("a missing session and a malformed id are both not found", async () => {
    const missing = await post(
      app(store({ takeOver: async () => ({ outcome: "not_found" }) })),
    );
    expect(missing.status).toBe(404);
    expect((await post(app(), "not-a-uuid")).status).toBe(404);
  });

  test("a session not awaiting takeover is stale", async () => {
    const response = await post(
      app(store({ takeOver: async () => ({ outcome: "not_awaiting" }) })),
    );
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("REQUEST_STALE");
  });

  test("maps a storage outage to 503", async () => {
    const response = await post(app(store({ takeOver: outage })));
    expect(response.status).toBe(503);
  });
});
