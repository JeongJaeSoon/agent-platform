import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  type AgentGitHub,
  apiErrorResponseSchema,
  dispatchWorkflowResponseSchema,
  GITHUB_CEILING_NONE,
  type GitHubCeiling,
  githubWorkflowRunSchema,
  rerunWorkflowResponseSchema,
  type SessionScope,
  submitPullRequestReviewResponseSchema,
} from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  createGitHubGate,
  createGitHubWorkService,
  type GitHubConnection,
  type GitHubDispatchRecord,
  type GitHubGateReceipt,
  type SessionCatalog,
} from "@werft-ai/platform";
import { type FakeGitHub, startFakeGitHub } from "@werft-ai/testkit";
import { createGitHubConnection } from "../forge-github.ts";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerGitHubWorkRoutes } from "./github-work.ts";

const createApiApp = recordRouteErrors("routes/github-work.test.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
const AGENT = "019a0000-0000-7000-8000-0000000000e1";
const RELEASE = "019a0000-0000-7000-8000-0000000000f1";
// Pull requests the author App opened, and one the reviewer App did.
const OPENED = 1;
const OPENED_BY_REVIEWER = 2;
const COMMIT = "a".repeat(40);
const KEYS: Record<string, readonly SessionScope[]> = {
  csp_writer: ["sessions:read", "sessions:write"],
  csp_reader: ["sessions:read"],
};
// Values no receipt, log or response may repeat.
const SECRET_INPUTS = {
  environment: "preview-input-value-7f3a",
  note: "second-input-value-c91e",
};

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const reviewerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const reviewerPrivateKey = reviewerKeys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();

let github: FakeGitHub;
beforeAll(async () => {
  github = await startFakeGitHub({
    appId: 101,
    publicKey,
    installationId: 202,
    secondApp: {
      appId: 303,
      publicKey: reviewerKeys.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
      installationId: 404,
    },
  });
  await github.createRepository("acme", "app", { "README.md": "hello\n" });
  for (const [number, author] of [
    [OPENED, 101],
    [OPENED_BY_REVIEWER, 303],
  ] as const) {
    github.pullRequests("acme", "app").push({
      number,
      head: `agent/${number}`,
      base: "main",
      title: "",
      body: "",
      state: "open",
      author_app_id: author,
      html_url: `${github.origin}/acme/app/pull/${number}`,
    });
  }
});
afterAll(async () => {
  await github.stop();
});

const ACTIONS_ON: GitHubCeiling = {
  ...GITHUB_CEILING_NONE,
  actions: true,
  review: true,
};
const SETTINGS: AgentGitHub = {
  repositories: ["app"],
  push_approval: true,
  features: ACTIONS_ON,
  actions_allow: [
    { workflow: "ci.yml", ref: "feature/*" },
    { workflow: "deploy.yml" },
  ],
};

function app(
  options: {
    ceiling?: GitHubCeiling;
    repository?: "github" | "elsewhere";
    reviewer?: boolean;
    reviewerInstallationId?: number;
    settings?: AgentGitHub;
  } = {},
) {
  const catalog: SessionCatalog = {
    profiles: {},
    repositories: {
      app:
        options.repository === "elsewhere"
          ? {
              url: "https://git.example/acme/app.git",
              branch: "main",
              profiles: ["default"],
            }
          : {
              url: `${github.origin}/acme/app.git`,
              branch: "main",
              profiles: ["default"],
              auth: {
                kind: "github_app",
                app_id: 101,
                installation_id: 202,
                api_base: github.origin,
                value: privateKey,
                ref: { value_env: "GITHUB_APP_PRIVATE_KEY" },
              },
            },
    },
  };
  const warnings: string[] = [];
  const connection = createGitHubConnection({
    apiBase: github.origin,
    credentials: { kind: "app", appId: 101, installationId: 202, privateKey },
    retryAfterBaseMs: 1,
    paced: false,
    logger: {
      warn: (message: string, fields?: Record<string, unknown>) =>
        warnings.push(JSON.stringify({ message, fields })),
    },
  });
  // The fake serves on localhost; the gate allows Actions on github.com only.
  const onGitHubCom: GitHubConnection = { ...connection, githubCom: true };
  const reviewer: GitHubConnection = {
    ...createGitHubConnection({
      apiBase: github.origin,
      credentials: {
        kind: "app",
        appId: 303,
        installationId: options.reviewerInstallationId ?? 404,
        privateKey: reviewerPrivateKey,
      },
      retryAfterBaseMs: 1,
      paced: false,
    }),
    githubCom: true,
  };
  const receipts: GitHubGateReceipt[] = [];
  const dispatches: GitHubDispatchRecord[] = [];
  let receiptCount = 0;
  const nextReceipt = () =>
    `44444444-4444-4444-8444-${String(++receiptCount).padStart(12, "0")}`;
  const gate = createGitHubGate({
    catalog,
    connections: (id, role) => {
      if (id !== "app" || options.repository === "elsewhere") return null;
      if (role === "author") return onGitHubCom;
      return options.reviewer === false ? null : reviewer;
    },
    store: {
      context: async (sessionId) =>
        sessionId === SESSION
          ? {
              ownerId: "owner-a",
              sessionId,
              repositoryId: "app",
              repository: {
                url: catalog.repositories.app?.url ?? "",
                branch: "main",
              },
              startedBy: null,
              agent: { id: AGENT, workspaceId: "owner-a", githubEnabled: true },
              release: { id: RELEASE, github: options.settings ?? SETTINGS },
              ceiling: options.ceiling ?? ACTIONS_ON,
            }
          : null,
      findDispatch: async (repositoryId, runId) =>
        dispatches.find(
          (row) => row.repositoryId === repositoryId && row.runId === runId,
        ) ?? null,
      recordReceipt: async (receipt) => {
        receipts.push(receipt);
        return nextReceipt();
      },
    },
  });
  const service = createGitHubWorkService({
    authorization: createAuthorizationPolicy({
      sessions: {
        visibleTo: async (_ownerId, sessionId) => sessionId === SESSION,
        originOf: async () => null,
      },
    }),
    gate,
    store: {
      recordReceipt: async (receipt) => {
        receipts.push(receipt);
        return nextReceipt();
      },
      recordDispatch: async ({ context, actor, result, run }) => {
        receipts.push({
          ownerId: context.ownerId,
          sessionId: context.sessionId,
          actor,
          operation: "dispatch_workflow",
          status: "succeeded",
          result,
          error: null,
        });
        if (run !== null) {
          dispatches.push({
            runId: run.id,
            repositoryId: context.repositoryId,
            workflow: run.workflow,
            ref: run.ref,
          });
        }
        return nextReceipt();
      },
      pullRequestOpener: async (_ownerId, _repositoryId, number) =>
        number === OPENED ? { sessionId: SESSION, agentId: AGENT } : null,
    },
  });
  const logs = new MemoryLogSink();
  const api = createApiApp({
    authMode: "api-key",
    logger: new StructuredLogger({ sinks: [logs], level: "debug" }),
    keyStore: {
      async find(hash) {
        const key = Object.keys(KEYS).find((candidate) =>
          Buffer.from(hash).equals(Buffer.from(hashApiKey(candidate))),
        );
        return key
          ? {
              id: `key-${key}`,
              ownerId: "owner-a",
              workspaceId: null,
              kind: "operator" as const,
              createdByUserId: null,
              creatorRole: null,
              scopes: [...(KEYS[key] ?? [])],
            }
          : null;
      },
    },
    registerRoutes: (router) => registerGitHubWorkRoutes(router, service),
  });
  const send = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    key = "csp_writer",
    session = SESSION,
  ) => {
    const response = await api.request(
      `/v1/sessions/${session}/github${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      },
    );
    const text = await response.text();
    return {
      status: response.status,
      text,
      json: text ? JSON.parse(text) : null,
    };
  };
  const dispatch = (body: unknown, key?: string) =>
    send("POST", "/workflow-dispatches", body, key);
  return {
    send,
    dispatch,
    receipts,
    dispatches,
    // Everything a caller or an operator could read back.
    seen: () => [
      ...warnings,
      ...logs.records.map((record) => JSON.stringify(record)),
      JSON.stringify(receipts),
    ],
  };
}

const errorOf = (json: unknown) => apiErrorResponseSchema.parse(json).error;

describe("GitHub work routes", () => {
  test("an allow-listed dispatch starts the run, and its receipt names the inputs but keeps none of their values", async () => {
    const target = app();
    const response = await target.dispatch({
      workflow: "ci.yml",
      ref: "feature/login",
      inputs: SECRET_INPUTS,
    });
    expect(response.status).toBe(201);
    const { run, receipt_id } = dispatchWorkflowResponseSchema.parse(
      response.json,
    );
    const [started] = github
      .workflowRuns("acme", "app")
      .filter((entry) => entry.id === run?.id);
    expect(started).toMatchObject({
      path: ".github/workflows/ci.yml",
      head_branch: "feature/login",
      event: "workflow_dispatch",
      inputs: SECRET_INPUTS,
    });
    if (run === null) throw new Error("GitHub named no run");
    expect(run.html_url).toBe(started?.html_url ?? "");
    expect(receipt_id).toMatch(/^44444444-/);
    expect(target.dispatches).toEqual([
      {
        runId: run.id,
        repositoryId: "app",
        workflow: "ci.yml",
        ref: "feature/login",
      },
    ]);
    const dispatched = target.receipts.find(
      (receipt) => receipt.operation === "dispatch_workflow",
    );
    expect(dispatched).toMatchObject({
      status: "succeeded",
      result: {
        session_id: SESSION,
        agent_id: AGENT,
        agent_release_id: RELEASE,
        repository_id: "app",
        workflow: "ci.yml",
        ref: "feature/login",
        input_keys: ["environment", "note"],
        run_id: run?.id,
        allowed_by: { workflow: "ci.yml", ref: "feature/*" },
      },
    });
    expect(
      target.receipts.find(
        (receipt) => receipt.operation === "mint_github_token",
      ),
    ).toMatchObject({
      status: "succeeded",
      result: { purpose: "dispatch", permissions: { actions: "write" } },
    });
    for (const text of target.seen()) {
      for (const value of Object.values(SECRET_INPUTS)) {
        expect(text).not.toContain(value);
      }
    }
  });

  test("a workflow or ref outside the allow-list, or an agent/ ref, is refused before GitHub hears of it", async () => {
    const target = app();
    const before = github.workflowRuns("acme", "app").length;
    for (const [body, reason] of [
      [{ workflow: "release.yml", ref: "main" }, "workflow_not_allowed"],
      [{ workflow: "ci.yml", ref: "main" }, "workflow_not_allowed"],
      [{ workflow: "deploy.yml", ref: "feature/x" }, "workflow_not_allowed"],
      [{ workflow: "ci.yml", ref: "feature/a/b" }, "workflow_not_allowed"],
      [{ workflow: "ci.yml", ref: `agent/${SESSION}` }, "agent_ref_refused"],
    ] as const) {
      const response = await target.dispatch(body);
      expect(response.status).toBe(403);
      expect(errorOf(response.json)).toMatchObject({
        code: "GITHUB_REFUSED",
        details: { reason_code: reason, receipt_id: expect.any(String) },
      });
    }
    expect(github.workflowRuns("acme", "app")).toHaveLength(before);
    expect(target.receipts.map((receipt) => receipt.status)).toEqual(
      Array(5).fill("failed"),
    );
    expect(target.receipts.at(-1)).toMatchObject({
      operation: "dispatch_workflow",
      result: { reason_code: "agent_ref_refused" },
      error: { code: "GITHUB_REFUSED" },
    });
  });

  test("GitHub refusing a dispatch is a 503 that repeats none of the inputs, in the answer, the logs or the receipts", async () => {
    const target = app();
    github.failDispatches(true);
    try {
      const response = await target.dispatch({
        workflow: "deploy.yml",
        ref: "main",
        inputs: SECRET_INPUTS,
      });
      expect(response.status).toBe(503);
      expect(errorOf(response.json)).toMatchObject({
        code: "BACKEND_UNAVAILABLE",
        details: { receipt_id: expect.any(String) },
      });
      for (const value of Object.values(SECRET_INPUTS)) {
        expect(response.text).not.toContain(value);
      }
    } finally {
      github.failDispatches(false);
    }
    expect(
      target.receipts.find(
        (receipt) =>
          receipt.operation === "dispatch_workflow" &&
          receipt.status === "failed",
      ),
    ).toMatchObject({
      result: {
        workflow: "deploy.yml",
        ref: "main",
        input_keys: ["environment", "note"],
        status: 422,
      },
    });
    expect(target.dispatches).toEqual([]);
    const seen = target.seen();
    expect(seen.join("\n")).toContain("workflow dispatch");
    for (const text of seen) {
      for (const value of Object.values(SECRET_INPUTS)) {
        expect(text).not.toContain(value);
      }
    }
  });

  test("a run the platform dispatched is rerun; one a push started is not", async () => {
    const target = app();
    const dispatched = await target.dispatch({
      workflow: "deploy.yml",
      ref: "main",
    });
    const runId = dispatchWorkflowResponseSchema.parse(dispatched.json).run?.id;
    const rerun = await target.send("POST", `/workflow-runs/${runId}/rerun`, {
      failed_only: true,
    });
    expect(rerun.status).toBe(201);
    rerunWorkflowResponseSchema.parse(rerun.json);
    expect(
      github.workflowRuns("acme", "app").find((run) => run.id === runId)
        ?.reruns,
    ).toEqual([{ failedOnly: true }]);
    expect(target.receipts.at(-1)).toMatchObject({
      operation: "rerun_workflow",
      status: "succeeded",
      result: { run_id: runId, failed_only: true, workflow: "deploy.yml" },
    });

    const pushed = github.addWorkflowRun("acme", "app", {
      path: ".github/workflows/deploy.yml",
      head_branch: "main",
    });
    const refused = await target.send(
      "POST",
      `/workflow-runs/${pushed}/rerun`,
      {},
    );
    expect(refused.status).toBe(403);
    expect(errorOf(refused.json).details).toMatchObject({
      reason_code: "run_ref_unprovable",
    });
    expect(
      github.workflowRuns("acme", "app").find((run) => run.id === pushed)
        ?.reruns,
    ).toEqual([]);
  });

  test("with Actions off under the workspace ceiling, every piece of work is refused 409", async () => {
    const target = app({ ceiling: GITHUB_CEILING_NONE });
    const before = github.workflowRuns("acme", "app").length;
    const dispatched = await target.dispatch({
      workflow: "deploy.yml",
      ref: "main",
    });
    expect(dispatched.status).toBe(409);
    expect(errorOf(dispatched.json)).toMatchObject({
      code: "GITHUB_REFUSED",
      details: { reason_code: "over_workspace_ceiling" },
    });
    const read = await target.send("GET", "/workflow-runs/1");
    expect(read.status).toBe(409);
    expect(errorOf(read.json).details).toMatchObject({
      reason_code: "over_workspace_ceiling",
    });
    const rerun = await target.send("POST", "/workflow-runs/1/rerun", {});
    expect(rerun.status).toBe(409);
    expect(github.workflowRuns("acme", "app")).toHaveLength(before);
  });

  test("with Actions on, any run in the repository can be read; one GitHub does not know is 404", async () => {
    const target = app();
    const pushed = github.addWorkflowRun("acme", "app", {
      path: ".github/workflows/ci.yml",
      head_branch: "feature/x",
    });
    const read = await target.send(
      "GET",
      `/workflow-runs/${pushed}`,
      undefined,
      "csp_reader",
    );
    expect(read.status).toBe(200);
    expect(githubWorkflowRunSchema.parse(read.json)).toEqual({
      id: pushed,
      path: ".github/workflows/ci.yml",
      head_branch: "feature/x",
      status: "completed",
      conclusion: "failure",
      html_url: `${github.origin}/acme/app/actions/runs/${pushed}`,
    });
    expect(target.receipts).toMatchObject([
      {
        operation: "mint_github_token",
        result: { purpose: "actions_read", permissions: { actions: "read" } },
      },
    ]);
    const missing = await target.send("GET", "/workflow-runs/123");
    expect(missing.status).toBe(404);
    expect(errorOf(missing.json).code).toBe("NOT_FOUND");
  });

  test("a session the caller cannot see is 404 on every route, before the gate", async () => {
    const target = app();
    const other = "99999999-9999-4999-8999-999999999999";
    for (const response of [
      await target.send(
        "POST",
        "/workflow-dispatches",
        { workflow: "deploy.yml", ref: "main" },
        "csp_writer",
        other,
      ),
      await target.send(
        "GET",
        "/workflow-runs/1",
        undefined,
        "csp_writer",
        other,
      ),
      await target.send(
        "POST",
        "/workflow-runs/1/rerun",
        {},
        "csp_writer",
        other,
      ),
    ]) {
      expect(response.status).toBe(404);
      expect(errorOf(response.json).code).toBe("NOT_FOUND");
    }
    expect(target.receipts).toEqual([]);
  });

  test("a repository not on GitHub is 422; a read-only key may not dispatch or rerun", async () => {
    const elsewhere = app({ repository: "elsewhere" });
    for (const response of [
      await elsewhere.dispatch({ workflow: "deploy.yml", ref: "main" }),
      await elsewhere.send("GET", "/workflow-runs/1"),
      await elsewhere.send("POST", "/workflow-runs/1/rerun", {}),
    ]) {
      expect(response.status).toBe(422);
      expect(errorOf(response.json).code).toBe("UNSUPPORTED_CAPABILITY");
    }
    const target = app();
    for (const response of [
      await target.dispatch(
        { workflow: "deploy.yml", ref: "main" },
        "csp_reader",
      ),
      await target.send("POST", "/workflow-runs/1/rerun", {}, "csp_reader"),
    ]) {
      expect(response.status).toBe(403);
      expect(errorOf(response.json).code).toBe("FORBIDDEN");
    }
    expect(target.receipts.filter((r) => r.status === "succeeded")).toEqual([]);
  });

  test("a bad body is 400, a bad run id 404, and an oversized body 413", async () => {
    const target = app();
    for (const body of [
      { workflow: "../x.yml", ref: "main" },
      { workflow: "deploy.yml", ref: "refs/heads/main" },
      { workflow: "deploy.yml", ref: "main", extra: 1 },
      {
        workflow: "deploy.yml",
        ref: "main",
        inputs: Object.fromEntries(
          Array.from({ length: 26 }, (_, index) => [`k${index}`, "v"]),
        ),
      },
    ]) {
      expect((await target.dispatch(body)).status).toBe(400);
    }
    expect(
      (
        await target.send("POST", "/workflow-runs/1/rerun", {
          failed_only: "yes",
        })
      ).status,
    ).toBe(400);
    // A run id that cannot be one names no resource.
    for (const id of ["0", "abc"]) {
      expect((await target.send("GET", `/workflow-runs/${id}`)).status).toBe(
        404,
      );
    }
    expect(
      (
        await target.dispatch({
          workflow: "deploy.yml",
          ref: "main",
          inputs: { big: "x".repeat(70 * 1024) },
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await target.send("POST", "/workflow-runs/1/rerun", {
          pad: "x".repeat(70 * 1024),
        })
      ).status,
    ).toBe(413);
    expect(target.receipts).toEqual([]);
  });
});

describe("reviewing a pull request", () => {
  const review = (
    target: ReturnType<typeof app>,
    body: unknown,
    number: number | string = OPENED,
    key?: string,
  ) => target.send("POST", `/pull-requests/${number}/reviews`, body, key);

  test("the review goes out with the reviewer App's token and names the commit; its receipt keeps no body", async () => {
    const target = app();
    const approved = await review(target, {
      event: "APPROVE",
      commit_id: COMMIT,
    });
    expect(approved.status).toBe(201);
    const { receipt_id, review: sent } =
      submitPullRequestReviewResponseSchema.parse(approved.json);
    expect(receipt_id).toMatch(/^44444444-/);
    const changes = await review(target, {
      event: "REQUEST_CHANGES",
      commit_id: COMMIT,
      body: "review-body-value-5d2b",
    });
    expect(changes.status).toBe(201);
    expect(
      github.reviews("acme", "app", OPENED).map(({ id: _id, ...rest }) => rest),
    ).toEqual([
      {
        pull_number: OPENED,
        commit_id: COMMIT,
        event: "APPROVE",
        body: null,
        app_id: 303,
      },
      {
        pull_number: OPENED,
        commit_id: COMMIT,
        event: "REQUEST_CHANGES",
        body: "review-body-value-5d2b",
        app_id: 303,
      },
    ]);
    expect(sent.id).toBe(github.reviews("acme", "app", OPENED)[0]?.id ?? 0);
    expect(target.receipts).toMatchObject([
      {
        operation: "mint_github_token",
        status: "succeeded",
        result: {
          role: "reviewer",
          app_id: 303,
          permissions: { pull_requests: "write" },
        },
      },
      {
        operation: "review_pull_request",
        status: "succeeded",
        result: {
          session_id: SESSION,
          repository_id: "app",
          number: OPENED,
          commit_id: COMMIT,
          event: "APPROVE",
          opened_by_session_id: SESSION,
          opened_by_agent_id: AGENT,
          review_id: sent.id,
        },
      },
      { operation: "review_pull_request", status: "succeeded" },
    ]);
    for (const text of target.seen()) {
      expect(text).not.toContain("review-body-value-5d2b");
    }
  });

  test("GitHub refusing the review is a 503 with a failed receipt", async () => {
    const target = app();
    const response = await review(
      target,
      { event: "APPROVE", commit_id: COMMIT },
      OPENED_BY_REVIEWER,
    );
    expect(response.status).toBe(503);
    expect(errorOf(response.json)).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      details: { receipt_id: expect.any(String) },
    });
    expect(target.receipts.at(-1)).toMatchObject({
      operation: "review_pull_request",
      status: "failed",
      result: {
        number: OPENED_BY_REVIEWER,
        opened_by_session_id: null,
        status: 422,
      },
    });
    expect(github.reviews("acme", "app", OPENED_BY_REVIEWER)).toEqual([]);
  });

  test("a reviewer App not installed on the repository is a 503 that still leaves the review's failed receipt", async () => {
    const before = github.reviews("acme", "app", OPENED).length;
    const target = app({ reviewerInstallationId: 999 });
    const response = await review(target, {
      event: "APPROVE",
      commit_id: COMMIT,
    });
    expect(response.status).toBe(503);
    expect(errorOf(response.json)).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      details: { receipt_id: expect.any(String) },
    });
    expect(target.receipts).toMatchObject([
      {
        operation: "review_pull_request",
        status: "failed",
        result: {
          role: "reviewer",
          app_id: 303,
          number: OPENED,
          commit_id: COMMIT,
          event: "APPROVE",
        },
      },
    ]);
    expect(github.reviews("acme", "app", OPENED)).toHaveLength(before);
  });

  test("no reviewer App, review off for the agent, or over the ceiling: refused before GitHub hears of it", async () => {
    const before = github.reviews("acme", "app", OPENED).length;
    const approve = { event: "APPROVE", commit_id: COMMIT };
    for (const [target, status, reason] of [
      [app({ reviewer: false }), 409, "no_reviewer_app"],
      [
        app({
          settings: {
            ...SETTINGS,
            features: { ...ACTIONS_ON, review: false },
          },
        }),
        403,
        "feature_off",
      ],
      [
        app({ ceiling: { ...ACTIONS_ON, review: false } }),
        409,
        "over_workspace_ceiling",
      ],
    ] as const) {
      const response = await review(target, approve);
      expect(response.status).toBe(status);
      expect(errorOf(response.json)).toMatchObject({
        code: "GITHUB_REFUSED",
        details: { reason_code: reason, receipt_id: expect.any(String) },
      });
      expect(target.receipts).toMatchObject([
        {
          operation: "review_pull_request",
          status: "failed",
          result: {
            reason_code: reason,
            number: OPENED,
            commit_id: COMMIT,
            event: "APPROVE",
          },
        },
      ]);
    }
    expect(github.reviews("acme", "app", OPENED)).toHaveLength(before);
  });

  test("bad bodies are 400, a bad number or an unseen session 404, an oversized body 413, a read-only key 403, a repository off GitHub 422", async () => {
    const target = app();
    for (const body of [
      { event: "APPROVE" },
      { event: "APPROVE", commit_id: "abc" },
      { event: "COMMENT", commit_id: COMMIT },
      { event: "DISMISS", commit_id: COMMIT },
      { event: "APPROVE", commit_id: COMMIT, extra: 1 },
    ]) {
      expect((await review(target, body)).status).toBe(400);
    }
    const approve = { event: "APPROVE", commit_id: COMMIT };
    for (const number of ["0", "abc"]) {
      expect((await review(target, approve, number)).status).toBe(404);
    }
    const unseen = await target.send(
      "POST",
      `/pull-requests/${OPENED}/reviews`,
      approve,
      "csp_writer",
      "99999999-9999-4999-8999-999999999999",
    );
    expect(unseen.status).toBe(404);
    expect(
      (
        await review(target, {
          ...approve,
          body: "x".repeat(70 * 1024),
        })
      ).status,
    ).toBe(413);
    const reader = await review(target, approve, OPENED, "csp_reader");
    expect(reader.status).toBe(403);
    expect(errorOf(reader.json).code).toBe("FORBIDDEN");
    expect(target.receipts).toEqual([]);
    const elsewhere = await review(app({ repository: "elsewhere" }), approve);
    expect(elsewhere.status).toBe(422);
    expect(errorOf(elsewhere.json).code).toBe("UNSUPPORTED_CAPABILITY");
  });
});
