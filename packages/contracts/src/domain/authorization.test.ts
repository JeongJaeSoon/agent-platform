import { describe, expect, test } from "bun:test";

import {
  authorizationContextFor,
  authorizationContextFromLegacy,
  authorizationContextSchema,
  formatIdempotencyPrincipal,
  type Grant,
  grantCovers,
  grantSchema,
  idempotencyPrincipalFor,
  idempotencyPrincipalSchema,
  isGrantActive,
  principalSchema,
  receiptActorSchema,
  SESSION_SCOPE_VALUES,
  scopesForRole,
  toLegacyPrincipal,
} from "./authorization.ts";

const USER_ID = "019a0000-0000-7000-8000-0000000000b1";
const WORKSPACE_ID = "019a0000-0000-7000-8000-0000000000b2";
const GRANT_ID = "019a0000-0000-7000-8000-0000000000b3";
const SESSION_ID = "019a0000-0000-7000-8000-0000000000b4";
const INSTALLATION_ID = "019a0000-0000-7000-8000-0000000000b5";

const grant: Grant = grantSchema.parse({
  grant_id: GRANT_ID,
  workspace_id: WORKSPACE_ID,
  actor: { kind: "user", id: USER_ID },
  service_principal: { kind: "service", id: "install_1" },
  actions: ["session.read"],
  resource: { kind: "session", id: SESSION_ID },
  audience: { kind: "session", id: SESSION_ID },
  scopes: ["sessions:read"],
  revision: 0,
  revoked_at: null,
  expires_at: null,
});

const request = {
  workspaceId: WORKSPACE_ID,
  actor: { kind: "user", id: USER_ID } as const,
  servicePrincipal: { kind: "service", id: "install_1" } as const,
  action: "session.read" as const,
  resource: { kind: "session", id: SESSION_ID } as const,
  audience: { kind: "session", id: SESSION_ID } as const,
};

const NOW = "2026-09-22T12:00:00Z";

describe("principal and scopes", () => {
  test("an api key principal may be unmapped to a workspace, a user never is", () => {
    expect(
      principalSchema.safeParse({
        kind: "api_key",
        id: "key_1",
        owner_id: "owner_1",
        workspace_id: null,
        scopes: ["sessions:read"],
      }).success,
    ).toBe(true);
    expect(
      principalSchema.safeParse({
        kind: "user",
        id: USER_ID,
        workspace_id: null,
        role: "owner",
        scopes: [],
      }).success,
    ).toBe(false);
  });

  test("a member gets everything but recovery", () => {
    expect(scopesForRole("owner")).toEqual(SESSION_SCOPE_VALUES);
    expect(scopesForRole("member")).not.toContain("sessions:recover");
    expect(scopesForRole("member")).toContain("sessions:approve");
  });

  test("a signed chat webhook authenticates the installation, not the typist", () => {
    // 03b §4.1: the webhook carries no bearer key, so the installation is what
    // authenticated. The human stays the actor and lends it nothing.
    const installation = {
      kind: "installation",
      id: INSTALLATION_ID,
      owner_id: "owner_1",
      workspace_id: WORKSPACE_ID,
      scopes: ["sessions:write"],
    };
    expect(principalSchema.safeParse(installation).success).toBe(true);
    // Recovery is an operator power; a chat app cannot even name it.
    expect(
      principalSchema.safeParse({
        ...installation,
        scopes: ["sessions:recover"],
      }).success,
    ).toBe(false);

    const ctx = authorizationContextFor(principalSchema.parse(installation));
    expect(authorizationContextSchema.safeParse(ctx).success).toBe(true);
    expect(ctx.service_principal).toEqual({
      kind: "service",
      id: INSTALLATION_ID,
    });
    // The owner partition is the workspace's service owner, not the chat team.
    expect(ctx.owner_scope).toBe("owner_1");
    // A Slack user with no internal mapping is still representable.
    expect(Object.hasOwn(ctx, "actor_user_id")).toBe(false);
    expect(
      authorizationContextSchema.safeParse({
        ...ctx,
        service_principal: { kind: "service", id: "install_other" },
      }).success,
    ).toBe(false);
    // Keying replay on the installation would collapse every user of a
    // workspace into one window, so it refuses instead of guessing.
    expect(() => idempotencyPrincipalFor(ctx)).toThrow(TypeError);
    // The context's scope field is the general vocabulary, so the ceiling has
    // to be repeated where a context is validated directly.
    expect(
      authorizationContextSchema.safeParse({
        ...ctx,
        scopes: ["sessions:recover"],
      }).success,
    ).toBe(false);
  });

  test("a role is a ceiling: a member cannot carry recovery", () => {
    const member = {
      kind: "user",
      id: USER_ID,
      workspace_id: WORKSPACE_ID,
      role: "member",
    };
    expect(
      principalSchema.safeParse({ ...member, scopes: ["sessions:recover"] })
        .success,
    ).toBe(false);
    expect(
      principalSchema.safeParse({ ...member, scopes: ["sessions:approve"] })
        .success,
    ).toBe(true);
    // Narrower than the role is fine; only wider is an escalation.
    expect(principalSchema.safeParse({ ...member, scopes: [] }).success).toBe(
      true,
    );
    expect(
      principalSchema.safeParse({
        ...member,
        role: "owner",
        scopes: ["sessions:recover"],
      }).success,
    ).toBe(true);
  });
});

