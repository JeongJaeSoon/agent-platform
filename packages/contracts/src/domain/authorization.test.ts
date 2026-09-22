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
