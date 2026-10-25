import { describe, expect, test } from "bun:test";
import {
  type AuthorizationAction,
  type AuthorizationRequest,
  type AuthorizationResource,
  authorizationDecisionSchema,
  type Principal,
  SESSION_SCOPE_VALUES,
  type SessionScope,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  type IdentityReader,
} from "./policy.ts";

// Design 4.1, the role table: one row per action, one column per subject.

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT_A = "019a0000-0000-7000-8000-00000000a0a1";
const AGENT_B = "019a0000-0000-7000-8000-00000000a0b1";
const SESSION_A = "019a0000-0000-7000-8000-00000000e0a1";
const SESSION_B = "019a0000-0000-7000-8000-00000000e0b1";
const SESSION_NONE = "019a0000-0000-7000-8000-00000000e0c1";
const KEY = "019a0000-0000-7000-8000-0000000000f1";

const USERS: Record<WorkspaceRole | "agent_admin", string> = {
  owner: "019a0000-0000-7000-8000-0000000000c1",
  admin: "019a0000-0000-7000-8000-0000000000c2",
  member: "019a0000-0000-7000-8000-0000000000c3",
  agent_admin: "019a0000-0000-7000-8000-0000000000c4",
};

const AGENT_OF: Record<string, string> = {
  [SESSION_A]: AGENT_A,
  [SESSION_B]: AGENT_B,
};

// The agent admin is a member who administers AGENT_A only.
const agents: AgentAuthority = {
  async agentOf(_workspaceId, resource) {
    if (resource.kind === "agent") return resource.id;
    return AGENT_OF[resource.id] ?? null;
  },
  async isAdmin(workspaceId, agentId, userId) {
    return (
      workspaceId === WORKSPACE &&
      agentId === AGENT_A &&
      userId === USERS.agent_admin
    );
  },
};

function user(role: WorkspaceRole, id: string): Principal {
  return {
    kind: "user",
    id,
    workspace_id: WORKSPACE,
    role,
    scopes: [...scopesForRole(role)],
  };
}

function key(
  scopes: readonly SessionScope[] = SESSION_SCOPE_VALUES,
): Principal {
  return {
    kind: "api_key",
    id: KEY,
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: [...scopes],
  };
}

type Column =
  | "owner"
  | "admin"
  | "member"
  | "agent_admin"
  | "service_key"
  | "personal_key";
const COLUMNS: Column[] = [
  "owner",
  "admin",
  "member",
  "agent_admin",
  "service_key",
  "personal_key",
];

function subject(column: Column): { caller: Caller; identity: IdentityReader } {
  const plain: IdentityReader = {
    reread: async (s) => ({ status: "ok", principal: s.principal }),
  };
  switch (column) {
    case "owner":
    case "admin":
    case "member":
      return {
        caller: callerFor(user(column, USERS[column]), { kind: "web" }, "r"),
        identity: plain,
      };
    case "agent_admin":
      return {
        caller: callerFor(
          user("member", USERS.agent_admin),
          { kind: "web" },
          "r",
        ),
        identity: plain,
      };
    case "service_key":
      return {
        caller: callerFor(key(), { kind: "api" }, "r", { creatorId: null }),
        identity: plain,
      };
    case "personal_key":
      // An owner's personal key: still a key, so no management action.
      return {
        caller: callerFor(key(), { kind: "api" }, "r", {
          creatorId: USERS.owner,
        }),
        identity: {
          reread: async (s) => ({
            status: "ok",
            principal: s.principal,
            keyCreator: { userId: USERS.owner, role: "owner" },
          }),
        },
      };
  }
}

async function allowed(
  column: Column,
  action: AuthorizationAction,
  resource: Omit<AuthorizationResource, "owner_scope">,
): Promise<boolean> {
  const { caller, identity } = subject(column);
  const policy = createAuthorizationPolicy({ identity, agents });
  const request: AuthorizationRequest = {
    subject: caller.subject,
    action,
    resource: { ...resource, owner_scope: WORKSPACE },
    request_id: caller.requestId,
  };
  const decision = authorizationDecisionSchema.parse(
    await policy.authorize(request),
  );
  return decision.outcome === "allow";
}

const onWorkspace = { kind: "workspace", id: WORKSPACE } as const;
const onAgentA = { kind: "agent", id: AGENT_A } as const;