describe("AuthorizationContext", () => {
  test("carries the owner partition the legacy policy still authorizes on", () => {
    const ctx = authorizationContextFromLegacy({ ownerId: "owner_1" });
    expect(authorizationContextSchema.parse(ctx)).toEqual(ctx);
    expect(ctx.principal).toEqual({ kind: "api_key", id: "owner_1" });
    expect(ctx.owner_scope).toBe("owner_1");
    expect(toLegacyPrincipal(ctx)).toEqual({ ownerId: "owner_1" });
    expect(Object.hasOwn(ctx, "workspace_id")).toBe(false);
  });

  test("round-trips an api key principal without inventing a workspace", () => {
    const ctx = authorizationContextFor({
      kind: "api_key",
      id: "key_1",
      owner_id: "owner_1",
      workspace_id: null,
      scopes: ["sessions:read", "sessions:write"],
    });
    expect(toLegacyPrincipal(ctx)).toEqual({ ownerId: "owner_1" });
    expect(Object.hasOwn(ctx, "workspace_id")).toBe(false);
    expect(ctx.scopes).toEqual(["sessions:read", "sessions:write"]);
  });

  test("a web user acts as itself inside its workspace", () => {
    const ctx = authorizationContextFor({
      kind: "user",
      id: USER_ID,
      workspace_id: WORKSPACE_ID,
      role: "member",
      scopes: [...scopesForRole("member")],
    });
    expect(ctx.actor_user_id).toBe(USER_ID);
    expect(ctx.owner_scope).toBe(WORKSPACE_ID);
    expect(ctx.workspace_id).toBe(WORKSPACE_ID);
  });

  test("a hand-built context cannot point at another tenant", () => {
    // Middleware may assemble this itself instead of calling
    // `authorizationContextFor`, so the relationships that function
    // establishes are checked here too.
    const ctx = authorizationContextFor({
      kind: "user",
      id: USER_ID,
      workspace_id: WORKSPACE_ID,
      role: "owner",
      scopes: [...SESSION_SCOPE_VALUES],
    });
    expect(authorizationContextSchema.safeParse(ctx).success).toBe(true);
    expect(
      authorizationContextSchema.safeParse({ ...ctx, owner_scope: SESSION_ID })
        .success,
    ).toBe(false);
    expect(
      authorizationContextSchema.safeParse({
        ...ctx,
        actor_user_id: SESSION_ID,
      }).success,
    ).toBe(false);
    const { workspace_id: _dropped, ...withoutWorkspace } = ctx;
    expect(authorizationContextSchema.safeParse(withoutWorkspace).success).toBe(
      false,
    );
  });

  test("carries the service principal a grant match needs", () => {
    // Without it no route can build a GrantRequest for a chat installation.
    const ctx = authorizationContextFromLegacy({ ownerId: "owner_1" });
    expect(
      authorizationContextSchema.safeParse({
        ...ctx,
        service_principal: { kind: "service", id: "install_1" },
      }).success,
    ).toBe(true);
    expect(
      authorizationContextSchema.safeParse({
        ...ctx,
        service_principal: { kind: "user", id: USER_ID },
      }).success,
    ).toBe(false);
  });

  test("stays closed to fields a caller invented", () => {
    expect(
      authorizationContextSchema.safeParse({
        principal: { kind: "user", id: USER_ID },
        owner_scope: WORKSPACE_ID,
        scopes: [],
        is_admin: true,
      }).success,
    ).toBe(false);
  });
});

