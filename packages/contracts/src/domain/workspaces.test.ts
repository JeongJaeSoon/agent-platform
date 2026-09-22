import { describe, expect, test } from "bun:test";

import {
  acceptInviteRequestSchema,
  authMeResponseSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_VALUE,
  loginRequestSchema,
  loginResponseSchema,
  PASSWORD_MIN_LENGTH,
  WEB_SESSION_COOKIE_NAME,
} from "./auth.ts";
import {
  createInviteRequestSchema,
  createInviteResponseSchema,
  inviteSchema,
  memberViewSchema,
  normalizeEmail,
  updateMemberRequestSchema,
  userSchema,
  workspaceSchema,
  workspaceSettingsSchema,
} from "./workspaces.ts";

const USER_ID = "019a0000-0000-7000-8000-0000000000d1";
const WORKSPACE_ID = "019a0000-0000-7000-8000-0000000000d2";
const INVITE_ID = "019a0000-0000-7000-8000-0000000000d3";
const AT = "2026-09-22T01:00:00Z";
const PASSWORD = "correct horse battery";

describe("workspace", () => {
  test("fills settings with the documented defaults", () => {
    const workspace = workspaceSchema.parse({
      id: WORKSPACE_ID,
      slug: "acme",
      name: "Acme",
      settings: {},
      created_at: AT,
    });
    expect(workspace.settings).toEqual({
      dispatch_model: null,
      kill_switch: false,
      daily_cost_limit_usd: null,
      idle_pause_minutes: 30,
    });
    expect(
      workspaceSchema.safeParse({ ...workspace, slug: "Acme" }).success,
    ).toBe(false);
    expect(
      workspaceSettingsSchema.safeParse({ idle_pause_minutes: 0 }).success,
    ).toBe(false);
  });

  test("separates a suspended account from a disabled membership", () => {
    const user = userSchema.parse({
      id: USER_ID,
      email: "someone@example.com",
      display_name: "Someone",
      created_at: AT,
      disabled_at: null,
    });
    expect(user.disabled_at).toBeNull();
    const member = memberViewSchema.parse({
      user_id: USER_ID,
      email: "someone@example.com",
      display_name: "Someone",
      role: "member",
      disabled_at: AT,
      created_at: AT,
    });
    expect(member.disabled_at).toBe(AT);
  });

  test("normalizes the email before it is compared", () => {
    expect(normalizeEmail("  Someone@Example.COM ")).toBe(
      "someone@example.com",
    );
  });

  test("a member patch says what it changes", () => {
    expect(updateMemberRequestSchema.safeParse({}).success).toBe(false);
    expect(updateMemberRequestSchema.safeParse({ role: "owner" }).success).toBe(
      true,
    );
    expect(updateMemberRequestSchema.safeParse({ role: "admin" }).success).toBe(
      false,
    );
  });
});

describe("invites hold no redeemable token", () => {
  const invite = {
    id: INVITE_ID,
    workspace_id: WORKSPACE_ID,
    email: "invitee@example.com",
    role: "member",
    invited_by: USER_ID,
    status: "pending",
    expires_at: AT,
    accepted_at: null,
    revoked_at: null,
    created_at: AT,
  };

  test("the stored row rejects both the token and its hash", () => {
    expect(inviteSchema.safeParse(invite).success).toBe(true);
    expect(
      inviteSchema.safeParse({ ...invite, token: "t".repeat(40) }).success,
    ).toBe(false);
    expect(
      inviteSchema.safeParse({ ...invite, token_hash: "a".repeat(64) }).success,
    ).toBe(false);
  });

  test("the token exists only in the create response, once", () => {
    expect(
      createInviteRequestSchema.safeParse({
        email: "invitee@example.com",
        role: "member",
      }).success,
    ).toBe(true);
    const created = createInviteResponseSchema.parse({
      invite_id: INVITE_ID,
      invite_token: "t".repeat(40),
      expires_at: AT,
    });
    expect(created.invite_token).toHaveLength(40);
    expect(
      createInviteResponseSchema.safeParse({
        invite_id: INVITE_ID,
        invite_token: "short",
        expires_at: AT,
      }).success,
    ).toBe(false);
  });
});