// o allowed, x refused. Columns: owner, admin, member, member + admin of
// AGENT_A, service key, personal key.
const TABLE: [
  string,
  AuthorizationAction,
  Omit<AuthorizationResource, "owner_scope">,
  string,
][] = [
  ["설정·비용 상한 변경", "workspace.manage", onWorkspace, "ooxxxx"],
  // That an admin cannot touch the owner role is the store's; see
  // invites.integration.test.ts.
  ["멤버 초대·역할 변경", "member.manage", onWorkspace, "ooxxxx"],
  ["Slack guest 사용 켜기·끄기", "workspace.manage", onWorkspace, "ooxxxx"],
  ["감사 보존 기간 변경", "audit_retention.manage", onWorkspace, "oxxxxx"],
  // 94S-762: figures summed over every owner, the owner's personal key
  // included in the refusal.
  [
    "설치 전체 사용량·한도 읽기",
    "usage.installation_read",
    onWorkspace,
    "oxxxxx",
  ],
  ["팀 만들기·구성원 관리", "team.manage", onWorkspace, "ooxxxx"],
  ["모든 에이전트의 key 발급·폐기", "api_key.manage", onWorkspace, "ooxxxx"],
  ["그 에이전트의 key 발급·폐기", "api_key.manage", onAgentA, "ooxoxx"],
  ["개인 key 발급·폐기(자기 것)", "api_key.manage_own", onWorkspace, "ooooxx"],
  ["에이전트 만들기", "agent.create", onWorkspace, "ooooxx"],
  ["외부 계정 연결(자기 것)", "account.link", onWorkspace, "ooooxx"],
  ["정의 수정·release·활성화", "agent.manage", onAgentA, "ooxoxx"],
  ["도구 권한 정책 변경", "agent.manage", onAgentA, "ooxoxx"],
  ["자격 참조 연결·해제", "credential.bind", onAgentA, "ooxoxx"],
  ["에이전트 관리자 지정", "agent.admin.manage", onAgentA, "ooxoxx"],
  ["Slack 앱 설치·채널 설정", "binding.manage", onAgentA, "ooxoxx"],
  ["에이전트 보관", "agent.manage", onAgentA, "ooxoxx"],
  ["보관한 에이전트 되살리기", "agent.restore", onAgentA, "oxxxxx"],
  // Every agent, across the workspace, is the roles' alone.
  ["에이전트 목록", "agent.manage", onWorkspace, "ooxxxx"],
  [
    "복구 결정",
    "session.recover",
    { kind: "session", id: SESSION_A },
    "oxxxoo",
  ],
];

describe("design 4.1 role table", () => {
  for (const [row, action, resource, cells] of TABLE) {
    test(`${row} (${action} on ${resource.kind})`, async () => {
      const got = await Promise.all(
        COLUMNS.map(async (column) =>
          (await allowed(column, action, resource)) ? "o" : "x",
        ),
      );
      expect(got.join("")).toBe(cells);
    });
  }

  test("an agent's admin manages that agent and no other", async () => {
    for (const action of [
      "agent.manage",
      "credential.bind",
      "agent.admin.manage",
      "binding.manage",
      "api_key.manage",
    ] as const) {
      expect(await allowed("agent_admin", action, onAgentA)).toBe(true);
      expect(
        await allowed("agent_admin", action, { kind: "agent", id: AGENT_B }),
      ).toBe(false);
    }
  });

  test("an admin holds a member's session scopes: everything but recovery", () => {
    expect(scopesForRole("admin")).toEqual(scopesForRole("member"));
    expect(scopesForRole("admin")).not.toContain("sessions:recover");
  });
});

describe("a service key bound to an agent", () => {
  const bound: IdentityReader = {
    reread: async (s) => ({
      status: "ok",
      principal: s.principal,
      keyAgentId: AGENT_A.toUpperCase(),
    }),
  };
  const caller = callerFor(key(), { kind: "api" }, "r", { creatorId: null });
  const policy = createAuthorizationPolicy({ identity: bound, agents });

  async function decide(
    action: AuthorizationAction,
    resource: Omit<AuthorizationResource, "owner_scope">,
  ) {
    return authorizationDecisionSchema.parse(
      await policy.authorize({
        subject: caller.subject,
        action,
        resource: { ...resource, owner_scope: WORKSPACE },
        request_id: "r",
      }),
    );
  }

  test("reaches its agent's sessions and refuses another's", async () => {
    expect(
      await decide("session.read", { kind: "session", id: SESSION_A }),
    ).toMatchObject({ outcome: "allow" });
    expect(
      await decide("session.read", { kind: "session", id: SESSION_B }),
    ).toMatchObject({ outcome: "deny", reason_code: "agent_ceiling" });
    expect(
      await decide("session.control", { kind: "session", id: SESSION_NONE }),
    ).toMatchObject({ outcome: "deny", reason_code: "agent_ceiling" });
  });

  test("creates a session only on its own agent", async () => {
    expect(
      await decide("session.submit", {
        kind: "session",
        id: null,
        agent_id: AGENT_A,
      }),
    ).toMatchObject({ outcome: "allow" });
    expect(
      await decide("session.submit", {
        kind: "session",
        id: null,
        agent_id: AGENT_B,
      }),
    ).toMatchObject({ outcome: "deny", reason_code: "agent_ceiling" });
    // A list or a profile-only session names no agent.
    expect(
      await decide("session.submit", { kind: "session", id: null }),
    ).toMatchObject({ outcome: "deny", reason_code: "agent_ceiling" });
  });

  test("never approves, whatever scopes the row holds (D26 5)", async () => {
    const decision = await decide("session.approve", {
      kind: "session",
      id: SESSION_A,
    });
    expect(decision).toMatchObject({ outcome: "deny", reason_code: "role" });
    expect(decision.effective_scopes).not.toContain("sessions:approve");
  });

  test("takes no management action, its own agent's included", async () => {
    for (const action of [
      "agent.manage",
      "api_key.manage",
      "credential.bind",
    ] as const) {
      expect(await decide(action, onAgentA)).toMatchObject({
        outcome: "deny",
        reason_code: "role",
      });
    }
  });
});

describe("the resource's agent", () => {
  test("a store that throws refuses", async () => {
    const policy = createAuthorizationPolicy({
      agents: {
        agentOf: async () => {
          throw new Error("connection terminated");
        },
        isAdmin: async () => {
          throw new Error("connection terminated");
        },
      },
    });
    const caller = callerFor(
      user("member", USERS.agent_admin),
      { kind: "web" },
      "r",
    );
    expect(
      await policy.authorize({
        subject: caller.subject,
        action: "agent.manage",
        resource: { ...onAgentA, owner_scope: WORKSPACE },
        request_id: "r",
      }),
    ).toMatchObject({ outcome: "deny", reason_code: "error" });
  });
});