describe("idempotency principal", () => {
  test("namespaces the replay window by authentication path", () => {
    const apiKey = authorizationContextFromLegacy({ ownerId: "owner_1" });
    const user = authorizationContextFor({
      kind: "user",
      id: USER_ID,
      workspace_id: WORKSPACE_ID,
      role: "owner",
      scopes: [],
    });
    expect(idempotencyPrincipalFor(apiKey)).toBe("api_key:owner_1");
    expect(idempotencyPrincipalFor(user)).toBe(`user:${USER_ID}`);
    expect(idempotencyPrincipalFor(apiKey)).not.toBe(
      idempotencyPrincipalFor(user),
    );
  });

  test("an alpha owner id survives whatever characters it holds", () => {
    // `owner_id` is unconstrained `text` in alpha, so the formatter has to be
    // total: an id with a space, a slash, a colon or Hangul must produce one
    // principal rather than throw on an existing tenant's first request.
    // The last one is longer than an opaque id may be: the column has no
    // cap, so a context built from an existing tenant must still parse.
    for (const ownerId of [
      "acme corp",
      "tenants/acme",
      "a:b",
      "고객사",
      "t".repeat(512),
    ]) {
      const context = authorizationContextFromLegacy({ ownerId });
      expect(authorizationContextSchema.safeParse(context).success).toBe(true);
      const principal = idempotencyPrincipalFor(context);
      expect(idempotencyPrincipalSchema.safeParse(principal).success).toBe(
        true,
      );
      expect(principal.startsWith("api_key:")).toBe(true);
      expect(decodeURIComponent(principal.slice("api_key:".length))).toBe(
        ownerId,
      );
    }
    // Encoding keeps two different ids two different replay windows.
    expect(formatIdempotencyPrincipal("slack", "a:b")).not.toBe(
      formatIdempotencyPrincipal("slack", "a", "b"),
    );
  });

  test("a surface principal keeps its own qualified form", () => {
    expect(formatIdempotencyPrincipal("slack", "T01", "U02")).toBe(
      "slack:T01:U02",
    );
    expect(idempotencyPrincipalSchema.safeParse("owner_1").success).toBe(false);
    expect(idempotencyPrincipalSchema.safeParse("other:x").success).toBe(false);
    expect(idempotencyPrincipalSchema.safeParse("user:").success).toBe(false);
  });
});

