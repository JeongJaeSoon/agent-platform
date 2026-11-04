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
  type SessionAccess,
} from "../musterrolle/policy.ts";
import { ForgeCredentialError, type ForgePullRequest } from "../ports/forge.ts";
import {
  type GitHubApi,
  GitHubCallError,
  type GitHubGate,
  GitHubGateError,
  type GitHubWork,
} from "../ports/github-gate.ts";
import type {
  PullRequestReceipt,
  PullRequestSource,
  PullRequestStore,
} from "../ports/pull-requests.ts";
import type { SessionAttributionRecord } from "../ports/session-attribution.ts";
import { repositoryBinding, type SessionCatalog } from "./catalog.ts";
import {
  PULL_REQUEST_TAIL_END_MARKER,
  PULL_REQUEST_TAIL_MARKER,
} from "./git-attribution.ts";
import {
  commentMarker,
  createPullRequestService,
} from "./pull-request-service.ts";
import { SessionServiceError } from "./session-service.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const PUSH = "22222222-2222-4222-8222-222222222222";
const HEAD = `agent/${SESSION}`;
// No session here was started by the calling key.
const UNTRACED_SESSIONS: SessionAccess = {
  visibleTo: async () => true,
  originOf: async () => null,
};
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
const LINKED: SessionAttributionRecord = {
  ownerId: "owner-a",
  trigger: "web",
  agentId: "agent-1",
  agentReleaseId: "release-1",
  starter: { userId: "user-1", github: { id: "583231", login: "octocat" } },
  authorApp: null,
  authorPinned: false,
};
const TAIL = [
  "---",
  PULL_REQUEST_TAIL_MARKER,
  `Opened in a Werft session · [session](<https://console.example.com/sessions/${SESSION}>) · commit \`aaaaaaa\``,
  "",
  "<details><summary>Details</summary>",
  "",
  `- Session: \`${SESSION}\``,
  "- Agent: `agent-1`, release `release-1`",
  `- Push request: \`${PUSH}\``,
  "- Trigger: web",
  "- Started by: GitHub account linked (octocat)",
  "</details>",
  "",
  "Co-authored-by: octocat <583231+octocat@users.noreply.github.com>",
  PULL_REQUEST_TAIL_END_MARKER,
].join("\n");
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
    attribution?: SessionAttributionRecord | null;
    failUpdate?: boolean;
    /** Someone opened #9 for the head between the find and the create. */
    raced?: boolean;
  } = {},
) {
  const attribution =
    options.attribution === undefined ? LINKED : options.attribution;
  const bodies = new Map<number, string>();
  const titles = new Map<number, string>();
  const warnings: string[] = [];
  const receipts: PullRequestReceipt[] = [];
  const dueAgain: string[] = [];
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
    findBranchPullRequest: async (_owner, session, repositoryId, head) =>
      [...saved]
        .reverse()
        .find(
          (entry) =>
            entry.session_id === session &&
            entry.repository_id === repositoryId &&
            entry.head === head,
        ) ?? null,
    recordReceipt: async (input) => {
      receipts.push(input);
      return `receipt-${receipts.length}`;
    },
    recordStateChange: async ({ url, ...input }) => {
      receipts.push(input);
      dueAgain.push(url);
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
  let readStatus: number | null = null;
  let patchAnswer: ForgePullRequest["state"] | null = null;
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
    submitReview: unused,
    findPullRequestForBranch: async (branch) => {
      calls.push(`find ${branch}`);
      fail();
      return open;
    },
    createPullRequest: async (input) => {
      calls.push(`create ${input.head}`);
      fail();
      if (options.raced) {
        return {
          number: 9,
          url: "https://github.com/acme/app/pull/9",
          state: "open",
          head: input.head,
          base: input.base,
          mergedAt: null,
          closedAt: null,
          created: false,
        };
      }
      created.push(input);
      bodies.set(7, input.body);
      open = {
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        state: "open",
        head: input.head,
        base: input.base,
        mergedAt: null,
        closedAt: null,
      };
      return { ...open, created: true };
    },
    getPullRequest: async (number) => {
      calls.push(`read ${number}`);
      if (readStatus !== null) {
        throw new GitHubCallError("pull request read", readStatus, null);
      }
      if (open?.number !== number) {
        throw new GitHubCallError("pull request read", 404, null);
      }
      return {
        pullRequest: {
          ...open,
          title: "t",
          mergeCommitSha: null,
          additions: null,
          deletions: null,
          changedFiles: null,
          commits: null,
        },
        rateLimit: {
          limit: null,
          remaining: null,
          reset: null,
          retryAfterSeconds: null,
        },
      };
    },
    setPullRequestState: async (number, state) => {
      calls.push(`state ${number} ${state}`);
      fail();
      if (open === null || open.number !== number) {
        throw new ForgeCredentialError("GitHub call failed (404)");
      }
      const now = patchAnswer ?? state;
      open = {
        ...open,
        state: now,
        closedAt: now === "closed" ? "2026-11-04T00:00:00Z" : null,
      };
      return open;
    },
    updatePullRequestBody: async (number, edit, title) => {
      calls.push(`update ${number}`);
      fail();
      if (options.failUpdate) {
        throw new ForgeCredentialError("GitHub call failed (502)");
      }
      bodies.set(number, edit(bodies.get(number) ?? ""));
      if (title !== undefined) titles.set(number, title);
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
        unit: async () => "app:test:1",
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
    authorization:
      options.authorization ??
      createAuthorizationPolicy({ sessions: UNTRACED_SESSIONS }),
    store,
    catalog: CATALOG,
    gate,
    redact: (line) => (line.includes("ghp_") ? "[REDACTED]" : line),
    attribution: { attribution: async () => attribution },
    consoleOrigin: "https://console.example.com",
    logger: { warn: (message) => warnings.push(message) },
  });
  return {
    service,
    bodies,
    titles,
    warnings,
    receipts,
    sourceReads,
    saved,
    calls,
    works,
    created,
    comments,
    setOpen: (pull: Omit<ForgePullRequest, "mergedAt" | "closedAt">) => {
      open = { ...pull, mergedAt: null, closedAt: null };
    },
    dueAgain,
    forgePullRequest: () => open,
    /** GitHub answers every state change with this state. */
    answerState: (state: ForgePullRequest["state"]) => {
      patchAnswer = state;
    },
    merge: () => {
      if (open !== null) {
        open = { ...open, state: "closed", mergedAt: "2026-11-04T00:00:00Z" };
      }
    },
    failRead: (status: number | null) => {
      readStatus = status;
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
        body: `C${ZWSP}loses #3\n[REDACTED]\nsee acme/other#${ZWSP}4\n\n${TAIL}`,
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
        sessions: UNTRACED_SESSIONS,
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
    expect(calls).toEqual([`find ${HEAD}`, "update 3"]);
  });

  test("a pull request the forge did not create is saved as not created on both paths: found open, and GitHub's 422", async () => {
    const savedAs = (receipts: PullRequestReceipt[]) =>
      receipts
        .filter((receipt) => receipt.operation === "open_pull_request")
        .map((receipt) => (receipt as unknown as { created: boolean }).created);

    const found = harness();
    found.setOpen({
      number: 3,
      url: "https://github.com/acme/app/pull/3",
      state: "open",
      head: HEAD,
      base: "develop",
    });
    await found.service.open(actor, SESSION, PUSH, {
      readBody: async () => ({}),
    });
    expect(savedAs(found.receipts)).toEqual([false]);

    const raced = harness({ raced: true });
    const opened = await raced.service.open(actor, SESSION, PUSH, {
      readBody: async () => ({}),
    });
    expect(opened).toMatchObject({
      created: false,
      pull_request: { number: 9 },
    });
    expect(savedAs(raced.receipts)).toEqual([false]);
    // The one GitHub answered is someone's open pull request: its tail is
    // replaced as for one found open.
    expect(raced.calls).toEqual([`find ${HEAD}`, `create ${HEAD}`, "update 9"]);

    const fresh = harness();
    await fresh.service.open(actor, SESSION, PUSH, {
      readBody: async () => ({}),
    });
    expect(savedAs(fresh.receipts)).toEqual([true]);
  });

  test("a reused pull request gets its tail replaced, the text above it kept", async () => {
    const { service, setOpen, bodies } = harness();
    setOpen({
      number: 3,
      url: "https://github.com/acme/app/pull/3",
      state: "open",
      head: HEAD,
      base: "develop",
    });
    const old = TAIL.replace("a".repeat(40), "b".repeat(40)).replace(
      PUSH,
      "33333333-3333-4333-8333-333333333333",
    );
    bodies.set(3, `Edited by a person\r\n\r\n${old.replaceAll("\n", "\r\n")}`);
    await service.open(actor, SESSION, PUSH, { readBody: async () => ({}) });
    expect(bodies.get(3)).toBe(`Edited by a person\n\n${TAIL}`);
  });

  test("a tail GitHub refuses to update is logged; the pull request is still recorded", async () => {
    const { service, setOpen, warnings, saved } = harness({ failUpdate: true });
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
    expect(warnings).toEqual(["Pull request tail not updated"]);
    expect(saved.map((entry) => entry.number)).toEqual([3]);
  });

  test("a body without the marker keeps all it has and gets the tail added", async () => {
    const { service, setOpen, bodies } = harness();
    setOpen({
      number: 3,
      url: "https://github.com/acme/app/pull/3",
      state: "open",
      head: HEAD,
      base: "develop",
    });
    bodies.set(3, "Opened by hand");
    await service.open(actor, SESSION, PUSH, { readBody: async () => ({}) });
    expect(bodies.get(3)).toBe(`Opened by hand\n\n${TAIL}`);
  });

  test("an agent-key session's tail names no one and carries no Co-authored-by", async () => {
    const { service, created } = harness({
      attribution: { ...LINKED, trigger: "agent_key", starter: null },
    });
    await service.open(actor, SESSION, PUSH, { readBody: async () => ({}) });
    const body = created[0]?.body ?? "";
    expect(body).toContain("- Trigger: agent_key");
    expect(body).toContain("- Started by: none (App only)");
    expect(body).not.toContain("Co-authored-by");
  });

  test("a starter without a GitHub link is named unlinked, with no Co-authored-by", async () => {
    const { service, created } = harness({
      attribution: {
        ...LINKED,
        starter: { userId: "user-1", github: null },
      },
    });
    await service.open(actor, SESSION, PUSH, { readBody: async () => ({}) });
    const body = created[0]?.body ?? "";
    expect(body).toContain(
      "- Started by: GitHub account not linked (App only)",
    );
    expect(body).not.toContain("Co-authored-by");
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
        // The model tells a push waiting for a person from one still running
        // by this state.
        details: {
          refusal: "not_pushed",
          receipt_id: "receipt-1",
          push_request_state: state,
        },
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
        repositoryId: "app",
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

describe("updating the pull request", () => {
  test("needs the pull request first, and asks GitHub nothing", async () => {
    const { service, calls, receipts } = harness();
    expect(
      (
        await refusal(
          service.update(actor, SESSION, PUSH, {
            readBody: async () => ({ title: "New" }),
          }),
        )
      ).code,
    ).toBe("PULL_REQUEST_MISSING");
    expect(calls).toEqual([]);
    expect(receipts.at(-1)).toMatchObject({
      operation: "update_pull_request",
      result: { verdict: "refuse", refusal: "no_pull_request" },
    });
  });

  test("replaces the title and the person's text, keeping the platform's tail", async () => {
    const { service, bodies, titles, receipts } = harness();
    await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({ title: "First", body: "Draft" }),
    });
    const opened = bodies.get(7) ?? "";
    expect(opened.startsWith("Draft\n\n")).toBe(true);
    const tail = opened.slice("Draft\n\n".length);
    const updated = await service.update(actor, SESSION, PUSH, {
      readBody: async () => ({
        title: "Final, @team",
        body: "What changed, with ghp_x",
      }),
    });
    expect(updated.pull_request.number).toBe(7);
    expect(titles.get(7)).toBe(`Final, @${ZWSP}team`);
    expect(bodies.get(7)).toBe(`[REDACTED]\n\n${tail}`);
    expect(receipts.at(-1)).toMatchObject({
      operation: "update_pull_request",
      result: { verdict: "allow", number: 7, created: false },
    });
  });

  test("the recorded pull request closed, or another open on the branch, is refused before an edit", async () => {
    for (const open of [
      { number: 7, state: "closed" as const },
      { number: 8, state: "open" as const },
    ]) {
      const h = harness();
      await h.service.open(actor, SESSION, PUSH, {
        readBody: async () => ({ body: "Draft" }),
      });
      h.setOpen({
        ...open,
        url: `https://github.com/acme/app/pull/${open.number}`,
        head: HEAD,
        base: "develop",
      });
      const calls = h.calls.length;
      expect(
        (
          await refusal(
            h.service.update(actor, SESSION, PUSH, {
              readBody: async () => ({ title: "Late" }),
            }),
          )
        ).details,
      ).toMatchObject({ refusal: "no_pull_request" });
      expect(h.calls.slice(calls)).toEqual([`find ${HEAD}`]);
      expect(h.titles.size).toBe(0);
    }
  });

  test("a title alone leaves the body as GitHub has it", async () => {
    const { service, bodies, titles } = harness();
    await service.open(actor, SESSION, PUSH, {
      readBody: async () => ({ body: "Kept" }),
    });
    const before = bodies.get(7);
    await service.update(actor, SESSION, PUSH, {
      readBody: async () => ({ title: "Renamed" }),
    });
    expect(bodies.get(7)).toBe(before);
    expect(titles.get(7)).toBe("Renamed");
  });
});

describe("closing and reopening the pull request", () => {
  const OTHER_SESSION = "33333333-3333-4333-8333-333333333333";
  const OTHER_PUSH = "44444444-4444-4444-8444-444444444444";
  const recorded: PullRequest = {
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
  const withPullRequest = (options: Parameters<typeof harness>[0] = {}) => {
    const h = harness(options);
    h.saved.push(recorded);
    h.setOpen({ ...recorded, state: "open" });
    return h;
  };

  test("closes, then reopens, the pull request this session's push request has, each with a receipt", async () => {
    const h = withPullRequest();
    expect(await h.service.setState(actor, SESSION, PUSH, "closed")).toEqual({
      pull_request: recorded,
      state: "closed",
      changed: true,
      receipt_id: "receipt-1",
    });
    expect(h.forgePullRequest()?.state).toBe("closed");
    expect(await h.service.setState(actor, SESSION, PUSH, "open")).toEqual({
      pull_request: recorded,
      state: "open",
      changed: true,
      receipt_id: "receipt-2",
    });
    expect(h.forgePullRequest()?.state).toBe("open");
    expect(h.calls).toEqual([
      "read 7",
      "state 7 closed",
      "read 7",
      "state 7 open",
    ]);
    expect(h.receipts).toEqual([
      expect.objectContaining({
        operation: "close_pull_request",
        pushRequestId: PUSH,
        result: expect.objectContaining({
          verdict: "allow",
          refusal: null,
          push_request_id: PUSH,
          repository_id: "app",
          number: 7,
          url: recorded.url,
          head: HEAD,
          state: "closed",
          changed: true,
        }),
      }),
      expect.objectContaining({
        operation: "reopen_pull_request",
        result: expect.objectContaining({
          verdict: "allow",
          state: "open",
          changed: true,
        }),
      }),
    ]);
    expect(h.works.map((work) => work.purpose)).toEqual([
      "pull_request",
      "pull_request",
    ]);
    // Each change makes the outcome due again, however long it was closed.
    expect(h.dueAgain).toEqual([recorded.url, recorded.url]);
  });

  test("the state and changed come from GitHub's answer, not from the request", async () => {
    const h = withPullRequest();
    h.answerState("open");
    expect(
      await h.service.setState(actor, SESSION, PUSH, "closed"),
    ).toMatchObject({ state: "open", changed: false });
    expect(h.calls).toEqual(["read 7", "state 7 closed"]);
    expect(h.receipts.at(-1)?.result).toMatchObject({
      verdict: "allow",
      state: "open",
      changed: false,
    });
    expect(h.dueAgain).toEqual([]);
  });

  test("a pull request already in that state is answered unchanged, with a receipt and no write", async () => {
    const h = withPullRequest();
    expect(
      await h.service.setState(actor, SESSION, PUSH, "open"),
    ).toMatchObject({ state: "open", changed: false });
    await h.service.setState(actor, SESSION, PUSH, "closed");
    expect(
      await h.service.setState(actor, SESSION, PUSH, "closed"),
    ).toMatchObject({ state: "closed", changed: false });
    expect(h.calls).toEqual(["read 7", "read 7", "state 7 closed", "read 7"]);
    expect(h.dueAgain).toEqual([recorded.url]);
    expect(h.receipts.map((receipt) => receipt.result)).toEqual([
      expect.objectContaining({
        verdict: "allow",
        state: "open",
        changed: false,
      }),
      expect.objectContaining({
        verdict: "allow",
        state: "closed",
        changed: true,
      }),
      expect.objectContaining({
        verdict: "allow",
        state: "closed",
        changed: false,
      }),
    ]);
  });

  test("another session's push request, or one this session does not have, is NOT_FOUND before GitHub is asked", async () => {
    for (const [session, push] of [
      [OTHER_SESSION, PUSH],
      [SESSION, OTHER_PUSH],
    ] as const) {
      const h = withPullRequest();
      expect(
        await refusal(h.service.setState(actor, session, push, "closed")),
      ).toMatchObject({ code: "NOT_FOUND", details: { refusal: "not_found" } });
      expect(h.calls).toEqual([]);
      expect(h.works).toEqual([]);
      expect(h.receipts).toEqual([
        expect.objectContaining({
          operation: "close_pull_request",
          sessionId: session,
          result: expect.objectContaining({
            verdict: "refuse",
            refusal: "not_found",
          }),
        }),
      ]);
    }
  });

  test("a repository the catalog or the release no longer allows is refused before GitHub is asked", async () => {
    const moved = withPullRequest({ binding: "moved" });
    expect(
      await refusal(moved.service.setState(actor, SESSION, PUSH, "closed")),
    ).toMatchObject({
      code: "CATALOG_MISMATCH",
      details: { refusal: "catalog_changed" },
    });
    expect(moved.calls).toEqual([]);

    const refused = withPullRequest({ gateRefusal: "repository_not_allowed" });
    expect(
      await refusal(refused.service.setState(actor, SESSION, PUSH, "open")),
    ).toMatchObject({
      code: "GITHUB_REFUSED",
      details: {
        refusal: "github_refused",
        reason_code: "repository_not_allowed",
      },
    });
    expect(refused.calls).toEqual([]);
    expect(refused.receipts.at(-1)).toMatchObject({
      operation: "reopen_pull_request",
      result: {
        verdict: "refuse",
        refusal: "github_refused",
        reason_code: "repository_not_allowed",
        number: 7,
      },
    });
  });

  test("needs the pull request first", async () => {
    const h = harness();
    expect(
      await refusal(h.service.setState(actor, SESSION, PUSH, "closed")),
    ).toMatchObject({
      code: "PULL_REQUEST_MISSING",
      details: { refusal: "no_pull_request" },
    });
    expect(h.calls).toEqual([]);
  });

  test("a merged pull request is PULL_REQUEST_MERGED either way, and nothing is written", async () => {
    for (const state of ["closed", "open"] as const) {
      const h = withPullRequest();
      h.merge();
      expect(
        await refusal(h.service.setState(actor, SESSION, PUSH, state)),
      ).toMatchObject({
        code: "PULL_REQUEST_MERGED",
        details: { refusal: "pull_request_merged" },
      });
      expect(h.calls).toEqual(["read 7"]);
      expect(h.receipts.at(-1)?.result).toMatchObject({
        verdict: "refuse",
        refusal: "pull_request_merged",
        state: "closed",
      });
    }
  });

  test("GitHub's pull request on another head, or none at that number, is no_pull_request", async () => {
    const moved = withPullRequest();
    moved.setOpen({ ...recorded, head: "feature", state: "open" });
    expect(
      (await refusal(moved.service.setState(actor, SESSION, PUSH, "closed")))
        .details,
    ).toMatchObject({ refusal: "no_pull_request" });

    const gone = withPullRequest();
    gone.failRead(404);
    expect(
      (await refusal(gone.service.setState(actor, SESSION, PUSH, "closed")))
        .details,
    ).toMatchObject({ refusal: "no_pull_request" });
    expect([...moved.calls, ...gone.calls]).toEqual(["read 7", "read 7"]);
  });

  test("a read or a write GitHub fails is forge_failed with a receipt", async () => {
    const reading = withPullRequest();
    reading.failRead(502);
    expect(
      await refusal(reading.service.setState(actor, SESSION, PUSH, "closed")),
    ).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      details: { refusal: "forge_failed" },
    });

    const writing = withPullRequest();
    writing.failForge();
    expect(
      await refusal(writing.service.setState(actor, SESSION, PUSH, "closed")),
    ).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      details: { refusal: "forge_failed" },
    });
    expect(writing.receipts.at(-1)?.result).toMatchObject({
      verdict: "refuse",
      refusal: "forge_failed",
      state: "open",
    });
    expect(writing.forgePullRequest()?.state).toBe("open");
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
    sessions: UNTRACED_SESSIONS,
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

  test("an agent key updates the pull request of a pushed request only", async () => {
    const pushed = harness({ authorization: policy });
    pushed.saved.push(pulled);
    pushed.setOpen({ ...pulled, state: "open" });
    await pushed.service.update(submitter, SESSION, PUSH, {
      readBody: async () => ({ title: "Ready" }),
    });
    expect(pushed.titles.get(7)).toBe("Ready");

    const pushing = harness({ authorization: policy, state: "pushing" });
    pushing.saved.push(pulled);
    expect(
      await refusal(
        pushing.service.update(submitter, SESSION, PUSH, {
          readBody: async () => ({ title: "Not yet" }),
        }),
      ),
    ).toMatchObject({
      code: "PUSH_NOT_PUSHED",
      details: { refusal: "not_pushed", push_request_state: "pushing" },
    });
    expect(pushing.calls).toEqual([]);
  });

  test("an agent key closes and reopens the pull request of a pushed request only, and not on another agent's session", async () => {
    const pushed = harness({ authorization: policy });
    pushed.saved.push(pulled);
    pushed.setOpen({ ...pulled, state: "open" });
    await pushed.service.setState(submitter, SESSION, PUSH, "closed");
    await pushed.service.setState(submitter, SESSION, PUSH, "open");
    expect(pushed.calls).toEqual([
      "read 7",
      "state 7 closed",
      "read 7",
      "state 7 open",
    ]);
    expect(pushed.receipts[0]?.actor).toMatchObject({
      principal: { kind: "api_key", id: "agent-key-1" },
      agent_id: AGENT,
    });

    const pushing = harness({ authorization: policy, state: "pushing" });
    pushing.saved.push(pulled);
    expect(
      await refusal(
        pushing.service.setState(submitter, SESSION, PUSH, "closed"),
      ),
    ).toMatchObject({
      code: "PUSH_NOT_PUSHED",
      details: { refusal: "not_pushed", push_request_state: "pushing" },
    });
    expect(pushing.calls).toEqual([]);

    const otherAgent = createAuthorizationPolicy({
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
    const foreign = harness({ authorization: otherAgent });
    foreign.saved.push(pulled);
    foreign.setOpen({ ...pulled, state: "open" });
    expect(
      (
        await refusal(
          foreign.service.setState(submitter, SESSION, PUSH, "closed"),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(foreign.calls).toEqual([]);
    expect(foreign.forgePullRequest()?.state).toBe("open");
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
      details: { refusal: "not_pushed", push_request_state: "pushing" },
    });
    expect(commenting.calls).toEqual([]);

    const approving = harness({ state: "pushing" });
    approving.saved.push(pulled);
    await approving.service.comment(actor, SESSION, PUSH, {
      readBody: async () => ({ body: "Approver note" }),
    });
    expect(approving.calls).toEqual(["comment 7"]);
  });

  test("a caller with sessions:approve whose share only lets it submit opens as a submitter", async () => {
    const asked: string[] = [];
    const allowing =
      (allowed: readonly string[]): AuthorizationPolicy["authorize"] =>
      async ({ action }) => {
        asked.push(action);
        return {
          outcome: allowed.includes(action) ? "allow" : "deny",
          reason_code: allowed.includes(action) ? "ok" : "role",
          effective_scopes: [],
          policy_version: "test",
          decision_id: crypto.randomUUID(),
        };
      };
    const submitOnly: AuthorizationPolicy = {
      authorize: allowing(["session.submit"]),
    };
    const pushed = harness({ authorization: submitOnly });
    expect(
      await pushed.service.open(actor, SESSION, PUSH, {
        readBody: async () => ({}),
      }),
    ).toMatchObject({ created: true });
    expect(asked).toEqual(["session.approve", "session.submit"]);

    const pushing = harness({ authorization: submitOnly, state: "pushing" });
    expect(
      (
        await refusal(
          pushing.service.open(actor, SESSION, PUSH, {
            readBody: async () => ({}),
          }),
        )
      ).code,
    ).toBe("PUSH_NOT_PUSHED");
    expect(pushing.calls).toEqual([]);

    const neither = harness({ authorization: { authorize: allowing([]) } });
    expect(
      (
        await refusal(
          neither.service.open(actor, SESSION, PUSH, {
            readBody: async () => ({}),
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(neither.calls).toEqual([]);
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
