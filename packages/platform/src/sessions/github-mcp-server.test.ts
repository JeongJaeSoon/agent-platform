import { describe, expect, test } from "bun:test";
import {
  type AgentGitHub,
  GITHUB_MCP_FIXED_TOOLS,
  type PushRequestState,
  type ReceiptActor,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit";
import {
  type AuthorizationPolicy,
  createAuthorizationPolicy,
} from "../musterrolle/policy.ts";
import {
  type GitHubApi,
  type GitHubGate,
  GitHubGateError,
  type GitHubWork,
} from "../ports/github-gate.ts";
import type { GitHubMcpSessionState } from "../ports/github-mcp.ts";
import { PULL_REQUEST_REFUSAL_ERRORS } from "../ports/pull-requests.ts";
import { PUSH_REFUSAL_ERRORS } from "../ports/push-requests.ts";
import {
  attachCatalog,
  attachmentContext,
  memoryAttachmentStore,
} from "../testing/repository-attachment-fakes.ts";
import {
  createGitHubMcpServer,
  type GitHubMcpServices,
  sessionBoundAuthorization,
  signGitHubMcpGrant,
  verifyGitHubMcpGrant,
} from "./github-mcp-server.ts";
import {
  createGitHubWorkService,
  type GitHubWorkStore,
} from "./github-work-service.ts";
import type { PushActor } from "./push-request-service.ts";
import { createRepositoryAttachmentService } from "./repository-attachment-service.ts";
import { SessionServiceError } from "./session-service.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const KEY = new Uint8Array(32).fill(7);
const grant = { sessionId: SESSION, attemptId: "att_1" };

const creator: ReceiptActor = {
  principal: { kind: "user", id: "33333333-3333-4333-8333-333333333333" },
  actor_user_id: "33333333-3333-4333-8333-333333333333",
  agent_id: "44444444-4444-4444-8444-444444444444",
};

function github(features: Partial<AgentGitHub["features"]> = {}): AgentGitHub {
  return {
    repositories: ["app"],
    push_approval: true,
    features: {
      workflows: false,
      actions: false,
      checks: false,
      issues: false,
      review: false,
      ...features,
    },
    actions_allow: [],
  };
}

function unused(): never {
  throw new Error("not used");
}

function harness(state: Partial<GitHubMcpSessionState> = {}) {
  const works: GitHubWork[] = [];
  const dispatches: Parameters<GitHubWorkStore["recordDispatch"]>[0][] = [];
  const pushes: Array<{ actor: PushActor; sessionId: string }> = [];
  const opened: Array<{
    sessionId: string;
    pushRequestId: string;
    body: unknown;
  }> = [];
  const states: Array<{
    sessionId: string;
    pushRequestId: string;
    state: string;
  }> = [];
  const policies: AuthorizationPolicy[] = [];
  const control: {
    pushRefusal: "no_checkpoint" | "request_open" | null;
    notPushed: PushRequestState | null;
    runningTurn: number | null;
    marks: Array<{ sessionId: string; turnId: number }>;
    marked: boolean;
  } = {
    pushRefusal: null,
    notPushed: null,
    runningTurn: 7,
    marks: [],
    marked: true,
  };
  const api: GitHubApi = {
    maxBodyLength: 65_536,
    getRepository: unused,
    findPullRequestForBranch: unused,
    createPullRequest: unused,
    getPullRequest: unused,
    updatePullRequestBody: unused,
    setPullRequestState: unused,
    upsertComment: unused,
    dispatchWorkflow: async () => ({
      id: 42,
      html_url: "https://github.com/acme/app/actions/runs/42",
    }),
    getWorkflowRun: unused,
    rerunWorkflow: unused,
    submitReview: unused,
  };
  const gate: GitHubGate = {
    grant: async (work) => {
      works.push(work);
      return {
        role: "author",
        repo: { owner: "acme", name: "app" },
        permissions: { actions: "write" },
        gitCredential: { username: "x", password: "y" },
        api,
        unit: async () => "app:test:1",
        allowedBy: { workflow: "ci.yml" },
        context: {
          ownerId: "owner-a",
          sessionId: work.sessionId,
          agentId: creator.agent_id,
          agentReleaseId: "release-1",
          repositoryId: "app",
          policy: {},
        },
      };
    },
  };
  const workStore: GitHubWorkStore = {
    recordReceipt: async () => "receipt-1",
    recordDispatch: async (input) => {
      dispatches.push(input);
      return "receipt-dispatch";
    },
    recordReview: async () => "receipt-review",
    pullRequestOpener: async () => null,
  };
  const attachmentStore = memoryAttachmentStore();
  const attachContext = attachmentContext();
  const services = (authorization: AuthorizationPolicy): GitHubMcpServices => {
    policies.push(authorization);
    return {
      pushRequests: {
        create: async (actor, sessionId) => {
          pushes.push({ actor, sessionId });
          if (control.pushRefusal !== null) {
            // The turn ends and the next one starts while the refusal is
            // on its way back.
            if (control.runningTurn !== null) control.runningTurn += 1;
            const { code, message } = PUSH_REFUSAL_ERRORS[control.pushRefusal];
            throw new SessionServiceError(code, message, undefined, {
              refusal: control.pushRefusal,
              receipt_id: "receipt-push",
            });
          }
          return { id: "push-1", status: "requested" } as never;
        },
      },
      pullRequests: {
        open: async (_actor, sessionId, pushRequestId, input) => {
          opened.push({
            sessionId,
            pushRequestId,
            body: await input.readBody(),
          });
          if (control.notPushed !== null) {
            const { code, message } = PULL_REQUEST_REFUSAL_ERRORS.not_pushed;
            throw new SessionServiceError(code, message, undefined, {
              refusal: "not_pushed",
              receipt_id: "receipt-pr",
              push_request_state: control.notPushed,
            });
          }
          return { created: true } as never;
        },
        update: unused,
        comment: unused,
        setState: async (_actor, sessionId, pushRequestId, state) => {
          states.push({ sessionId, pushRequestId, state });
          return { state, changed: true } as never;
        },
      },
      githubWork: createGitHubWorkService({
        authorization,
        gate,
        store: workStore,
      }),
      attachments: createRepositoryAttachmentService({
        store: attachmentStore,
        context: { context: async () => attachContext },
        catalog: attachCatalog,
        waitMs: 0,
      }),
    };
  };
  const handle = createGitHubMcpServer({
    store: {
      sessionState: async () => ({
        ownerId: "owner-a",
        agentId: creator.agent_id ?? "",
        releaseId: "release-1",
        source: "release",
        github: github(),
        enabled: true,
        actor: creator,
        ...state,
      }),
      runningTurn: async () => control.runningTurn,
      markPushContinuation: async (input) => {
        control.marks.push(input);
        return control.marked;
      },
    },
    services,
  });
  const call = (name: string, args: unknown) =>
    handle(
      grant,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
      "req-1",
    );
  return {
    handle,
    call,
    works,
    dispatches,
    pushes,
    opened,
    states,
    policies,
    gate,
    workStore,
    attachmentStore,
    control,
  };
}

function toolNames(answer: unknown): string[] {
  return (
    answer as { result: { tools: Array<{ name: string }> } }
  ).result.tools.map((tool) => tool.name);
}

function payload(answer: unknown): { isError?: boolean; body: unknown } {
  const result = (
    answer as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    }
  ).result;
  return {
    ...(result.isError ? { isError: true } : {}),
    body: JSON.parse(result.content[0]?.text ?? "null"),
  };
}