describe("Grant", () => {
  test("an action cannot be granted on a resource kind it does not fit", () => {
    expect(
      grantSchema.safeParse({
        ...grant,
        actions: ["session.read"],
        resource: { kind: "workspace", id: WORKSPACE_ID },
      }).success,
    ).toBe(false);
    expect(
      grantSchema.safeParse({
        ...grant,
        actions: ["workspace.read"],
        resource: { kind: "workspace", id: WORKSPACE_ID },
        audience: { kind: "workspace", id: WORKSPACE_ID },
      }).success,
    ).toBe(true);
    expect(grantSchema.safeParse({ ...grant, actions: [] }).success).toBe(
      false,
    );
    // Every other contract calls this field a service actor; a user here plus
    // a hand-built request naming the same ref would make the grant active.
    expect(
      grantSchema.safeParse({
        ...grant,
        service_principal: { kind: "user", id: USER_ID },
      }).success,
    ).toBe(false);
  });

  test("matches actor, service principal, action, resource and audience exactly", () => {
    expect(grantCovers(grant, request, NOW)).toBe(true);
    expect(
      grantCovers(
        grant,
        { ...request, actor: { kind: "user", id: "someone-else" } },
        NOW,
      ),
    ).toBe(false);
    expect(
      grantCovers(grant, { ...request, servicePrincipal: null }, NOW),
    ).toBe(false);
    expect(
      grantCovers(grant, { ...request, action: "session.submit" }, NOW),
    ).toBe(false);
    expect(
      grantCovers(
        grant,
        { ...request, resource: { kind: "session", id: WORKSPACE_ID } },
        NOW,
      ),
    ).toBe(false);
    expect(
      grantCovers(
        grant,
        { ...request, audience: { kind: "workspace", id: WORKSPACE_ID } },
        NOW,
      ),
    ).toBe(false);
  });

  test("a grant cannot spend a session scope it was not issued", () => {
    const control = grantSchema.parse({
      ...grant,
      actions: ["session.control"],
      scopes: ["sessions:read"],
    });
    const controlRequest = { ...request, action: "session.control" as const };
    expect(grantCovers(control, controlRequest, NOW)).toBe(false);
    expect(
      grantCovers(
        grantSchema.parse({ ...control, scopes: ["sessions:control"] }),
        controlRequest,
        NOW,
      ),
    ).toBe(true);
    // An empty scope list authorizes nothing that touches a session, but
    // still carries workspace-level actions, which spend no session scope.
    expect(
      grantCovers(grantSchema.parse({ ...grant, scopes: [] }), request, NOW),
    ).toBe(false);
    const workspaceGrant = grantSchema.parse({
      ...grant,
      actions: ["workspace.read"],
      resource: { kind: "workspace", id: WORKSPACE_ID },
      audience: { kind: "workspace", id: WORKSPACE_ID },
      scopes: [],
    });
    expect(
      grantCovers(
        workspaceGrant,
        {
          ...request,
          action: "workspace.read",
          resource: { kind: "workspace", id: WORKSPACE_ID },
          audience: { kind: "workspace", id: WORKSPACE_ID },
        },
        NOW,
      ),
    ).toBe(true);
  });

  test("a grant never reaches outside the workspace it was stored under", () => {
    expect(
      grantCovers(grant, { ...request, workspaceId: SESSION_ID }, NOW),
    ).toBe(false);
    // Nor can the row name another workspace as what it covers: that plus a
    // request carrying the same foreign references would match across the
    // boundary while every field agreed with every other.
    for (const field of ["resource", "audience"] as const) {
      expect(
        grantSchema.safeParse({
          ...grant,
          actions: ["workspace.read"],
          resource: { kind: "workspace", id: WORKSPACE_ID },
          audience: { kind: "workspace", id: WORKSPACE_ID },
          [field]: { kind: "workspace", id: SESSION_ID },
        }).success,
      ).toBe(false);
    }
  });

  test("revocation and expiry both take effect at the instant they name", () => {
    const revoked = grantSchema.parse({ ...grant, revoked_at: NOW });
    expect(isGrantActive(revoked, NOW)).toBe(false);
    expect(isGrantActive(revoked, "2026-09-22T11:59:59Z")).toBe(true);
    expect(grantCovers(revoked, request, NOW)).toBe(false);

    const expiring = grantSchema.parse({ ...grant, expires_at: NOW });
    expect(isGrantActive(expiring, "2026-09-22T11:59:59Z")).toBe(true);
    expect(isGrantActive(expiring, NOW)).toBe(false);
    expect(grantCovers(expiring, request, NOW)).toBe(false);
  });

  test("compares instants, not the spelling of the timestamp", () => {
    // Both are RFC 3339 and both are half a second after NOW, but
    // "…:00.500Z" sorts *before* "…:00Z" as a string.
    const half = "2026-09-22T12:00:00.500Z";
    expect(half < NOW).toBe(true);
    expect(
      isGrantActive(grantSchema.parse({ ...grant, expires_at: half }), NOW),
    ).toBe(true);
    expect(
      isGrantActive(grantSchema.parse({ ...grant, revoked_at: half }), NOW),
    ).toBe(true);
    expect(
      isGrantActive(grantSchema.parse({ ...grant, revoked_at: NOW }), half),
    ).toBe(false);

    // PostgreSQL timestamptz hands back microseconds, so milliseconds are not
    // a fine enough ruler either: these two are half a millisecond apart.
    const micro = "2026-09-22T12:00:00.000500Z";
    const zero = "2026-09-22T12:00:00.000000Z";
    expect(
      isGrantActive(grantSchema.parse({ ...grant, expires_at: micro }), zero),
    ).toBe(true);
    expect(
      isGrantActive(grantSchema.parse({ ...grant, revoked_at: micro }), zero),
    ).toBe(true);
    expect(
      isGrantActive(grantSchema.parse({ ...grant, revoked_at: zero }), micro),
    ).toBe(false);
  });

  test("a grant never widens the key scope it was issued under", () => {
    expect(grant.scopes).toEqual(["sessions:read"]);
    expect(
      grantSchema.safeParse({ ...grant, scopes: ["sessions:everything"] })
        .success,
    ).toBe(false);
  });
});

describe("actor provenance", () => {
  test("a receipt names the principal and the human behind it", () => {
    const actor = receiptActorSchema.parse({
      principal: { kind: "api_key", id: "key_1" },
      actor_user_id: USER_ID,
      agent_id: null,
    });
    expect(actor.actor_user_id).toBe(USER_ID);
    // A user principal acts as itself in every context, so a receipt saying
    // it acted as someone else is audit that contradicts the request.
    expect(
      receiptActorSchema.safeParse({
        principal: { kind: "user", id: USER_ID },
        actor_user_id: USER_ID,
        agent_id: null,
      }).success,
    ).toBe(true);
    for (const actorUserId of [null, SESSION_ID]) {
      expect(
        receiptActorSchema.safeParse({
          principal: { kind: "user", id: USER_ID },
          actor_user_id: actorUserId,
          agent_id: null,
        }).success,
      ).toBe(false);
    }
    // An installation acts for a human who is named separately, or for none.
    expect(
      receiptActorSchema.safeParse({
        principal: { kind: "installation", id: INSTALLATION_ID },
        actor_user_id: USER_ID,
        agent_id: null,
      }).success,
    ).toBe(true);
    expect(
      receiptActorSchema.safeParse({
        principal: { kind: "api_key", id: "key_1" },
        actor_user_id: null,
        agent_id: null,
        token: "leak",
      }).success,
    ).toBe(false);
  });
});
