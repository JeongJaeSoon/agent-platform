import { describe, expect, test } from "bun:test";
import type { AgentGitHub, ReceiptActor } from "@werft-ai/contracts";
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
  const policies: AuthorizationPolicy[] = [];
  const api: GitHubApi = {
    maxBodyLength: 65_536,
    getRepository: unused,
    findPullRequestForBranch: unused,
    createPullRequest: unused,
    updatePullRequestBody: unused,
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
        allowedBy: { workflow: "ci.yml" },
        context: {
          ownerId: "owner-a",
          sessionId: work.sessionId,
          agentId: creator.agent_id,
          agentReleaseId: "release-1",
          repositoryId: "app",
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
    pullRequestOpener: async () => null,
  };
  const services = (authorization: AuthorizationPolicy): GitHubMcpServices => {
    policies.push(authorization);
    return {
      pushRequests: {
        create: async (actor, sessionId) => {
          pushes.push({ actor, sessionId });
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
          return { created: true } as never;
        },
        comment: unused,
      },
      githubWork: createGitHubWorkService({
        authorization,
        gate,
        store: workStore,
      }),
    };
  };
  const handle = createGitHubMcpServer({
    store: {
      sessionState: async () => ({
        ownerId: "owner-a",
        agentId: creator.agent_id ?? "",
        releaseId: "release-1",
        github: github(),
        enabled: true,
        actor: creator,
        ...state,
      }),
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
    policies,
    gate,
    workStore,
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
      "comment_pull_request",
    ]);
  });

  test("a turned-off feature's tools are not listed", async () => {
    expect(toolNames(await list({ actions: true }))).toEqual([
      "request_push",
      "open_pull_request",
      "comment_pull_request",
      "dispatch_workflow",
      "get_workflow_run",
      "rerun_workflow",
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