describe("the grant", () => {
  test("names the session and attempt it was signed for, until it expires", () => {
    const bearer = signGitHubMcpGrant(KEY, grant, 1_000);
    expect(verifyGitHubMcpGrant(KEY, bearer, 1_000)).toEqual(grant);
    expect(verifyGitHubMcpGrant(KEY, bearer, 61_000)).toBeNull();
    expect(
      verifyGitHubMcpGrant(new Uint8Array(32).fill(8), bearer, 1_000),
    ).toBeNull();
  });

  test("a payload naming another session does not verify", () => {
    const bearer = signGitHubMcpGrant(KEY, grant, 1_000);
    const [version, , mac] = bearer.split(".");
    const forged = Buffer.from(
      JSON.stringify({ session_id: OTHER, attempt_id: "att_1", exp: 61_000 }),
    ).toString("base64url");
    expect(
      verifyGitHubMcpGrant(KEY, `${version}.${forged}.${mac}`, 1_000),
    ).toBeNull();
  });
});

describe("tools/list", () => {
  const list = (features: Partial<AgentGitHub["features"]>) =>
    harness({ github: github(features) }).handle(
      grant,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "req-1",
    );

  test("lists only the default work when no feature is on", async () => {
    expect(toolNames(await list({}))).toEqual([
      "request_push",
      "open_pull_request",
      "update_pull_request",
      "comment_pull_request",
      "close_pull_request",
      "reopen_pull_request",
      "list_repositories",
      "attach_repository",
    ]);
  });

  test("a turned-off feature's tools are not listed", async () => {
    expect(toolNames(await list({ actions: true }))).toEqual([
      "request_push",
      "open_pull_request",
      "update_pull_request",
      "comment_pull_request",
      "close_pull_request",
      "reopen_pull_request",
      "dispatch_workflow",
      "get_workflow_run",
      "rerun_workflow",
      "list_repositories",
      "attach_repository",
    ]);
    expect(toolNames(await list({ review: true }))).toContain("submit_review");
    expect(toolNames(await list({ review: true }))).not.toContain(
      "dispatch_workflow",
    );
  });

  test("no argument schema takes a session id", async () => {
    const answer = (await list({ actions: true, review: true })) as {
      result: { tools: Array<{ inputSchema: { properties?: object } }> };
    };
    for (const tool of answer.result.tools) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain(
        "session_id",
      );
    }
  });

  test("a switched-off agent or a session without GitHub gets no tools", async () => {
    for (const state of [
      { enabled: false },
      { github: null },
      { actor: null },
    ]) {
      const answer = await harness(state).handle(
        grant,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        "req-1",
      );
      expect(answer).toMatchObject({ error: { code: -32001 } });
    }
  });
});

