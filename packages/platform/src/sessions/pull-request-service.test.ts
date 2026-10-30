import { describe, expect, test } from "bun:test";
import type {
  GitHubRefusal,
  Principal,
  PullRequest,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit";
import {
  type AuthorizationPolicy,
  callerFor,
  createAuthorizationPolicy,
} from "../musterrolle/policy.ts";
import { ForgeCredentialError, type ForgePullRequest } from "../ports/forge.ts";
import {
  type GitHubApi,
  type GitHubGate,
  GitHubGateError,
  type GitHubWork,
} from "../ports/github-gate.ts";
import type {
  PullRequestReceipt,
  PullRequestSource,
  PullRequestStore,
} from "../ports/pull-requests.ts";
import { repositoryBinding, type SessionCatalog } from "./catalog.ts";
import {
  commentMarker,
  createPullRequestService,
} from "./pull-request-service.ts";
import { SessionServiceError } from "./session-service.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const PUSH = "22222222-2222-4222-8222-222222222222";
const HEAD = `agent/${SESSION}`;
const ZWSP = "​";
const CATALOG = {
  profiles: {},
  repositories: {
    app: {
      url: "https://github.com/acme/app.git",
      branch: "develop",
      profiles: ["default"],
    },
  },
} satisfies SessionCatalog;
const human: Principal = {
  kind: "api_key",
  id: "key-1",
  owner_id: "owner-a",
  workspace_id: null,
  scopes: ["sessions:approve"],
};
const actor = {
  caller: testCaller("owner-a"),
  principal: human,
  ownerId: "owner-a",
  verified: true,
};

function harness(
  options: {
    state?: PullRequestSource["state"];
    binding?: string;
    authorization?: AuthorizationPolicy;
    gateRefusal?: GitHubRefusal;
  } = {},
) {
  const receipts: PullRequestReceipt[] = [];
  const saved: PullRequest[] = [];
  const calls: string[] = [];
  const sourceReads: string[] = [];
  const source: PullRequestSource = {
    id: PUSH,
    sessionId: SESSION,
    repositoryId: "app",
    repositoryBinding:
      options.binding ?? repositoryBinding("app", CATALOG.repositories.app),
    state: options.state ?? "pushed",
    targetBranch: HEAD,
    gitCommit: "a".repeat(40),
  };
  const store: PullRequestStore = {
    findSource: async (_owner, session, push) => {
      sourceReads.push(session);
      return session === SESSION && push === PUSH ? source : null;
    },
    findPullRequest: async (_owner, push) =>
      saved.find((entry) => entry.push_request_id === push) ?? null,
    findBranchPullRequest: async (_owner, session, head) =>
      [...saved]
        .reverse()
        .find((entry) => entry.session_id === session && entry.head === head) ??
      null,
    recordReceipt: async (input) => {
      receipts.push(input);
      return `receipt-${receipts.length}`;
    },
    savePullRequest: async (input) => {
      receipts.push({ ...input, operation: "open_pull_request" } as never);
      const pullRequest: PullRequest = {
        push_request_id: input.pushRequestId,
        session_id: input.sessionId,
        repository_id: input.repositoryId,
        number: input.number,
        url: input.url,
        head: input.head,
        base: input.base,
        created_at: "2026-10-13T00:00:00.000Z",
        receipt_id: `receipt-${receipts.length}`,
      };
      saved.push(pullRequest);
      return {
        pullRequest,
        created: input.created,
        receiptId: pullRequest.receipt_id,
      };
    },
  };
  let open: ForgePullRequest | null = null;
  const created: Array<{
    head: string;
    base: string;
    title: string;
    body: string;
  }> = [];
  const comments: Array<{ marker: string; body: string }> = [];
  let failing = false;
  let gateRefusal = options.gateRefusal ?? null;
  const works: GitHubWork[] = [];
  const fail = () => {
    if (failing) throw new ForgeCredentialError("GitHub call failed (502)");
  };
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  const forge: GitHubApi = {
    maxBodyLength: 65_536,
    getRepository: unused,
    dispatchWorkflow: unused,
    getWorkflowRun: unused,
    rerunWorkflow: unused,
    findPullRequestForBranch: async (branch) => {
      calls.push(`find ${branch}`);
      fail();
      return open;
    },
    createPullRequest: async (input) => {
      calls.push(`create ${input.head}`);
      fail();
      created.push(input);
      open = {
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        state: "open",
        head: input.head,
        base: input.base,
      };
      return open;
    },
    upsertComment: async (number, marker, body) => {
      calls.push(`comment ${number}`);
      fail();
      comments.push({ marker, body });
      return {
        id: 99,
        url: "https://github.com/acme/app/pull/7#issuecomment-99",
        created: comments.length === 1,
      };
    },
  };
  const gate: GitHubGate = {
    grant: async (work) => {
      works.push(work);
      if (gateRefusal !== null) {
        throw new GitHubGateError(gateRefusal, "gate-receipt");
      }
      return {
        role: "author",
        repo: { owner: "acme", name: "app" },
        permissions: { contents: "read", pull_requests: "write" },
        gitCredential: { username: "x-access-token", password: "issued" },
        api: forge,
        allowedBy: null,
        context: {
          ownerId: "owner-a",
          sessionId: work.sessionId,
          agentId: null,
          agentReleaseId: null,
          repositoryId: "app",
        },
      };
    },
  };
  const service = createPullRequestService({
    authorization: options.authorization ?? createAuthorizationPolicy(),
    store,
    catalog: CATALOG,
    gate,
    redact: (line) => (line.includes("ghp_") ? "[REDACTED]" : line),
  });
  return {
    service,
    receipts,
    sourceReads,
    saved,
    calls,
    works,
    created,
    comments,
    setOpen: (pull: ForgePullRequest) => {
      open = pull;
    },
    failForge: () => {
      failing = true;
    },
    refuseGitHub: (reason: GitHubRefusal) => {
      gateRefusal = reason;
    },
  };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SessionServiceError);
  const { code, details } = error as SessionServiceError;
  return { code, details };
}