describe("auth requests", () => {
  test("bootstrap needs the install token and everything a first owner implies", () => {
    const body = {
      bootstrap_token: "b".repeat(32),
      email: "owner@example.com",
      password: PASSWORD,
      display_name: "Owner",
      workspace_name: "Acme",
      workspace_slug: "acme",
    };
    expect(bootstrapRequestSchema.safeParse(body).success).toBe(true);
    const { bootstrap_token: _omitted, ...withoutToken } = body;
    expect(bootstrapRequestSchema.safeParse(withoutToken).success).toBe(false);
    expect(
      bootstrapRequestSchema.safeParse({ ...body, password: "short" }).success,
    ).toBe(false);
    expect(PASSWORD.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
  });

  test("login is closed and an invite never forces a new password", () => {
    expect(
      loginRequestSchema.safeParse({
        email: "owner@example.com",
        password: PASSWORD,
        remember: true,
      }).success,
    ).toBe(false);
    expect(acceptInviteRequestSchema.safeParse({}).success).toBe(true);
    expect(
      acceptInviteRequestSchema.safeParse({
        password: PASSWORD,
        display_name: "Invitee",
      }).success,
    ).toBe(true);
  });

  test("no response schema can carry a password back", () => {
    const me = {
      principal: {
        kind: "user",
        id: USER_ID,
        workspace_id: WORKSPACE_ID,
        role: "owner",
        scopes: ["sessions:read"],
      },
      user: {
        id: USER_ID,
        email: "owner@example.com",
        display_name: "Owner",
      },
      workspace: {
        id: WORKSPACE_ID,
        slug: "acme",
        name: "Acme",
        settings: {},
        created_at: AT,
      },
      scopes: ["sessions:read"],
    };
    expect(authMeResponseSchema.safeParse(me).success).toBe(true);
    expect(
      authMeResponseSchema.safeParse({ ...me, password: PASSWORD }).success,
    ).toBe(false);
  });

  test("a response cannot describe more authority than its own ceiling", () => {
    // A client builds its idea of what it may do from these bodies, so the
    // role ceiling has to hold here and not only on the stored principal.
    const login = {
      user_id: USER_ID,
      workspace_id: WORKSPACE_ID,
      role: "member",
      scopes: ["sessions:approve"],
      expires_at: AT,
    };
    expect(loginResponseSchema.safeParse(login).success).toBe(true);
    expect(
      loginResponseSchema.safeParse({
        ...login,
        scopes: ["sessions:recover"],
      }).success,
    ).toBe(false);
    expect(
      loginResponseSchema.safeParse({
        ...login,
        role: "owner",
        scopes: ["sessions:recover"],
      }).success,
    ).toBe(true);

    const me = {
      principal: {
        kind: "user",
        id: USER_ID,
        workspace_id: WORKSPACE_ID,
        role: "owner",
        scopes: ["sessions:read"],
      },
      user: { id: USER_ID, email: "owner@example.com", display_name: "Owner" },
      workspace: {
        id: WORKSPACE_ID,
        slug: "acme",
        name: "Acme",
        settings: {},
        created_at: AT,
      },
      scopes: ["sessions:read", "sessions:control"],
    };
    expect(authMeResponseSchema.safeParse(me).success).toBe(false);
    expect(authMeResponseSchema.safeParse({ ...me, scopes: [] }).success).toBe(
      true,
    );
  });

  test("the /me projection describes the principal that authenticated", () => {
    // It is assembled from joins; a mismatched one hands the web client
    // someone else's identity or tenant and nothing downstream would notice.
    const workspace = {
      id: WORKSPACE_ID,
      slug: "acme",
      name: "Acme",
      settings: {},
      created_at: AT,
    };
    const me = {
      principal: {
        kind: "user",
        id: USER_ID,
        workspace_id: WORKSPACE_ID,
        role: "owner",
        scopes: ["sessions:read"],
      },
      user: { id: USER_ID, email: "owner@example.com", display_name: "Owner" },
      workspace,
      scopes: ["sessions:read"],
    };
    expect(authMeResponseSchema.safeParse(me).success).toBe(true);
    expect(
      authMeResponseSchema.safeParse({
        ...me,
        user: { ...me.user, id: INVITE_ID },
      }).success,
    ).toBe(false);
    expect(authMeResponseSchema.safeParse({ ...me, user: null }).success).toBe(
      false,
    );
    expect(
      authMeResponseSchema.safeParse({
        ...me,
        workspace: { ...workspace, id: INVITE_ID },
      }).success,
    ).toBe(false);

    // An api key has no human behind it, and a legacy key has no workspace.
    const keyMe = {
      principal: {
        kind: "api_key",
        id: "key_1",
        owner_id: "owner_1",
        workspace_id: null,
        scopes: [],
      },
      user: null,
      workspace: null,
      scopes: [],
    };
    expect(authMeResponseSchema.safeParse(keyMe).success).toBe(true);
    expect(
      authMeResponseSchema.safeParse({ ...keyMe, workspace }).success,
    ).toBe(false);
    expect(
      authMeResponseSchema.safeParse({ ...keyMe, user: me.user }).success,
    ).toBe(false);
  });

  test("bootstrap leaves an owner behind, never a member", () => {
    const body = {
      user_id: USER_ID,
      workspace: {
        id: WORKSPACE_ID,
        slug: "acme",
        name: "Acme",
        settings: {},
        created_at: AT,
      },
      role: "owner",
    };
    expect(bootstrapResponseSchema.safeParse(body).success).toBe(true);
    expect(
      bootstrapResponseSchema.safeParse({ ...body, role: "member" }).success,
    ).toBe(false);
  });

  test("names the cookie and the CSRF header the web surface must send", () => {
    expect(WEB_SESSION_COOKIE_NAME).toBe("ap_session");
    expect(CSRF_HEADER_VALUE).toBe("agent-platform-web");
  });
});