describe("a session under the agent's settings", () => {
  const under = (state: Partial<GitHubMcpSessionState> = {}) =>
    harness({ source: "agent", github: github(), ...state });

  test("lists the whole fixed surface, whatever the features say", async () => {
    const answer = await under().handle(
      grant,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "req-1",
    );
    expect(toolNames(answer)).toEqual([...GITHUB_MCP_FIXED_TOOLS]);
  });

  test("the list stays with the agent's switch off; each call is refused", async () => {
    const h = under({ enabled: false });
    const answer = await h.handle(
      grant,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "req-1",
    );
    expect(toolNames(answer)).toEqual([...GITHUB_MCP_FIXED_TOOLS]);
    expect(payload(await h.call("request_push", {}))).toMatchObject({
      isError: true,
      body: {
        code: "GITHUB_REFUSED",
        details: { reason_code: "github_disabled" },
      },
    });
    expect(h.pushes).toEqual([]);
  });

  test("a tool of a feature off is refused in the turn, not hidden", async () => {
    const h = under();
    expect(
      payload(
        await h.call("dispatch_workflow", { workflow: "ci.yml", ref: "main" }),
      ),
    ).toMatchObject({
      isError: true,
      body: {
        code: "GITHUB_REFUSED",
        details: { reason_code: "feature_off" },
      },
    });
    expect(h.works).toEqual([]);
  });

  test("a feature on reaches the gate, unlike the release's tool off", async () => {
    const on = under({ github: github({ actions: true }) });
    await on.call("dispatch_workflow", { workflow: "ci.yml", ref: "main" });
    expect(on.works).toHaveLength(1);
    const release = harness({ github: github() });
    expect(
      payload(
        await release.call("dispatch_workflow", {
          workflow: "ci.yml",
          ref: "main",
        }),
      ),
    ).toMatchObject({ isError: true, body: { code: "FORBIDDEN" } });
  });

  test("a row that cannot be read gets no tools", async () => {
    const answer = await under({ github: null }).handle(
      grant,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "req-1",
    );
    expect(answer).toMatchObject({ error: { code: -32001 } });
  });
});

