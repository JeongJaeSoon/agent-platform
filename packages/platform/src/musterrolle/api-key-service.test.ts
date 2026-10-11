import { describe, expect, test } from "bun:test";
import {
  type CreateApiKeyRequest,
  SESSION_SCOPE_VALUES,
  scopesForRole,
  type WorkspaceRole,
} from "@agent-platform/contracts";
import type {
  IssueKeyInput,
  WorkspaceKey,
  WorkspaceKeyStore,
} from "../ports/api-key-store.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { createApiKeyService } from "./api-key-service.ts";
import {
  type AgentAuthority,
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "./policy.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER = "019a0000-0000-7000-8000-0000000000a1";
const ADMIN = "019a0000-0000-7000-8000-0000000000a2";
const MEMBER = "019a0000-0000-7000-8000-0000000000a3";
const AGENT_ADMIN = "019a0000-0000-7000-8000-0000000000a4";
const AGENT_A = "019a0000-0000-7000-8000-00000000b0a1";
const AGENT_B = "019a0000-0000-7000-8000-00000000b0b1";

const agents: AgentAuthority = {
  agentOf: async (_ws, resource) => resource.id,
  isAdmin: async (_ws, agentId, userId) =>
    agentId === AGENT_A && userId === AGENT_ADMIN,
};

function user(id: string, role: WorkspaceRole): Caller {
  return callerFor(
    {
      kind: "user",
      id,
      workspace_id: WORKSPACE,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: "web" },
    crypto.randomUUID(),
  );
}

function fakeStore() {
  const keys = new Map<string, WorkspaceKey>();
  const issued: IssueKeyInput[] = [];
  const store: WorkspaceKeyStore = {
    async issue(input) {
      issued.push(input);
      const key: WorkspaceKey = {
        id: input.id,
        workspaceId: input.workspaceId,
        kind: input.kind,
        agentId: input.agentId,
        createdByUserId: input.createdByUserId,
        scopes: [...input.scopes],
        createdAt: new Date("2026-10-11T00:00:00.000Z"),
        expiresAt: input.expiresAt,
        revokedAt: null,
      };
      keys.set(key.id, key);
      return { outcome: "issued", key };
    },
    find: async (_ws, id) => keys.get(id) ?? null,
    async list() {
      return [...keys.values()];
    },
    async revoke(input) {
      const key = keys.get(input.keyId);
      if (!key) return { outcome: "not_found" };
      if (key.revokedAt) return { outcome: "already_revoked", key };
      key.revokedAt = new Date("2026-10-11T01:00:00.000Z");
      return { outcome: "revoked", key };
    },
  };
  return { store, issued, keys };
}

function service(store = fakeStore()) {
  return {
    ...store,
    keys: createApiKeyService({
      authorization: createAuthorizationPolicy({ agents }),
      store: store.store,
      mint: () => ({ secret: "csp_test", hash: new Uint8Array([1]) }),
      now: () => new Date("2026-10-11T00:00:00.000Z"),
    }),
  };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SessionServiceError);
  return error as SessionServiceError;
}

const personal: CreateApiKeyRequest = {
  kind: "personal",
  scopes: ["sessions:read"],
};
const service_: CreateApiKeyRequest = {
  kind: "service",
  scopes: ["sessions:read", "sessions:write"],
};
const agentKey = (agent: string): CreateApiKeyRequest => ({
  kind: "service",
  scopes: ["sessions:read", "sessions:write"],
  agent_id: agent,
});

