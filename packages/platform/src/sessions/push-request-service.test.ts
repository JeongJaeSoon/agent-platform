import { describe, expect, test } from "bun:test";
import {
  GITHUB_CEILING_NONE,
  type Principal,
  type PushRequest,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit";
import type { PushSourceResult } from "../checkpoints/checkpoint-service.ts";
import {
  type AuthorizationPolicy,
  callerFor,
  createAuthorizationPolicy,
} from "../musterrolle/policy.ts";
import type {
  CreatePushRequestInput,
  PushRefusalRecord,
  PushRequestStore,
} from "../ports/push-requests.ts";
import type { InstallationProfileEntry, SessionCatalog } from "./catalog.ts";
import { createPushRequestService } from "./push-request-service.ts";
import { SessionServiceError } from "./session-service.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const PUSH = "22222222-2222-4222-8222-222222222222";
const CATALOG = {
  profiles: {},
  repositories: {
    "sample-app": {
      url: "https://git.example/acme/sample-app.git",
      branch: "main",
      profiles: ["default"],
    },
  },
} satisfies SessionCatalog;

function service() {
  const refusals: PushRefusalRecord[] = [];
  const decided: unknown[] = [];
  const store = {
    recordRefusal: async (input: PushRefusalRecord) => {
      refusals.push(input);
      return "receipt-1";
    },
    decide: async (input: unknown) => {
      decided.push(input);
      throw new Error("not reached");
    },
  } as unknown as PushRequestStore;
  return {
    refusals,
    decided,
    push: createPushRequestService({
      authorization: createAuthorizationPolicy(),
      store,
      catalog: CATALOG,
      source: {
        readPushSource: async () => ({ status: "none" }),
      },
    }),
  };
}

describe("push request decisions", () => {
  test("a principal kind outside the allowlist cannot decide, even holding sessions:approve", async () => {
    const { push, refusals, decided } = service();
    const installation: Principal = {
      kind: "installation",
      id: "inst-1",
      owner_id: "owner-a",
      workspace_id: "9d2c4e61-8a3b-4f70-b1e5-6c0a7d3f2b98",
      scopes: ["sessions:approve"],
    };
    let bodyRead = false;
    const error = await push
      .decide(
        {
          caller: testCaller("owner-a"),
          principal: installation,
          ownerId: "owner-a",
          verified: true,
        },
        SESSION,
        PUSH,
        {
          idempotencyKey: "k-1",
          readBody: async () => {
            bodyRead = true;
            return { decision: "approve", git_commit: "a".repeat(40) };
          },
        },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect((error as SessionServiceError).code).toBe("FORBIDDEN");
    expect((error as SessionServiceError).details).toEqual({
      refusal: "unverified_principal",
      receipt_id: "receipt-1",
    });
    expect(refusals).toMatchObject([
      {
        operation: "decide_push",
        refusal: "unverified_principal",
        actor: {
          principal: { kind: "installation", id: "inst-1" },
          actor_user_id: null,
        },
      },
    ]);
    expect(bodyRead).toBe(false);
    expect(decided).toEqual([]);
  });

  test("an uppercase session id reads the checkpoint and records receipts under the stored id", async () => {
    const read: string[] = [];
    const refusals: PushRefusalRecord[] = [];
    const push = createPushRequestService({
      authorization: createAuthorizationPolicy(),
      store: {
        findSession: async () => ({
          repositoryId: "sample-app",
          approvalOffRelease: null,
        }),
        replayCreate: async () => null,
        recordRefusal: async (input: PushRefusalRecord) => {
          refusals.push(input);
          return "receipt-1";
        },
      } as unknown as PushRequestStore,
      catalog: CATALOG,
      source: {
        readPushSource: async (sessionId) => {
          read.push(sessionId);
          return { status: "none" };
        },
      },
    });
    const actor = {
      caller: testCaller("owner-a"),
      principal: {
        kind: "api_key",
        id: "key-1",
        owner_id: "owner-a",
        scopes: [],
      } as unknown as Principal,
      ownerId: "owner-a",
      verified: true,
    };
    const session = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb";
    const pushId = "cccccccc-2222-4222-8222-dddddddddddd";
    await push
      .create(actor, session.toUpperCase(), { idempotencyKey: "k-1" })
      .catch(() => {});
    await push
      .decide(actor, session.toUpperCase(), pushId.toUpperCase(), {
        idempotencyKey: "k-2",
        readBody: async () => ({
          decision: "reject",
          git_commit: "a".repeat(40),
        }),
      })
      .catch(() => {});
    expect(read).toEqual([session]);
    expect(refusals.map((refusal) => refusal.sessionId)).toEqual([
      session,
      session,
    ]);
    expect(refusals[1]?.result.push_request_id).toBe(pushId);
  });

  test("an approval hands the store the session's last checkpoint, or null when it cannot be read", async () => {
    const decided: Array<{ latest?: unknown }> = [];
    const approve = (readPushSource: () => Promise<PushSourceResult>) =>
      createPushRequestService({
        authorization: createAuthorizationPolicy({
          sessions: { visibleTo: async () => true, originOf: async () => null },
        }),
        store: {
          decide: async (input: { latest?: unknown }) => {
            decided.push(input);
            return { outcome: "conflict" };
          },
        } as unknown as PushRequestStore,
        catalog: CATALOG,
        source: { readPushSource },
      })
        .decide(
          {
            caller: testCaller("owner-a"),
            principal: {
              kind: "api_key",
              id: "key-1",
              owner_id: "owner-a",
              scopes: ["sessions:approve"],
            } as unknown as Principal,
            ownerId: "owner-a",
            verified: true,
          },
          SESSION,
          PUSH,
          {
            idempotencyKey: "k-1",
            readBody: async () => ({
              decision: "approve",
              git_commit: "a".repeat(40),
            }),
          },
        )
        .catch(() => {});
    await approve(async () => ({
      status: "ready",
      revision: 3,
      gitCommit: "a".repeat(40),
    }));
    await approve(async () => {
      throw new Error("store outage");
    });
    expect(decided.map((input) => input.latest)).toEqual([
      { revision: 3, gitCommit: "a".repeat(40) },
      null,
    ]);
  });

  test("the key that started the session cannot approve its push; another key of the agent can (GA-8)", async () => {
    const workspace = "9d2c4e61-8a3b-4f70-b1e5-6c0a7d3f2b98";
    const agent = "019a0000-0000-7000-8000-0000000000a1";
    const issuer = "019a0000-0000-7000-8000-0000000000c1";
    const starter = "019a0000-0000-7000-8000-0000000000f1";
    const second = "019a0000-0000-7000-8000-0000000000f2";
    const refusals: PushRefusalRecord[] = [];
    const decided: Array<{ deciderKey?: unknown; actor?: unknown }> = [];
    let bodyRead = 0;
    const push = createPushRequestService({
      authorization: createAuthorizationPolicy({
        identity: {
          reread: async (s) => ({
            status: "ok",
            principal: s.principal,
            keyAgentId: agent,
          }),
        },
        agents: {
          agentOf: async () => agent,
          isAdmin: async () => false,
        },
        sessions: {
          visibleTo: async () => true,
          originOf: async () => ({
            creatorUserId: null,
            creatorApiKeyId: starter,
          }),
        },
      }),
      store: {
        recordRefusal: async (input: PushRefusalRecord) => {
          refusals.push(input);
          return "receipt-self";
        },
        decide: async (input: { deciderKey?: unknown; actor?: unknown }) => {
          decided.push(input);
          return { outcome: "conflict" };
        },
      } as unknown as PushRequestStore,
      catalog: CATALOG,
      source: { readPushSource: async () => ({ status: "none" }) },
    });
    const actorOf = (id: string) => {
      const principal: Principal = {
        kind: "api_key",
        id,
        owner_id: workspace,
        workspace_id: workspace,
        scopes: ["sessions:read", "sessions:write", "sessions:approve"],
      };
      return {
        caller: callerFor(principal, { kind: "api" }, "r", {
          creatorId: null,
          agentId: agent,
          issuerId: issuer,
        }),
        principal,
        ownerId: workspace,
        verified: true,
      };
    };
    const decide = (id: string) =>
      push.decide(actorOf(id), SESSION, PUSH, {
        idempotencyKey: `k-${id}`,
        readBody: async () => {
          bodyRead += 1;
          return { decision: "approve", git_commit: "a".repeat(40) };
        },
      });

    const error = await decide(starter).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect((error as SessionServiceError).code).toBe("FORBIDDEN");
    expect((error as SessionServiceError).details).toEqual({
      refusal: "self_approval",
      receipt_id: "receipt-self",
    });
    expect(refusals).toMatchObject([
      {
        operation: "decide_push",
        refusal: "self_approval",
        actor: {
          principal: { kind: "api_key", id: starter },
          agent_id: agent,
        },
        result: {
          verdict: "refuse",
          refusal: "self_approval",
          decider_key: {
            id: starter,
            kind: "agent",
            issued_by_user_id: issuer,
          },
        },
      },
    ]);
    expect(bodyRead).toBe(0);
    expect(decided).toEqual([]);

    await decide(second).catch(() => {});
    expect(bodyRead).toBe(1);
    expect(decided).toMatchObject([
      {
        actor: { principal: { kind: "api_key", id: second } },
        deciderKey: { id: second, kind: "agent", issued_by_user_id: issuer },
      },
    ]);
  });

  test("a session the caller cannot see is NOT_FOUND, and nothing reads or writes the store", async () => {
    const touched: string[] = [];
    const hidden: AuthorizationPolicy = {
      authorize: async () => ({
        outcome: "deny",
        reason_code: "not_found",
        effective_scopes: [],
        policy_version: "test",
        decision_id: crypto.randomUUID(),
      }),
    };
    const store = new Proxy({} as PushRequestStore, {
      get: (_target, name) => async () => {
        touched.push(String(name));
        return null;
      },
    });
    const push = createPushRequestService({
      authorization: hidden,
      store,
      source: {
        readPushSource: async () => {
          touched.push("readPushSource");
          return { status: "none" };
        },
      },
      catalog: CATALOG,
    });
    const actor = {
      caller: testCaller("owner-a"),
      principal: {
        kind: "api_key",
        id: "key-1",
        owner_id: "owner-a",
        workspace_id: null,
        scopes: ["sessions:read", "sessions:write", "sessions:approve"],
      } as Principal,
      ownerId: "owner-a",
      verified: true,
    };
    const attempts = [
      push.create(actor, SESSION, { idempotencyKey: "k-1" }),
      push.list(actor, SESSION),
      push.get(actor, SESSION, PUSH),
      push.decide(actor, SESSION, PUSH, {
        idempotencyKey: "k-2",
        readBody: async () => ({
          decision: "approve",
          git_commit: "a".repeat(40),
        }),
      }),
    ];
    for (const attempt of attempts) {
      const error = await attempt.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SessionServiceError);
      expect((error as SessionServiceError).code).toBe("NOT_FOUND");
    }
    expect(touched).toEqual([]);
  });
});

describe("a push to another repository", () => {
  const MULTI = {
    profiles: { default: {} as SessionCatalog["profiles"][string] },
    repositories: {
      ...CATALOG.repositories,
      docs: { url: "https://git.example/acme/docs.git", branch: "main" },
      tools: { url: "https://git.example/acme/tools.git", branch: "main" },
    },
    installation: new Map<string, InstallationProfileEntry>([
      [
        "default",
        {
          id: "default",
          origin: "catalog",
          state: "usable",
          repository_ids: ["sample-app", "docs", "tools"],
        },
      ],
    ]),
  } satisfies SessionCatalog;

  function pushing(attached: string[] | null) {
    const created: CreatePushRequestInput[] = [];
    const refusals: PushRefusalRecord[] = [];
    const push = createPushRequestService({
      authorization: createAuthorizationPolicy(),
      store: {
        replayCreate: async () => null,
        findSession: async () => ({
          repositoryId: "sample-app",
          profileId: "default",
          attached,
          github: {
            repositories: ["sample-app", "docs", "tools"],
            features: GITHUB_CEILING_NONE,
            actions_allow: [],
            push_approval: true,
          },
          githubEnabled: true,
          approvalOffRelease: null,
        }),
        recordRefusal: async (input: PushRefusalRecord) => {
          refusals.push(input);
          return "receipt-1";
        },
        create: async (input: CreatePushRequestInput) => {
          created.push(input);
          return { outcome: "written", request: {} as PushRequest };
        },
      } as unknown as PushRequestStore,
      catalog: MULTI,
      source: {
        readPushSource: async () => ({
          status: "ready",
          revision: 3,
          gitCommit: "a".repeat(40),
        }),
      },
    });
    const actor = {
      caller: testCaller("owner-a"),
      principal: {
        kind: "api_key",
        id: "owner-a",
        owner_id: "owner-a",
        workspace_id: null,
        scopes: ["sessions:write"],
      } as Principal,
      ownerId: "owner-a",
      verified: true,
    };
    const to = (repository_id: string) =>
      push
        .create(actor, SESSION, {
          idempotencyKey: `k-${repository_id}`,
          body: { repository_id },
        })
        .then(
          () => null,
          (caught: unknown) => caught,
        );
    return { to, created, refusals };
  }

  test("is refused for a repository the release lists but the session did not attach", async () => {
    const { to, created, refusals } = pushing(["docs"]);
    const error = await to("tools");
    expect(error).toBeInstanceOf(SessionServiceError);
    expect((error as SessionServiceError).details).toEqual({
      refusal: "repository_not_allowed",
      receipt_id: "receipt-1",
    });
    expect(refusals.at(-1)?.result).toMatchObject({ repository_id: "tools" });
    expect(await to("docs")).toBeNull();
    expect(created.map((input) => input.repositoryId)).toEqual(["docs"]);
  });

  test("without an attached list, every repository the release lists", async () => {
    const { to, created } = pushing(null);
    expect(await to("tools")).toBeNull();
    expect(created.map((input) => input.repositoryId)).toEqual(["tools"]);
  });
});

describe("a release with push_approval off", () => {
  const RELEASE = "019a0000-0000-7000-8000-0000000000d1";

  function creating(approvalOffRelease: string | null) {
    const created: CreatePushRequestInput[] = [];
    const push = createPushRequestService({
      authorization: createAuthorizationPolicy(),
      store: {
        replayCreate: async () => null,
        findSession: async () => ({
          repositoryId: "sample-app",
          approvalOffRelease,
        }),
        create: async (input: CreatePushRequestInput) => {
          created.push(input);
          const approved = input.approvedByRelease !== null;
          const request: PushRequest = {
            id: PUSH,
            session_id: input.sessionId,
            repository_id: input.repositoryId,
            checkpoint_revision: input.checkpointRevision,
            git_commit: input.gitCommit,
            target_branch: `agent/${input.sessionId}`,
            state: approved ? "approved" : "requested",
            requested_by: input.actor,
            requested_at: "2026-10-30T00:00:00.000Z",
            decided_by:
              input.approvedByRelease === null
                ? null
                : { kind: "policy", agent_release_id: input.approvedByRelease },
            decided_at: approved ? "2026-10-30T00:00:00.000Z" : null,
            decision_reason: null,
            request_receipt_id: "019a0000-0000-7000-8000-0000000000e1",
            decision_receipt_id: approved
              ? "019a0000-0000-7000-8000-0000000000e2"
              : null,
            finished_at: null,
            push_receipt_id: null,
          };
          return { outcome: "written", request };
        },
      } as unknown as PushRequestStore,
      catalog: CATALOG,
      source: {
        readPushSource: async () => ({
          status: "ready",
          revision: 3,
          gitCommit: "a".repeat(40),
        }),
      },
    });
    const actor = {
      caller: testCaller("owner-a"),
      principal: {
        kind: "api_key",
        id: "owner-a",
        owner_id: "owner-a",
        workspace_id: null,
        scopes: ["sessions:write"],
      } as Principal,
      ownerId: "owner-a",
      verified: true,
    };
    return { push, actor, created };
  }

  test("creates a request already approved by the release's policy", async () => {
    const { push, actor, created } = creating(RELEASE);
    const request = await push.create(actor, SESSION, { idempotencyKey: "k" });
    expect(created[0]?.approvedByRelease).toBe(RELEASE);
    expect(request).toMatchObject({
      state: "approved",
      decided_by: { kind: "policy", agent_release_id: RELEASE },
    });
  });

  test("a release that keeps push approval creates a requested one", async () => {
    const { push, actor, created } = creating(null);
    const request = await push.create(actor, SESSION, { idempotencyKey: "k" });
    expect(created[0]?.approvedByRelease).toBeNull();
    expect(request.state).toBe("requested");
  });
});
