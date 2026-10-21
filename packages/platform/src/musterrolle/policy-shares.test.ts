import { describe, expect, test } from "bun:test";
import {
  type AuthorizationAction,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type AuthorizationResource,
  authorizationDecisionSchema,
  type Principal,
  SESSION_SCOPE_VALUES,
  type SessionScope,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type { DecisionLog } from "../ports/decision-log.ts";
import type { SessionViewer } from "../ports/session-share-store.ts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  type IdentityReader,
  type SessionAccess,
} from "./policy.ts";

// Design 4.6 and A.3 step 2: a session outside its share does not exist,
// save for what a manager does with a reason.

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT_A = "019a0000-0000-7000-8000-00000000a0a1";
const KEY = "019a0000-0000-7000-8000-0000000000f1";
const OTHER_KEY = "019a0000-0000-7000-8000-0000000000f2";

const USERS = {
  owner: "019a0000-0000-7000-8000-0000000000c1",
  admin: "019a0000-0000-7000-8000-0000000000c2",
  creator: "019a0000-0000-7000-8000-0000000000c3",
  member: "019a0000-0000-7000-8000-0000000000c4",
  agent_admin: "019a0000-0000-7000-8000-0000000000c5",
} as const;

// A person's private session and a service key's private session, both on
// AGENT_A; the agent admin administers AGENT_A.
const PERSONS = "019a0000-0000-7000-8000-00000000e0a1";
const KEYS = "019a0000-0000-7000-8000-00000000e0b1";
const OPEN = "019a0000-0000-7000-8000-00000000e0c1";

const ORIGIN: Record<string, { creatorUserId: string | null; key: string }> = {
  [PERSONS]: { creatorUserId: USERS.creator, key: KEY },
  [KEYS]: { creatorUserId: null, key: KEY },
  [OPEN]: { creatorUserId: USERS.member, key: KEY },
};

const sessions: SessionAccess = {
  async visibleTo(_ownerId, sessionId, viewer: SessionViewer) {
    const origin = ORIGIN[sessionId];
    if (!origin) return false;
    if (sessionId === OPEN) return true;
    if (origin.creatorUserId !== null) {
      return viewer.userId === origin.creatorUserId;
    }
    return viewer.apiKeyId === origin.key;
  },
  async originOf(_ownerId, sessionId) {
    const origin = ORIGIN[sessionId];
    return origin
      ? { creatorUserId: origin.creatorUserId, creatorApiKeyId: origin.key }
      : null;
  },
};

const agents: AgentAuthority = {
  async agentOf(_workspaceId, resource) {
    return resource.kind === "agent" || ORIGIN[resource.id] ? AGENT_A : null;
  },
  async isAdmin(_workspaceId, agentId, userId) {
    return agentId === AGENT_A && userId === USERS.agent_admin;
  },
};

type Who =
  | "owner"
  | "admin"
  | "creator"
  | "member"
  | "agent_admin"
  | "service_key"
  | "other_key"
  | "creators_key";

const ROLES: Record<keyof typeof USERS, WorkspaceRole> = {
  owner: "owner",
  admin: "admin",
  creator: "member",
  member: "member",
  agent_admin: "member",
};

function key(id: string, scopes: readonly SessionScope[]): Principal {
  return {
    kind: "api_key",
    id,
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: [...scopes],
  };
}

function subject(
  who: Who,
  scopes: readonly SessionScope[] = SESSION_SCOPE_VALUES,
): { caller: Caller; identity: IdentityReader } {
  const plain: IdentityReader = {
    reread: async (s) => ({ status: "ok", principal: s.principal }),
  };
  switch (who) {
    case "service_key":
    case "other_key":
      return {
        caller: callerFor(
          key(who === "service_key" ? KEY : OTHER_KEY, scopes),
          { kind: "api" },
          "r",
          { creatorId: null },
        ),
        identity: plain,
      };
    case "creators_key":
      return {
        caller: callerFor(key(OTHER_KEY, scopes), { kind: "api" }, "r", {
          creatorId: USERS.creator,
        }),
        identity: {
          reread: async (s) => ({
            status: "ok",
            principal: s.principal,
            keyCreator: { userId: USERS.creator, role: "member" },
          }),
        },
      };
    default: {
      const role = ROLES[who];
      return {
        caller: callerFor(
          {
            kind: "user",
            id: USERS[who],
            workspace_id: WORKSPACE,
            role,
            scopes: [...scopesForRole(role)],
          },
          { kind: "web" },
          "r",
        ),
        identity: plain,
      };
    }
  }
}