describe("tools/call", () => {
  test("a session id among the arguments is refused, not followed", async () => {
    const h = harness({ github: github({ actions: true }) });
    const answer = payload(
      await h.call("dispatch_workflow", {
        workflow: "ci.yml",
        ref: "main",
        session_id: OTHER,
      }),
    );
    expect(answer).toMatchObject({
      isError: true,
      body: { code: "VALIDATION_ERROR" },
    });
    expect(h.works).toEqual([]);
  });

  test("every call acts on the grant's session", async () => {
    const h = harness({ github: github({ actions: true }) });
    await h.call("request_push", {});
    await h.call("open_pull_request", {
      push_request_id: "55555555-5555-4555-8555-555555555555",
      title: "Fix",
    });
    await h.call("dispatch_workflow", { workflow: "ci.yml", ref: "main" });
    expect(h.pushes.map((push) => push.sessionId)).toEqual([SESSION]);
    expect(h.opened).toEqual([
      {
        sessionId: SESSION,
        pushRequestId: "55555555-5555-4555-8555-555555555555",
        body: { title: "Fix" },
      },
    ]);
    expect(h.works.map((work) => work.sessionId)).toEqual([SESSION]);
  });

  test("a turned-off feature's tool is refused before any service", async () => {
    const h = harness();
    const answer = payload(
      await h.call("dispatch_workflow", { workflow: "ci.yml", ref: "main" }),
    );
    expect(answer).toMatchObject({
      isError: true,
      body: { code: "FORBIDDEN" },
    });
    expect(h.works).toEqual([]);
    expect(h.policies).toEqual([]);
  });

  test("acts as the session's creator and agent, holding no scope", async () => {
    const h = harness();
    await h.call("request_push", {});
    const [push] = h.pushes;
    expect(push?.actor.principal.scopes).toEqual([]);
    expect(push?.actor.caller.actor).toMatchObject({
      principal: creator.principal,
      userId: creator.actor_user_id,
      agentId: creator.agent_id,
    });
  });

  test("writes the receipt the session API writes", async () => {
    const h = harness({ github: github({ actions: true }) });
    await h.call("dispatch_workflow", {
      workflow: "ci.yml",
      ref: "main",
      inputs: { target: "x" },
    });
    const viaApi = createGitHubWorkService({
      authorization: createAuthorizationPolicy(),
      gate: h.gate,
      store: h.workStore,
    });
    await viaApi.dispatch(
      {
        caller: testCaller("owner-a"),
        principal: testCaller("owner-a").subject.principal as never,
        ownerId: "owner-a",
        verified: true,
      },
      SESSION,
      { workflow: "ci.yml", ref: "main", inputs: { target: "x" } },
    );
    const [mcp, api] = h.dispatches;
    expect(mcp?.result).toEqual(api?.result);
    expect(mcp?.run).toEqual(api?.run);
    expect(mcp?.actor).toEqual(creator);
    expect(h.works[0]?.actor).toEqual(creator);
  });

  test("a service refusal comes back as a tool error with its details", async () => {
    const h = harness({ github: github({ actions: true }) });
    h.gate.grant = async () => {
      throw new GitHubGateError("workflow_not_allowed", "receipt-9");
    };
    const answer = payload(
      await h.call("dispatch_workflow", { workflow: "x.yml", ref: "main" }),
    );
    expect(answer).toMatchObject({
      isError: true,
      body: {
        code: "GITHUB_REFUSED",
        details: {
          reason_code: "workflow_not_allowed",
          receipt_id: "receipt-9",
        },
      },
    });
  });
});

describe("request_push before the session's first checkpoint", () => {
  test("marks the turn the request started in and tells the model a turn follows once this one ends", async () => {
    const h = harness();
    h.control.pushRefusal = "no_checkpoint";
    const answer = payload(await h.call("request_push", {}));
    expect(h.control.marks).toEqual([
      { sessionId: grant.sessionId, turnId: 7 },
    ]);
    // A deferral, not an error: read as one, the model told the user the
    // push was rejected.
    expect(answer.isError).toBeUndefined();
    expect(answer.body).toMatchObject({
      status: "deferred",
      continuation: "after_turn",
      details: { refusal: "no_checkpoint", receipt_id: "receipt-push" },
    });
    expect(answer.body).not.toHaveProperty("code");
    const { message } = answer.body as { message: string };
    expect(message).toContain("follow-up turn");
    expect(message).toContain("not refused");
  });

  test("an unmarked turn, or any other refusal, says nothing of a follow-up", async () => {
    const h = harness();
    h.control.pushRefusal = "no_checkpoint";
    h.control.marked = false;
    const unmarked = payload(await h.call("request_push", {}));
    expect(unmarked).toMatchObject({
      isError: true,
      body: { code: "PUSH_SOURCE_MISSING" },
    });
    expect(unmarked.body).not.toHaveProperty("continuation");
    h.control.pushRefusal = "request_open";
    const open = payload(await h.call("request_push", {}));
    expect(open.body).not.toHaveProperty("continuation");
    expect(h.control.marks).toHaveLength(1);
  });

  test("a request that started in no running turn marks nothing", async () => {
    const h = harness();
    h.control.pushRefusal = "no_checkpoint";
    h.control.runningTurn = null;
    const answer = payload(await h.call("request_push", {}));
    expect(answer.body).not.toHaveProperty("continuation");
    expect(h.control.marks).toEqual([]);
  });
});