describe("opening a pull request", () => {
  test("a session the caller cannot see is NOT_FOUND, and neither the store nor the forge is touched", async () => {
    const hidden: AuthorizationPolicy = {
      authorize: async () => ({
        outcome: "deny",
        reason_code: "not_found",
        effective_scopes: [],
        policy_version: "test",
        decision_id: crypto.randomUUID(),
      }),
    };
    const { service, receipts, calls, sourceReads } = harness({
      authorization: hidden,
    });
    for (const attempt of [
      service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
      service.comment(actor, SESSION, PUSH, {
        readBody: async () => ({ body: "hi" }),
      }),
    ]) {
      expect((await refusal(attempt)).code).toBe("NOT_FOUND");
    }
    expect(sourceReads).toEqual([]);
    expect(receipts).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("opens one from agent/<session-id> into the catalog branch with cleaned text, then answers it again", async () => {
    const { service, created, calls, receipts } = harness();
    const first = await service.open(actor, SESSION.toUpperCase(), PUSH, {
      readBody: async () => ({
        title: "Fix for @octocat",
        body: "Closes #3\ntoken ghp_abc\nsee acme/other#4",
      }),
    });
    expect(first).toMatchObject({
      created: true,
      pull_request: { number: 7, head: HEAD, base: "develop" },
    });
    expect(created).toEqual([
      {
        head: HEAD,
        base: "develop",
        title: `Fix for @${ZWSP}octocat`,
        body: `C${ZWSP}loses #3\n[REDACTED]\nsee acme/other#${ZWSP}4\n\n---\nOpened by agent-platform from session \`${SESSION}\`, commit \`${"a".repeat(40)}\`.`,
      },
    ]);

    const again = await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({}),
    });
    expect(again).toMatchObject({
      created: false,
      pull_request: { number: 7 },
    });
    expect(calls).toEqual([`find ${HEAD}`, `create ${HEAD}`]);
    expect(receipts.at(-1)?.result).toMatchObject({
      verdict: "allow",
      created: false,
      number: 7,
    });
  });

  test("a personal key's receipts name its issuer, as the policy resolved them", async () => {
    const issuer = "019a0000-0000-7000-8000-0000000000c1";
    const { service, receipts } = harness({
      authorization: createAuthorizationPolicy({
        identity: {
          reread: async ({ principal }) => ({
            status: "ok",
            principal,
            keyCreator: { userId: issuer, role: "owner" },
          }),
        },
      }),
    });
    const caller = callerFor(human, { kind: "api" }, "request-1", {
      creatorId: issuer,
    });
    await service.open({ ...actor, caller }, SESSION, PUSH, {
      readBody: async () => ({}),
    });
    expect(receipts.map((receipt) => receipt.actor)).toEqual([
      {
        principal: { kind: "api_key", id: "key-1" },
        actor_user_id: issuer,
        agent_id: null,
      },
    ]);
  });

  test("an open pull request the forge already has for the branch is recorded, not opened again", async () => {
    const { service, setOpen, calls } = harness();
    setOpen({
      number: 3,
      url: "https://github.com/acme/app/pull/3",
      state: "open",
      head: HEAD,
      base: "develop",
    });
    const opened = await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({}),
    });
    expect(opened).toMatchObject({
      created: false,
      pull_request: { number: 3 },
    });
    expect(calls).toEqual([`find ${HEAD}`]);
  });

  test("only a pushed request opens one", async () => {
    for (const state of [
      "requested",
      "approved",
      "pushing",
      "failed",
    ] as const) {
      const { service, calls, receipts } = harness({ state });
      expect(
        await refusal(
          service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
        ),
      ).toEqual({
        code: "PUSH_NOT_PUSHED",
        details: { refusal: "not_pushed", receipt_id: "receipt-1" },
      });
      expect(calls).toEqual([]);
      expect(receipts[0]).toMatchObject({
        operation: "open_pull_request",
        result: {
          verdict: "refuse",
          refusal: "not_pushed",
          repository_id: "app",
        },
      });
    }
  });

  test("a catalog entry changed since the push request pinned it is refused", async () => {
    const { service, calls } = harness({ binding: "stale" });
    expect(
      (
        await refusal(
          service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
        )
      ).code,
    ).toBe("CATALOG_MISMATCH");
    expect(calls).toEqual([]);
  });

  test("asks the gate for a pull_request grant as the caller", async () => {
    const { service, works } = harness();
    await service.open(actor, SESSION, PUSH, { readBody: async () => ({}) });
    expect(works).toEqual([
      {
        sessionId: SESSION,
        purpose: "pull_request",
        actor: {
          principal: { kind: "api_key", id: "key-1" },
          actor_user_id: null,
          agent_id: null,
        },
      },
    ]);
  });

  test("a gate refusal is GITHUB_REFUSED with its reason_code and a receipt before the forge is asked", async () => {
    const { service, calls, receipts } = harness({
      gateRefusal: "repository_not_allowed",
    });
    expect(
      await refusal(
        service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
      ),
    ).toEqual({
      code: "GITHUB_REFUSED",
      details: {
        refusal: "github_refused",
        receipt_id: "receipt-1",
        reason_code: "repository_not_allowed",
      },
    });
    expect(calls).toEqual([]);
    expect(receipts[0]?.result).toMatchObject({
      verdict: "refuse",
      refusal: "github_refused",
      reason_code: "repository_not_allowed",
      repository_id: "app",
    });
  });

  test("a credential without sessions:approve or sessions:write, or not a human's, is refused with a receipt before the body is read", async () => {
    for (const principal of [
      { ...human, scopes: ["sessions:read"] },
      { ...human, kind: "installation" },
    ] as Principal[]) {
      const { service, receipts } = harness();
      let read = false;
      const { code } = await refusal(
        service.open(
          {
            ...actor,
            caller: testCaller("owner-a", ["sessions:read"]),
            principal,
          },
          SESSION,
          PUSH,
          {
            readBody: async () => {
              read = true;
              return {};
            },
          },
        ),
      );
      expect(code).toBe("FORBIDDEN");
      expect(read).toBe(false);
      expect(receipts).toHaveLength(1);
    }
    const { service, receipts } = harness();
    expect(
      (
        await refusal(
          service.open({ ...actor, verified: false }, SESSION, PUSH, {
            readBody: async () => ({}),
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(receipts).toEqual([]);
  });

  test("a forge failure is a 503 with a receipt", async () => {
    const { service, failForge, receipts } = harness();
    failForge();
    expect(
      await refusal(
        service.open(actor, SESSION, PUSH, { readBody: async () => ({}) }),
      ),
    ).toEqual({
      code: "BACKEND_UNAVAILABLE",
      details: { refusal: "forge_failed", receipt_id: "receipt-1" },
    });
    expect(receipts[0]?.result).toMatchObject({
      head: HEAD,
      base: "develop",
    });
  });
});

describe("commenting on the pull request", () => {
  test("needs the pull request first", async () => {
    const { service, calls } = harness();
    expect(
      (
        await refusal(
          service.comment(actor, SESSION, PUSH, {
            readBody: async () => ({ body: "hi" }),
          }),
        )
      ).code,
    ).toBe("PULL_REQUEST_MISSING");
    expect(calls).toEqual([]);
  });

  test("a gate refusal comments on nothing", async () => {
    const { service, calls, comments, refuseGitHub } = harness();
    await service.open(actor, SESSION, PUSH, { readBody: async () => ({}) });
    refuseGitHub("github_disabled");
    const asked = calls.length;
    expect(
      (
        await refusal(
          service.comment(actor, SESSION, PUSH, {
            readBody: async () => ({ body: "hi" }),
          }),
        )
      ).details,
    ).toMatchObject({
      refusal: "github_refused",
      reason_code: "github_disabled",
    });
    expect(calls).toHaveLength(asked);
    expect(comments).toEqual([]);
  });

  test("upserts by marker with cleaned text and records each comment", async () => {
    const { service, comments, receipts } = harness();
    await service.open(actor, SESSION, PUSH, { readBody: async () => ({}) });
    const first = await service.comment(actor, SESSION, PUSH, {
      readBody: async () => ({ body: "Done, @team please look" }),
    });
    const second = await service.comment(actor, SESSION, PUSH, {
      readBody: async () => ({ body: "Updated", marker: "status" }),
    });
    expect(first.comment).toMatchObject({
      id: 99,
      created: true,
      marker: "status",
    });
    expect(second.comment.created).toBe(false);
    expect(comments).toEqual([
      {
        marker: commentMarker(SESSION, "status"),
        body: `Done, @${ZWSP}team please look`,
      },
      { marker: commentMarker(SESSION, "status"), body: "Updated" },
    ]);
    expect(receipts.at(-1)).toMatchObject({
      operation: "comment_pull_request",
      result: {
        verdict: "allow",
        number: 7,
        comment_id: 99,
        marker: "status",
        created: false,
      },
    });
  });

  test("a later pushed request of the session comments on the pull request an earlier one opened", async () => {
    const earlier: PullRequest = {
      push_request_id: "33333333-3333-4333-8333-333333333333",
      session_id: SESSION,
      repository_id: "app",
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      head: HEAD,
      base: "develop",
      created_at: "2026-10-13T00:00:00.000Z",
      receipt_id: "receipt-0",
    };
    const pushed = harness();
    pushed.saved.push(earlier);
    const answered = await pushed.service.comment(actor, SESSION, PUSH, {
      readBody: async () => ({ body: "Pushed again" }),
    });
    expect(answered.pull_request).toEqual(earlier);
    expect(pushed.calls).toEqual(["comment 7"]);

    const requested = harness({ state: "requested" });
    requested.saved.push(earlier);
    expect(
      (
        await refusal(
          requested.service.comment(actor, SESSION, PUSH, {
            readBody: async () => ({ body: "Not pushed" }),
          }),
        )
      ).code,
    ).toBe("PULL_REQUEST_MISSING");
  });
});

describe("a caller that may submit to the session", () => {
  const AGENT = "019a0000-0000-7000-8000-0000000000c1";
  const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
  const agentKey: Principal = {
    kind: "api_key",
    id: "agent-key-1",
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: ["sessions:read", "sessions:write"],
  };
  const submitter = {
    caller: callerFor(agentKey, { kind: "api" }, "request-1", {
      creatorId: null,
      agentId: AGENT,
    }),
    principal: agentKey,
    ownerId: WORKSPACE,
    verified: true,
  };
  const policy = createAuthorizationPolicy({
    identity: {
      reread: async ({ principal }) => ({
        status: "ok",
        principal,
        keyAgentId: AGENT,
      }),
    },
    agents: {
      agentOf: async (_workspace, resource) =>
        resource.kind === "session" && resource.id === SESSION ? AGENT : null,
      isAdmin: async () => false,
    },
  });
  const pulled: PullRequest = {
    push_request_id: PUSH,
    session_id: SESSION,
    repository_id: "app",
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    head: HEAD,
    base: "develop",
    created_at: "2026-10-13T00:00:00.000Z",
    receipt_id: "receipt-0",
  };

  test("an agent key opens a pull request for a pushed request and comments on it", async () => {
    const { service, calls, receipts } = harness({ authorization: policy });
    expect(
      await service.open(submitter, SESSION, PUSH, {
        readBody: async () => ({}),
      }),
    ).toMatchObject({ created: true, pull_request: { number: 7 } });
    await service.comment(submitter, SESSION, PUSH, {
      readBody: async () => ({ body: "Ready" }),
    });
    expect(calls).toEqual([`find ${HEAD}`, `create ${HEAD}`, "comment 7"]);
    expect(receipts[0]?.actor).toMatchObject({
      principal: { kind: "api_key", id: "agent-key-1" },
      agent_id: AGENT,
    });
  });

  test("a submitter cannot open or comment for a request that is not pushed, where an approver may comment", async () => {
    const opening = harness({ authorization: policy, state: "pushing" });
    expect(
      (
        await refusal(
          opening.service.open(submitter, SESSION, PUSH, {
            readBody: async () => ({}),
          }),
        )
      ).code,
    ).toBe("PUSH_NOT_PUSHED");
    expect(opening.calls).toEqual([]);

    const commenting = harness({ authorization: policy, state: "pushing" });
    commenting.saved.push(pulled);
    expect(
      await refusal(
        commenting.service.comment(submitter, SESSION, PUSH, {
          readBody: async () => ({ body: "Not yet" }),
        }),
      ),
    ).toMatchObject({
      code: "PUSH_NOT_PUSHED",
      details: { refusal: "not_pushed" },
    });
    expect(commenting.calls).toEqual([]);

    const approving = harness({ state: "pushing" });
    approving.saved.push(pulled);
    await approving.service.comment(actor, SESSION, PUSH, {
      readBody: async () => ({ body: "Approver note" }),
    });
    expect(approving.calls).toEqual(["comment 7"]);
  });

  test("an agent key on another agent's session is FORBIDDEN before GitHub is asked", async () => {
    const other = createAuthorizationPolicy({
      identity: {
        reread: async ({ principal }) => ({
          status: "ok",
          principal,
          keyAgentId: "019a0000-0000-7000-8000-0000000000c2",
        }),
      },
      agents: {
        agentOf: async () => AGENT,
        isAdmin: async () => false,
      },
    });
    const { service, calls } = harness({ authorization: other });
    expect(
      (
        await refusal(
          service.open(submitter, SESSION, PUSH, {
            readBody: async () => ({}),
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(calls).toEqual([]);
  });
});
