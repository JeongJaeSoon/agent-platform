import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  listMembersResponseSchema,
  listTakeoversResponseSchema,
  setAccessResponseSchema,
  takeOverSessionResponseSchema,
  updateMemberResponseSchema,
} from "@agent-platform/contracts";
import {
  type AuthorizationPolicy,
  type Caller,
  createAuthorizationPolicy,
  createInviteService,
  createMemberService,
  type InviteService,
  type InviteStore,
  type MemberRecord,
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
    setAccess: async () => ({ outcome: "not_found" }),
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

const MEMBER: MemberRecord = {
  userId: DEPARTED,
  email: "member@example.com",
  displayName: "Member",
  role: "member",
  disabledAt: null,
  createdAt: new Date("2026-10-11T00:00:00.000Z"),
};

function roleStore(overrides: Partial<InviteStore> = {}): InviteStore {
  const unused = async () => {
    throw new Error("not used by the member routes");
  };
  return {
    createInvite: unused,
    listInvites: unused,
    revokeInvite: unused,
    peekInvite: unused,
    acceptInvite: unused,
    listMembers: async () => [MEMBER],
    changeMemberRole: async (input) => ({
      outcome: "changed",
      member: { ...MEMBER, role: input.role },
    }),
    ...overrides,
  };
}

function app(
  memberStore: MemberStore = store(),
  options: {
    authorization?: AuthorizationPolicy;
    person?: boolean;
    roles?: InviteStore;
  } = {},
) {
  const service = createMemberService({
    authorization: options.authorization ?? allowing,
    store: memberStore,
  });
  const invites = createInviteService({
    authorization: options.authorization ?? allowing,
    store: options.roles ?? roleStore(),
  });
  const roles: Pick<InviteService, "listMembers" | "changeMemberRole"> =
    options.person === false
      ? invites
      : {
          listMembers: (caller) => invites.listMembers(asPerson(caller)),
          changeMemberRole: (caller, userId, role) =>
            invites.changeMemberRole(asPerson(caller), userId, role),
        };
  const routed: MemberService =
    options.person === false
      ? service
      : {
          listTakeovers: (caller) => service.listTakeovers(asPerson(caller)),
          takeOverSession: (caller, id) =>
            service.takeOverSession(asPerson(caller), id),
          disableMember: (caller, id, reason) =>
            service.disableMember(asPerson(caller), id, reason),
          enableMember: (caller, id, reason) =>
            service.enableMember(asPerson(caller), id, reason),
          disableUser: (caller, id, reason) =>
            service.disableUser(asPerson(caller), id, reason),
          enableUser: (caller, id, reason) =>
            service.enableUser(asPerson(caller), id, reason),
        };
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) => registerMemberRoutes(router, routed, roles),
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

describe("GET /v1/members", () => {
  test("lists the workspace's members", async () => {
    const response = await app().request("/v1/members", { headers: owner });
    expect(response.status).toBe(200);
    expect(listMembersResponseSchema.parse(await response.json())).toEqual({
      items: [
        {
          user_id: DEPARTED,
          email: "member@example.com",
          display_name: "Member",
          role: "member",
          disabled_at: null,
          created_at: "2026-10-11T00:00:00.000Z",
        },
      ],
    });
  });

  test("refuses an API key whatever its scopes", async () => {
    const response = await app(store(), {
      authorization: createAuthorizationPolicy(),
      person: false,
    }).request("/v1/members", { headers: owner });
    expect(response.status).toBe(403);
  });

  test("maps a storage outage to 503", async () => {
    const response = await app(store(), {
      roles: roleStore({ listMembers: outage }),
    }).request("/v1/members", { headers: owner });
    expect(response.status).toBe(503);
  });
});

describe("PATCH /v1/members/{user_id}", () => {
  const patch = (
    api: ReturnType<typeof app>,
    body: unknown = { role: "owner" },
    id = DEPARTED,
  ) =>
    api.request(`/v1/members/${id}`, {
      method: "PATCH",
      headers: { ...owner, "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  test("changes the role and answers the member", async () => {
    let asked: { userId: string; role: string; actor: string } | undefined;
    const response = await patch(
      app(store(), {
        roles: roleStore({
          changeMemberRole: async (input) => {
            asked = {
              userId: input.userId,
              role: input.role,
              actor: input.actor.userId,
            };
            return {
              outcome: "changed",
              member: { ...MEMBER, role: input.role },
            };
          },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(updateMemberResponseSchema.parse(await response.json()).role).toBe(
      "owner",
    );
    expect(asked).toEqual({
      userId: DEPARTED,
      role: "owner",
      actor: OWNER_USER,
    });
  });

  test("the last owner cannot be demoted", async () => {
    const response = await patch(
      app(store(), {
        roles: roleStore({
          changeMemberRole: async () => ({ outcome: "last_owner" }),
        }),
      }),
      { role: "member" },
    );
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("LAST_OWNER");
  });

  test("a member who is not here, or a malformed id, is not found", async () => {
    const missing = await patch(
      app(store(), {
        roles: roleStore({
          changeMemberRole: async () => ({ outcome: "not_found" }),
        }),
      }),
    );
    expect(missing.status).toBe(404);
    expect((await patch(app(), { role: "owner" }, "nope")).status).toBe(404);
  });

  test("a body that is not a role patch is refused", async () => {
    expect((await patch(app(), { role: "admin" })).status).toBe(400);
    expect((await patch(app(), { disabled: true })).status).toBe(400);
    const huge = JSON.stringify({ role: "owner", pad: "x".repeat(2_000_000) });
    expect((await patch(app(), huge)).status).toBe(413);
  });

  test("an owner who was demoted meanwhile is refused", async () => {
    const response = await patch(
      app(store(), {
        roles: roleStore({
          changeMemberRole: async () => ({ outcome: "actor_inactive" }),
        }),
      }),
    );
    expect(response.status).toBe(403);
  });

  test("refuses an API key whatever its scopes", async () => {
    const response = await patch(
      app(store(), {
        authorization: createAuthorizationPolicy(),
        person: false,
      }),
    );
    expect(response.status).toBe(403);
  });

  test("maps a storage outage to 503", async () => {
    const response = await patch(
      app(store(), { roles: roleStore({ changeMemberRole: outage }) }),
    );
    expect(response.status).toBe(503);
  });
});

describe.each([
  ["members", "disable", true],
  ["members", "enable", false],
  ["users", "disable", true],
  ["users", "enable", false],
] as const)("POST /v1/%s/{user_id}/%s", (base, action, disabled) => {
  const scope = base === "members" ? "membership" : "account";
  const post = (
    api: ReturnType<typeof app>,
    body: unknown = { reason: "left the team" },
    id = DEPARTED,
  ) =>
    api.request(`/v1/${base}/${id}/${action}`, {
      method: "POST",
      headers: { ...owner, "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const answering = (result: Awaited<ReturnType<MemberStore["setAccess"]>>) =>
    app(store({ setAccess: async () => result }));

  test("asks the store as the acting owner and answers the member and receipt", async () => {
    let asked: Parameters<MemberStore["setAccess"]>[0] | undefined;
    const response = await post(
      app(
        store({
          setAccess: async (input) => {
            asked = input;
            return {
              outcome: "changed",
              member: MEMBER,
              receiptId: RECEIPT,
              effects: { disabled: false, sessionsReleased: 0 },
            };
          },
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(setAccessResponseSchema.parse(await response.json())).toEqual({
      member: {
        user_id: DEPARTED,
        email: "member@example.com",
        display_name: "Member",
        role: "member",
        disabled_at: null,
        created_at: "2026-10-11T00:00:00.000Z",
      },
      receipt_id: RECEIPT,
    });
    expect(asked).toMatchObject({
      actor: { userId: OWNER_USER },
      userId: DEPARTED,
      scope,
      disabled,
      reason: "left the team",
    });
  });

  test("a state already as asked answers without a receipt", async () => {
    const response = await post(
      answering({ outcome: "unchanged", member: MEMBER }),
      {},
    );
    expect(response.status).toBe(200);
    expect(
      setAccessResponseSchema.parse(await response.json()).receipt_id,
    ).toBeNull();
  });

  test("a body that is not an access change is refused; a reason over 1 KiB is too large", async () => {
    expect((await post(app(), { role: "owner" })).status).toBe(400);
    expect((await post(app(), "not json")).status).toBe(400);
    expect((await post(app(), { reason: "é".repeat(513) })).status).toBe(413);
  });

  test("requires authentication", async () => {
    const response = await app().request(`/v1/${base}/${DEPARTED}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  test("an API key, a demoted owner and an account elsewhere are refused", async () => {
    const byKey = await post(
      app(store(), {
        authorization: createAuthorizationPolicy(),
        person: false,
      }),
    );
    expect(byKey.status).toBe(403);
    for (const outcome of ["actor_inactive", "elsewhere"] as const) {
      expect((await post(answering({ outcome }))).status).toBe(403);
    }
  });

  test("a person who is not here, or a malformed id, is not found", async () => {
    expect((await post(answering({ outcome: "not_found" }))).status).toBe(404);
    expect((await post(app(), {}, "nope")).status).toBe(404);
  });

  test("maps a storage outage to 503", async () => {
    expect((await post(app(store({ setAccess: outage })))).status).toBe(503);
  });

  if (disabled) {
    test("the last owner, or yourself, cannot be disabled", async () => {
      const last = await post(answering({ outcome: "last_owner" }));
      expect(last.status).toBe(409);
      expect((await errorOf(last)).code).toBe("LAST_OWNER");
      const self = await post(app(), {}, OWNER_USER);
      expect(self.status).toBe(409);
      expect((await errorOf(self)).code).toBe("LAST_OWNER");
    });
  }
});