describe("open_pull_request before the push is done", () => {
  const PUSH = "55555555-5555-4555-8555-555555555555";
  const open = async (state: PushRequestState) => {
    const h = harness();
    h.control.notPushed = state;
    return payload(
      await h.call("open_pull_request", { push_request_id: PUSH }),
    ) as { isError?: boolean; body: { guidance?: string } };
  };

  test("a push waiting for a person says so and not to call again", async () => {
    const answer = await open("requested");
    expect(answer).toMatchObject({
      isError: true,
      body: {
        code: "PUSH_NOT_PUSHED",
        details: { refusal: "not_pushed", push_request_state: "requested" },
      },
    });
    const guidance = answer.body.guidance ?? "";
    expect(guidance).toContain("waiting for a person to approve it");
    expect(guidance).toContain("will not move it forward");
    expect(guidance).toContain("end your turn, and ask a person to approve");
    expect(guidance).not.toContain("wait a few seconds");
    // A push approved outside Slack starts no follow-up turn.
    expect(guidance).not.toMatch(/pull request (will )?opens?/i);
  });

  test("an approved or running push says to call again in a few seconds", async () => {
    for (const state of ["approved", "pushing"] as const) {
      const guidance = (await open(state)).body.guidance ?? "";
      expect(guidance).toContain("wait a few seconds and call this tool again");
      expect(guidance).not.toContain("waiting for a person");
    }
  });

  test("a push that will not run gets no guidance to call again", async () => {
    for (const state of ["rejected", "failed"] as const) {
      expect((await open(state)).body).not.toHaveProperty("guidance");
    }
  });
});

describe("attach_repository", () => {
  test("a repository off the release's list is refused with repository_not_allowed and a receipt", async () => {
    const h = harness();
    const answer = payload(
      await h.call("attach_repository", { repository_id: "secret" }),
    );
    expect(answer).toMatchObject({
      isError: true,
      body: {
        code: "GITHUB_REFUSED",
        details: {
          reason_code: "repository_not_allowed",
          receipt_id: "receipt-1",
        },
      },
    });
    expect(h.attachmentStore.receipts).toEqual([
      {
        id: "receipt-1",
        status: "failed",
        result: {
          session_id: SESSION,
          attempt_id: "att_1",
          agent_id: "agent-1",
          agent_release_id: "release-1",
          policy_source: "release",
          agent_settings_revision: null,
          workspace_ceiling_revision: 0,
          repository_id: "secret",
          branch: null,
          commit: null,
          failure: null,
          reason_code: "repository_not_allowed",
        },
        error: {
          code: "GITHUB_REFUSED",
          message: "GitHub work refused: repository_not_allowed",
        },
      },
    ]);
    expect(h.attachmentStore.rows.size).toBe(0);
  });

  test("one on the list is recorded for the grant's attempt as its creator", async () => {
    const h = harness();
    const answer = payload(
      await h.call("attach_repository", { repository_id: "docs" }),
    );
    expect(answer).toEqual({
      body: {
        repository_id: "docs",
        status: "pending",
        branch: "trunk",
        commit: null,
        failure: null,
        already_attached: false,
        receipt_id: "receipt-1",
      },
    });
    expect(h.attachmentStore.rows.get("docs")?.attemptId).toBe("att_1");
  });

  test("anything but a repository id is refused before the service", async () => {
    const h = harness();
    const answer = payload(
      await h.call("attach_repository", {
        repository_id: "docs",
        session_id: OTHER,
      }),
    );
    expect(answer).toMatchObject({
      isError: true,
      body: { code: "VALIDATION_ERROR" },
    });
    expect(h.attachmentStore.receipts).toEqual([]);
  });
});

