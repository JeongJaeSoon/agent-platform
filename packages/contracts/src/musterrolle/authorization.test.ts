import { describe, expect, test } from "bun:test";

import {
  AUTHORIZATION_OUTCOME_VALUES,
  AUTHORIZATION_REASON_VALUES,
  type AuthorizationDecision,
  type AuthorizationRequest,
  actionAppliesTo,
  authorizationContextSchema,
  authorizationDecisionSchema,
  authorizationRequestSchema,
  authorizationResourceSchema,
  authorizationSubjectSchema,
  type Grant,
  grantSchema,
  ownerScopeOf,
  type Principal,
  principalSchema,
  receiptActorSchema,
  SESSION_SCOPE_VALUES,
  scopesForRole,
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

  test("a member and an admin get everything but recovery", () => {
    expect(scopesForRole("owner")).toEqual(SESSION_SCOPE_VALUES);
    for (const role of ["admin", "member"] as const) {
      expect(scopesForRole(role)).not.toContain("sessions:recover");
      expect(scopesForRole(role)).toContain("sessions:approve");
    }
  });

  test("an admin cannot hold recovery", () => {
    expect(
      principalSchema.safeParse({
        kind: "user",
        id: USER_ID,
        workspace_id: WORKSPACE_ID,
        role: "admin",
        scopes: ["sessions:recover"],
      }).success,
    ).toBe(false);
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

    const ctx = {
      principal: { kind: "installation", id: INSTALLATION_ID },
      service_principal: { kind: "service", id: INSTALLATION_ID },
      owner_scope: "owner_1",
      workspace_id: WORKSPACE_ID,
      scopes: ["sessions:write"],
    };
    // A Slack user with no internal mapping is still representable.
    expect(authorizationContextSchema.safeParse(ctx).success).toBe(true);
    expect(
      authorizationContextSchema.safeParse({
        ...ctx,
        service_principal: { kind: "service", id: "install_other" },
      }).success,
    ).toBe(false);
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
  test("a hand-built context cannot point at another tenant", () => {
    const ctx = {
      principal: { kind: "user", id: USER_ID },
      actor_user_id: USER_ID,
      owner_scope: WORKSPACE_ID,
      workspace_id: WORKSPACE_ID,
      scopes: [...SESSION_SCOPE_VALUES],
    };
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
    const ctx = {
      principal: { kind: "api_key", id: "owner_1" },
      owner_scope: "owner_1",
      scopes: [...SESSION_SCOPE_VALUES],
    };
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

  test("a grant never reaches outside the workspace it was stored under", () => {
    // The row cannot name another workspace as what it covers: that plus a
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

describe("authorize contract", () => {
  const key: Principal = {
    kind: "api_key",
    id: "owner-a",
    owner_id: "owner-a",
    workspace_id: null,
    scopes: ["sessions:read"],
  };
  const request: AuthorizationRequest = {
    subject: { principal: key, surface: { kind: "api" } },
    action: "session.read",
    resource: { kind: "session", id: SESSION_ID, owner_scope: "owner-a" },
    request_id: "req-1",
  };
  const decision: AuthorizationDecision = {
    outcome: "allow",
    reason_code: "ok",
    effective_scopes: ["sessions:read"],
    policy_version: "m1",
    decision_id: GRANT_ID,
  };

  test("carries the A.3 input and output", () => {
    expect(authorizationRequestSchema.parse(request)).toEqual(request);
    expect(authorizationDecisionSchema.parse(decision)).toEqual(decision);
  });

  test("names both refusals the v1 agent rules need", () => {
    expect(AUTHORIZATION_REASON_VALUES).toContain("no_requester");
    expect(AUTHORIZATION_REASON_VALUES).toContain("unlinked");
    expect(AUTHORIZATION_OUTCOME_VALUES).toEqual([
      "allow",
      "deny",
      "redact",
      "require_approval",
    ]);
  });

  test("an autonomous run is a subject with no principal", () => {
    expect(
      authorizationSubjectSchema.safeParse({
        principal: null,
        surface: { kind: "slack", channel_kind: "dm" },
      }).success,
    ).toBe(true);
  });

  test("an id-less resource is one not read yet; an empty id is not", () => {
    const resource = { kind: "session", owner_scope: "owner-a" };
    expect(
      authorizationResourceSchema.safeParse({ ...resource, id: null }).success,
    ).toBe(true);
    expect(
      authorizationResourceSchema.safeParse({ ...resource, id: "" }).success,
    ).toBe(false);
  });

  test("only a resource not yet identified is told its agent", () => {
    const resource = {
      kind: "session",
      owner_scope: "owner-a",
      agent_id: "019a0000-0000-7000-8000-00000000a0a1",
    };
    expect(
      authorizationResourceSchema.safeParse({ ...resource, id: null }).success,
    ).toBe(true);
    expect(
      authorizationResourceSchema.safeParse({ ...resource, id: "s-1" }).success,
    ).toBe(false);
    // Likewise the release it is to run, whose credentials the policy reads.
    const starting = { ...resource, release_id: "rel-1" };
    expect(
      authorizationResourceSchema.safeParse({ ...starting, id: null }).success,
    ).toBe(true);
    expect(
      authorizationResourceSchema.safeParse({ ...starting, id: "s-1" }).success,
    ).toBe(false);
    // A stored binding starts a session on a release, and is read for its
    // agent all the same.
    const inBinding = {
      kind: "surface_binding",
      id: "019a0000-0000-7000-8000-00000000b0b1",
      owner_scope: "owner-a",
    };
    expect(
      authorizationResourceSchema.safeParse({
        ...inBinding,
        release_id: "rel-1",
      }).success,
    ).toBe(true);
    expect(
      authorizationResourceSchema.safeParse({
        ...inBinding,
        agent_id: resource.agent_id,
      }).success,
    ).toBe(false);
  });

  test("allow is always ok and deny never is", () => {
    for (const [outcome, reason_code] of [
      ["allow", "role"],
      ["deny", "ok"],
    ]) {
      expect(
        authorizationDecisionSchema.safeParse({
          ...decision,
          outcome,
          reason_code,
        }).success,
      ).toBe(false);
    }
  });

  test("rejects a scope name where an action belongs", () => {
    expect(
      authorizationRequestSchema.safeParse({
        ...request,
        action: "sessions:read",
      }).success,
    ).toBe(false);
  });

  test("actionAppliesTo reads the action-resource table", () => {
    expect(actionAppliesTo("session.read", "session")).toBe(true);
    expect(actionAppliesTo("session.read", "workspace")).toBe(false);
  });

  test("ownerScopeOf is the workspace for a user and the owner otherwise", () => {
    expect(ownerScopeOf(key)).toBe("owner-a");
    expect(
      ownerScopeOf({
        kind: "user",
        id: USER_ID,
        workspace_id: WORKSPACE_ID,
        role: "member",
        scopes: [],
      }),
    ).toBe(WORKSPACE_ID);
  });
});