async function decide(
  who: Who,
  action: AuthorizationAction,
  resource: Omit<AuthorizationResource, "owner_scope">,
  options: {
    justification?: string;
    scopes?: readonly SessionScope[];
    decisions?: DecisionLog;
  } = {},
): Promise<AuthorizationDecision> {
  const { caller, identity } = subject(who, options.scopes);
  const policy = createAuthorizationPolicy({
    identity,
    agents,
    sessions,
    ...(options.decisions ? { decisions: options.decisions } : {}),
  });
  const request: AuthorizationRequest = {
    subject: {
      ...caller.subject,
      ...(options.justification === undefined
        ? {}
        : { justification: options.justification }),
    },
    action,
    resource: { ...resource, owner_scope: WORKSPACE },
    request_id: caller.requestId,
  };
  return authorizationDecisionSchema.parse(await policy.authorize(request));
}

const reason = async (...args: Parameters<typeof decide>) =>
  (await decide(...args)).reason_code;
const on = (id: string) => ({ kind: "session", id }) as const;

const SESSION_ACTIONS: AuthorizationAction[] = [
  "session.read",
  "session.submit",
  "session.approve",
  "session.control",
];

describe("a private session", () => {
  test("is its creator's, through the web or their own key", async () => {
    for (const action of SESSION_ACTIONS) {
      expect(await reason("creator", action, on(PERSONS))).toBe("ok");
      expect(await reason("creators_key", action, on(PERSONS))).toBe("ok");
    }
  });

  test("does not exist for anyone else, owner and admin included", async () => {
    for (const who of [
      "member",
      "agent_admin",
      "owner",
      "admin",
      "service_key",
    ] as const) {
      for (const action of ["session.read", "session.submit"] as const) {
        expect(await reason(who, action, on(PERSONS))).toBe("not_found");
      }
    }
    for (const who of ["member", "agent_admin", "service_key"] as const) {
      for (const action of SESSION_ACTIONS) {
        expect(await reason(who, action, on(PERSONS))).toBe("not_found");
      }
    }
  });

  test("a service key's private session is that key's", async () => {
    expect(await reason("service_key", "session.read", on(KEYS))).toBe("ok");
    expect(await reason("other_key", "session.read", on(KEYS))).toBe(
      "not_found",
    );
    expect(await reason("owner", "session.read", on(KEYS))).toBe("not_found");
  });

  test("the share is judged before the key's scopes", async () => {
    expect(
      await reason("other_key", "session.read", on(KEYS), { scopes: [] }),
    ).toBe("not_found");
    expect(
      await reason("service_key", "session.read", on(KEYS), { scopes: [] }),
    ).toBe("role");
  });

  test("a list is not judged per session; the store filters it", async () => {
    expect(
      await reason("member", "session.read", { kind: "session", id: null }),
    ).toBe("ok");
  });
});

describe("a manager outside the share", () => {
  test("ends, recovers or takes it over only with a reason", async () => {
    for (const [action, who, without] of [
      ["session.control", "admin", "not_found"],
      ["session.recover", "owner", "not_found"],
      ["member.manage", "admin", "justification_required"],
    ] as const) {
      expect(await reason(who, action, on(PERSONS))).toBe(without);
      expect(
        await reason(who, action, on(PERSONS), { justification: "  " }),
      ).toBe(without);
      expect(
        await reason(who, action, on(PERSONS), {
          justification: "incident 42",
        }),
      ).toBe("ok");
    }
  });

  test("still cannot read or write it with a reason", async () => {
    for (const action of ["session.read", "session.submit"] as const) {
      expect(
        await reason("owner", action, on(PERSONS), { justification: "x" }),
      ).toBe("not_found");
    }
  });

  test("recovery stays the owner's", async () => {
    expect(
      await reason("admin", "session.recover", on(PERSONS), {
        justification: "x",
      }),
    ).toBe("role");
  });

  test("needs no reason for a session in the share", async () => {
    expect(await reason("admin", "member.manage", on(OPEN))).toBe("ok");
    expect(await reason("owner", "session.control", on(OPEN))).toBe("ok");
  });
});