describe("list_repositories", () => {
  test("answers the session's repositories, an attach in flight included, and writes nothing", async () => {
    const h = harness();
    await h.call("attach_repository", { repository_id: "docs" });
    const receipts = h.attachmentStore.receipts.length;
    expect(payload(await h.call("list_repositories", {}))).toEqual({
      body: {
        repositories: [
          { id: "app", name: "acme/app", branch: "main", status: "primary" },
          { id: "docs", name: "acme/docs", branch: "trunk", status: "pending" },
          {
            id: "tools",
            name: "acme/tools",
            branch: "main",
            status: "available",
          },
        ],
      },
    });
    expect(h.attachmentStore.receipts).toHaveLength(receipts);
    expect(
      payload(await h.call("list_repositories", { repository_id: "docs" })),
    ).toMatchObject({ isError: true, body: { code: "VALIDATION_ERROR" } });
  });
});

describe("update_pull_request", () => {
  test("needs a title or a body", async () => {
    const h = harness();
    expect(
      payload(
        await h.call("update_pull_request", {
          push_request_id: "55555555-5555-4555-8555-555555555555",
        }),
      ),
    ).toMatchObject({ isError: true, body: { code: "VALIDATION_ERROR" } });
  });
});

describe("close_pull_request and reopen_pull_request", () => {
  const PUSH = "55555555-5555-4555-8555-555555555555";

  test("close asks for closed and reopen for open, on the grant's session", async () => {
    const h = harness();
    expect(
      payload(await h.call("close_pull_request", { push_request_id: PUSH })),
    ).toEqual({ body: { state: "closed", changed: true } });
    expect(
      payload(await h.call("reopen_pull_request", { push_request_id: PUSH })),
    ).toEqual({ body: { state: "open", changed: true } });
    expect(h.states).toEqual([
      { sessionId: SESSION, pushRequestId: PUSH, state: "closed" },
      { sessionId: SESSION, pushRequestId: PUSH, state: "open" },
    ]);
  });

  test("take a push request id and nothing else", async () => {
    const h = harness();
    for (const args of [{}, { push_request_id: PUSH, number: 7 }]) {
      expect(payload(await h.call("close_pull_request", args))).toMatchObject({
        isError: true,
        body: { code: "VALIDATION_ERROR" },
      });
    }
    expect(h.states).toEqual([]);
  });
});

describe("the protocol", () => {
  test("answers initialize and ping, and nothing for a notification", async () => {
    const { handle } = harness();
    expect(
      await handle(
        grant,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26" },
        },
        "r",
      ),
    ).toMatchObject({
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "github" },
      },
    });
    expect(
      await handle(grant, { jsonrpc: "2.0", id: 2, method: "ping" }, "r"),
    ).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(
      await handle(
        grant,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        "r",
      ),
    ).toBeNull();
    expect(
      await handle(
        grant,
        { jsonrpc: "2.0", id: 3, method: "resources/list" },
        "r",
      ),
    ).toMatchObject({ error: { code: -32601 } });
    expect(
      await handle(grant, { jsonrpc: "2.0", id: 4, result: {} }, "r"),
    ).toBeNull();
    expect(await handle(grant, { jsonrpc: "2.0", id: 5 }, "r")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid request" },
    });
  });
});

describe("sessionBoundAuthorization", () => {
  test("allows reading and submitting to its own session only", async () => {
    const policy = sessionBoundAuthorization(SESSION);
    const ask = (action: string, id: string) =>
      policy.authorize({
        subject: testCaller("owner-a").subject,
        action: action as never,
        resource: { kind: "session", id, owner_scope: "owner-a" },
        request_id: "r",
      });
    expect((await ask("session.submit", SESSION)).outcome).toBe("allow");
    expect((await ask("session.read", SESSION)).outcome).toBe("allow");
    expect((await ask("session.submit", OTHER)).outcome).toBe("deny");
    expect((await ask("session.approve", SESSION)).outcome).toBe("deny");
  });
});