describe("issuing a key", () => {
  test("a member issues their own personal key and nothing else", async () => {
    const { keys, issued } = service();
    const caller = user(MEMBER, "member");
    const created = await keys.issue(caller, personal);
    expect(created).toMatchObject({
      secret: "csp_test",
      key: { kind: "personal", created_by: MEMBER, agent_id: null },
    });
    expect(issued[0]?.createdByUserId).toBe(MEMBER);

    const denied = await refusal(keys.issue(caller, service_));
    expect(denied.code).toBe("FORBIDDEN");
    expect(denied.details).toEqual({ reason_code: "role" });
    expect((await refusal(keys.issue(caller, agentKey(AGENT_A)))).code).toBe(
      "FORBIDDEN",
    );
  });

  test("owners and admins issue service keys", async () => {
    const { keys } = service();
    for (const caller of [user(OWNER, "owner"), user(ADMIN, "admin")]) {
      expect((await keys.issue(caller, service_)).key.kind).toBe("service");
      expect((await keys.issue(caller, agentKey(AGENT_B))).key.agent_id).toBe(
        AGENT_B,
      );
    }
  });

  test("an agent's admin issues keys for that agent only", async () => {
    const { keys } = service();
    const caller = user(AGENT_ADMIN, "member");
    expect((await keys.issue(caller, agentKey(AGENT_A))).key.agent_id).toBe(
      AGENT_A,
    );
    expect((await refusal(keys.issue(caller, agentKey(AGENT_B)))).code).toBe(
      "FORBIDDEN",
    );
    expect((await refusal(keys.issue(caller, service_))).code).toBe(
      "FORBIDDEN",
    );
  });

  test("never above what the issuer holds now", async () => {
    const { keys } = service();
    const admin = await refusal(
      keys.issue(user(ADMIN, "admin"), {
        kind: "service",
        scopes: ["sessions:read", "sessions:recover"],
      }),
    );
    expect(admin.code).toBe("SCOPE_NOT_GRANTABLE");
    expect(admin.message).toContain("sessions:recover");
    // An owner holds recover, so the same key is theirs to make.
    expect(
      (
        await keys.issue(user(OWNER, "owner"), {
          kind: "service",
          scopes: [...SESSION_SCOPE_VALUES],
        })
      ).key.scopes,
    ).toContain("sessions:recover");
  });

  test("a key bound to an agent never approves (D26)", async () => {
    const { keys } = service();
    const error = await refusal(
      keys.issue(user(OWNER, "owner"), {
        ...agentKey(AGENT_A),
        scopes: ["sessions:approve"],
      }),
    );
    expect(error.code).toBe("SCOPE_NOT_GRANTABLE");
  });

  test("an API key issues no key, its own kind included", async () => {
    const { keys, issued } = service();
    const caller = callerFor(
      {
        kind: "api_key",
        id: "019a0000-0000-7000-8000-0000000000e1",
        owner_id: WORKSPACE,
        workspace_id: WORKSPACE,
        scopes: [...SESSION_SCOPE_VALUES],
      },
      { kind: "api" },
      crypto.randomUUID(),
      { creatorId: OWNER },
    );
    for (const body of [personal, service_, agentKey(AGENT_A)]) {
      expect((await refusal(keys.issue(caller, body))).code).toBe("FORBIDDEN");
    }
    expect(issued).toHaveLength(0);
  });

  test("a past expiry is refused", async () => {
    const { keys } = service();
    const error = await refusal(
      keys.issue(user(MEMBER, "member"), {
        ...personal,
        expires_at: "2026-10-10T00:00:00.000Z",
      }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });
});

describe("revoking a key", () => {
  test("another person's personal key does not exist for the caller", async () => {
    const { keys } = service();
    const { key } = await keys.issue(user(MEMBER, "member"), personal);
    expect(
      (await refusal(keys.revoke(user(OWNER, "owner"), key.id))).code,
    ).toBe("NOT_FOUND");
    const revoked = await keys.revoke(user(MEMBER, "member"), key.id);
    expect(revoked.key.revoked_at).not.toBeNull();
    expect(revoked.receipt_id).not.toBeNull();
    // A second revoke changes nothing and writes no receipt.
    expect(
      (await keys.revoke(user(MEMBER, "member"), key.id)).receipt_id,
    ).toBeNull();
  });

  test("an agent's key falls to that agent's admin, a service key does not", async () => {
    const { keys } = service();
    const owner = user(OWNER, "owner");
    const bound = (await keys.issue(owner, agentKey(AGENT_A))).key;
    const plain = (await keys.issue(owner, service_)).key;
    const caller = user(AGENT_ADMIN, "member");
    expect((await refusal(keys.revoke(caller, plain.id))).code).toBe(
      "FORBIDDEN",
    );
    expect((await keys.revoke(caller, bound.id)).key.revoked_at).not.toBeNull();
  });
});