describe("audit read (D22)", () => {
  test("is the owner's and the admin's, with a reason every time", async () => {
    for (const who of ["owner", "admin"] as const) {
      for (const id of [PERSONS, OPEN]) {
        expect(await reason(who, "session.audit_read", on(id))).toBe(
          "justification_required",
        );
        expect(
          await reason(who, "session.audit_read", on(id), {
            justification: "security review",
          }),
        ).toBe("ok");
      }
    }
  });

  test("is no one else's, an agent's admin and the creator included", async () => {
    const with_ = { justification: "x" };
    expect(
      await reason("agent_admin", "session.audit_read", on(PERSONS), with_),
    ).toBe("not_found");
    expect(await reason("member", "session.audit_read", on(OPEN), with_)).toBe(
      "role",
    );
    expect(
      await reason("creator", "session.audit_read", on(PERSONS), with_),
    ).toBe("role");
    expect(
      await reason("service_key", "session.audit_read", on(KEYS), with_),
    ).toBe("role");
  });
});

describe("session.share (D21)", () => {
  // o allowed, x refused. Columns: owner, admin, creator, member, agent
  // admin, service key, the creator's personal key.
  const WHO: Who[] = [
    "owner",
    "admin",
    "creator",
    "member",
    "agent_admin",
    "service_key",
    "creators_key",
  ];
  const TABLE: [string, string, string][] = [
    ["a person's session", PERSONS, "xxoxxxx"],
    ["a service key's session", KEYS, "ooxxoxx"],
  ];
  for (const [row, id, cells] of TABLE) {
    test(row, async () => {
      const got = await Promise.all(
        WHO.map(async (who) =>
          (await decide(who, "session.share", on(id))).outcome === "allow"
            ? "o"
            : "x",
        ),
      );
      expect(got.join("")).toBe(cells);
    });
  }

  test("someone who cannot see it and may not share it is told it does not exist", async () => {
    expect(await reason("member", "session.share", on(PERSONS))).toBe(
      "not_found",
    );
    expect(await reason("member", "session.share", on(OPEN))).toBe("ok");
    expect(await reason("owner", "session.share", on(OPEN))).toBe("role");
  });

  test("without a store whose session it is cannot be read", async () => {
    const { caller, identity } = subject("creator");
    const decision = await createAuthorizationPolicy({
      identity,
      agents,
    }).authorize({
      subject: caller.subject,
      action: "session.share",
      resource: { kind: "session", id: PERSONS, owner_scope: WORKSPACE },
      request_id: "r",
    });
    expect(decision.reason_code).toBe("error");
  });
});

describe("session.admin_list", () => {
  test("is the owner's and the admin's alone", async () => {
    const onWorkspace = { kind: "workspace", id: WORKSPACE } as const;
    const got = await Promise.all(
      (
        [
          "owner",
          "admin",
          "member",
          "agent_admin",
          "service_key",
          "creators_key",
        ] as const
      ).map(async (who) =>
        (await decide(who, "session.admin_list", onWorkspace)).outcome ===
        "allow"
          ? "o"
          : "x",
      ),
    );
    expect(got.join("")).toBe("ooxxxx");
  });
});

describe("what is kept", () => {
  function log() {
    const rows: { action: string; justification?: string }[] = [];
    const decisions: DecisionLog = {
      async record({ request }) {
        rows.push({
          action: request.action,
          ...(request.subject.justification === undefined
            ? {}
            : { justification: request.subject.justification }),
        });
      },
    };
    return { rows, decisions };
  }

  test("every allowed audit read, share and reasoned action, with its reason", async () => {
    const { rows, decisions } = log();
    await decide("owner", "session.audit_read", on(PERSONS), {
      justification: "incident 42",
      decisions,
    });
    await decide("creator", "session.share", on(PERSONS), { decisions });
    await decide("admin", "session.control", on(OPEN), {
      justification: "stuck",
      decisions,
    });
    await decide("creator", "session.read", on(PERSONS), { decisions });
    expect(rows).toEqual([
      { action: "session.audit_read", justification: "incident 42" },
      { action: "session.share" },
      { action: "session.control", justification: "stuck" },
    ]);
  });
});
