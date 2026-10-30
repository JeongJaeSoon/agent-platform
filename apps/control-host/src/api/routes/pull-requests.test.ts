import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  commentPullRequestResponseSchema,
  GITHUB_CEILING_NONE,
  openPullRequestResponseSchema,
  type PullRequest,
  type SessionScope,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createGitHubGate,
  createPullRequestService,
  ForgeCredentialError,
  type GitHubApi,
  type GitHubConnection,
  type GitHubGateReceipt,
  type GitHubSessionContext,
  type PullRequestReceipt,
  type PullRequestSource,
  repositoryBinding,
  type SessionCatalog,
} from "@werft-ai/platform";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerPullRequestRoutes } from "./pull-requests.ts";

const createApiApp = recordRouteErrors("routes/pull-requests.test.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
const PUSH = "22222222-2222-4222-8222-222222222222";
const AGENT = "019a0000-0000-7000-8000-0000000000e1";
const KEYS: Record<string, readonly SessionScope[]> = {
  csp_reader: ["sessions:read"],
  csp_writer: ["sessions:read", "sessions:write"],
  csp_approver: ["sessions:read", "sessions:approve"],
  csp_agent: ["sessions:read", "sessions:write"],
};
const CATALOG = {
  profiles: {},
  repositories: {
    app: {
      url: "https://github.com/acme/app.git",
      branch: "main",
      profiles: ["default"],
    },
  },
} satisfies SessionCatalog;

function app(
  options: {
    state?: PullRequestSource["state"];
    binding?: string;
    failing?: "lookup" | "comment";
    authMode?: "none";
    release?: GitHubSessionContext["release"];
  } = {},
) {
  const receipts: PullRequestReceipt[] = [];
  const gateReceipts: GitHubGateReceipt[] = [];
  let recorded: PullRequest | null = null;
  const source: PullRequestSource = {
    id: PUSH,
    sessionId: SESSION,
    repositoryId: "app",
    repositoryBinding:
      options.binding ?? repositoryBinding("app", CATALOG.repositories.app),
    state: options.state ?? "pushed",
    targetBranch: `agent/${SESSION}`,
    gitCommit: "a".repeat(40),
  };
  const fail = (call: "lookup" | "comment") => {
    if (options.failing === call) {
      throw new ForgeCredentialError("GitHub failed (502)");
    }
  };
  let comments = 0;
  const forge: GitHubApi = {
    maxBodyLength: 65_536,
    getRepository: async () => {
      throw new Error("not used");
    },
    findPullRequestForBranch: async () => {
      fail("lookup");
      return null;
    },
    createPullRequest: async (input) => ({
      number: 5,
      url: "https://github.com/acme/app/pull/5",
      state: "open",
      head: input.head,
      base: input.base,
    }),
    upsertComment: async () => {
      fail("comment");
      comments += 1;
      return {
        id: 77,
        url: "https://github.com/acme/app/pull/5#issuecomment-77",
        created: comments === 1,
      };
    },
    dispatchWorkflow: async () => {
      throw new Error("not used");
    },
    getWorkflowRun: async () => {
      throw new Error("not used");
    },
    submitReview: async () => {
      throw new Error("not used");
    },
    rerunWorkflow: async () => {
      throw new Error("not used");
    },
  };
  const connection: GitHubConnection = {
    kind: "app",
    githubCom: true,
    appId: 101,
    installed: async () => true,
    credential: async () => ({
      credential: { username: "x-access-token", password: "fixture" },
      fresh: false,
    }),
    api: () => forge,
  };
  const gate = createGitHubGate({
    catalog: CATALOG,
    connections: (_id, role) => (role === "author" ? connection : null),
    store: {
      context: async (sessionId) => ({
        ownerId: "owner-a",
        sessionId,
        repositoryId: "app",
        repository: { url: "https://github.com/acme/app.git", branch: "main" },
        startedBy: null,
        agent: null,
        release: options.release ?? null,
        ceiling: GITHUB_CEILING_NONE,
      }),
      findDispatch: async () => null,
      recordReceipt: async (receipt) => {
        gateReceipts.push(receipt);
        return "66666666-6666-4666-8666-666666666666";
      },
    },
  });
  const service = createPullRequestService({
    authorization: createAuthorizationPolicy(),
    catalog: CATALOG,
    gate,
    redact: (line) => line,
    store: {
      findSource: async (ownerId, sessionId, pushRequestId) =>
        ownerId === "owner-a" && sessionId === SESSION && pushRequestId === PUSH
          ? source
          : null,
      findPullRequest: async () => recorded,
      findBranchPullRequest: async () => null,
      recordReceipt: async (input) => {
        receipts.push(input);
        return "44444444-4444-4444-8444-444444444444";
      },
      savePullRequest: async (input) => {
        recorded = {
          push_request_id: input.pushRequestId,
          session_id: input.sessionId,
          repository_id: input.repositoryId,
          number: input.number,
          url: input.url,
          head: input.head,
          base: input.base,
          created_at: "2026-10-13T00:00:00.000Z",
          receipt_id: "55555555-5555-4555-8555-555555555555",
        };
        return {
          pullRequest: recorded,
          created: input.created,
          receiptId: recorded.receipt_id,
        };
      },
    },
  });
  const api = createApiApp({
    authMode: options.authMode ?? "api-key",
    keyStore: {
      async find(hash) {
        const key = Object.keys(KEYS).find((candidate) =>
          Buffer.from(hash).equals(Buffer.from(hashApiKey(candidate))),
        );
        if (!key) return null;
        const agent = key === "csp_agent";
        return {
          id: `key-${key}`,
          ownerId: "owner-a",
          workspaceId: null,
          kind: agent ? ("agent" as const) : ("operator" as const),
          agentId: agent ? AGENT : null,
          createdByUserId: null,
          creatorRole: null,
          scopes: [...(KEYS[key] ?? [])],
        };
      },
    },
    registerRoutes: (router) => registerPullRequestRoutes(router, service),
  });
  return { api, receipts, gateReceipts };
}

function post(
  target: ReturnType<typeof app>,
  path: string,
  body: unknown,
  key = "csp_approver",
  push = PUSH,
) {
  return target.api.request(
    `/v1/sessions/${SESSION}/push-requests/${push}/pull-request${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

async function errorOf(response: Response | Promise<Response>) {
  const settled = await response;
  const { error } = apiErrorResponseSchema.parse(await settled.json());
  return { status: settled.status, code: error.code, details: error.details };
}

describe("pull request routes", () => {
  test("opens with 201, answers the same pull request with 200 after", async () => {
    const target = app();
    const first = await post(target, "", { title: "Result" });
    expect(first.status).toBe(201);
    expect(
      openPullRequestResponseSchema.parse(await first.json()),
    ).toMatchObject({
      created: true,
      pull_request: { number: 5, head: `agent/${SESSION}`, base: "main" },
    });
    const again = await post(target, "", {});
    expect(again.status).toBe(200);
    expect(
      openPullRequestResponseSchema.parse(await again.json()).created,
    ).toBe(false);
  });

  test("comments with 201, edits the marked one with 200", async () => {
    const target = app();
    await post(target, "", {});
    const first = await post(target, "/comments", { body: "Started" });
    expect(first.status).toBe(201);
    expect(
      commentPullRequestResponseSchema.parse(await first.json()).comment,
    ).toMatchObject({ id: 77, marker: "status", created: true });
    expect((await post(target, "/comments", { body: "Done" })).status).toBe(
      200,
    );
  });

  test("an agent key that may only submit to the session opens and comments on a pushed request", async () => {
    const target = app();
    const opened = await post(target, "", { title: "Result" }, "csp_agent");
    expect(opened.status).toBe(201);
    expect(
      openPullRequestResponseSchema.parse(await opened.json()).pull_request,
    ).toMatchObject({ number: 5, head: `agent/${SESSION}` });
    expect(
      (await post(target, "/comments", { body: "Done" }, "csp_agent")).status,
    ).toBe(201);
    expect(target.receipts.at(0)?.actor).toMatchObject({
      principal: { kind: "api_key", id: "key-csp_agent" },
      agent_id: AGENT,
    });
    // Before the push lands, only someone who may decide it may open one.
    expect(
      await errorOf(post(app({ state: "approved" }), "", {}, "csp_agent")),
    ).toMatchObject({
      status: 409,
      code: "PUSH_NOT_PUSHED",
      details: { refusal: "not_pushed" },
    });
  });

  test("refusals map to their statuses, each with a receipt", async () => {
    expect(
      await errorOf(post(app({ state: "approved" }), "", {})),
    ).toMatchObject({
      status: 409,
      code: "PUSH_NOT_PUSHED",
      details: { refusal: "not_pushed" },
    });
    expect(
      await errorOf(post(app({ binding: "sha256:old" }), "", {})),
    ).toMatchObject({ status: 409, code: "CATALOG_MISMATCH" });
    expect(
      await errorOf(post(app(), "/comments", { body: "x" })),
    ).toMatchObject({
      status: 409,
      code: "PULL_REQUEST_MISSING",
    });
    const unknown = app();
    expect(
      await errorOf(
        post(
          unknown,
          "",
          {},
          "csp_approver",
          "66666666-6666-4666-8666-666666666666",
        ),
      ),
    ).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(
      await errorOf(
        post(
          unknown,
          "/comments",
          { body: "x" },
          "csp_approver",
          "66666666-6666-4666-8666-666666666666",
        ),
      ),
    ).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(unknown.receipts.map((r) => r.result.refusal)).toEqual([
      "not_found",
      "not_found",
    ]);
    expect(
      await errorOf(post(app({ failing: "lookup" }), "", {})),
    ).toMatchObject({
      status: 503,
      code: "BACKEND_UNAVAILABLE",
      details: { refusal: "forge_failed" },
    });
    const invalid = app({
      release: { id: crypto.randomUUID(), github: "invalid" },
    });
    expect(await errorOf(post(invalid, "", {}))).toMatchObject({
      status: 409,
      code: "GITHUB_REFUSED",
      details: {
        refusal: "github_refused",
        reason_code: "github_settings_unsupported",
      },
    });
    expect(invalid.receipts.map((r) => r.result.refusal)).toEqual([
      "github_refused",
    ]);
    expect(invalid.gateReceipts).toMatchObject([
      {
        operation: "mint_github_token",
        status: "failed",
        result: {
          purpose: "pull_request",
          reason_code: "github_settings_unsupported",
        },
      },
    ]);
  });

  test("a forge failure on a comment is a 503", async () => {
    const target = app({ failing: "comment" });
    await post(target, "", {});
    expect(
      await errorOf(post(target, "/comments", { body: "x" })),
    ).toMatchObject({
      status: 503,
      code: "BACKEND_UNAVAILABLE",
      details: { refusal: "forge_failed" },
    });
  });

  test("a read-only key, an unverified caller and a bad body are refused", async () => {
    for (const path of ["", "/comments"]) {
      const reader = app();
      expect(
        await errorOf(post(reader, path, { body: "x" }, "csp_reader")),
      ).toMatchObject({
        status: 403,
        code: "FORBIDDEN",
        details: { refusal: "missing_scope" },
      });
      expect(reader.receipts).toHaveLength(1);
      const open = app({ authMode: "none" });
      expect(
        (
          await open.api.request(
            `/v1/sessions/${SESSION}/push-requests/${PUSH}/pull-request${path}`,
            {
              method: "POST",
              headers: {
                "X-Owner-Id": "owner-a",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ body: "x" }),
            },
          )
        ).status,
      ).toBe(403);
      expect(open.receipts).toEqual([]);
      expect(
        await errorOf(post(app(), path, { body: "x", head: "main" })),
      ).toMatchObject({ status: 400, code: "BAD_REQUEST" });
      expect(
        await errorOf(post(app(), path, { body: "x".repeat(70 * 1024) })),
      ).toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
    }
    expect(
      await errorOf(
        post(app(), "/comments", { body: "x", marker: "Bad Marker" }),
      ),
    ).toMatchObject({ status: 400, code: "BAD_REQUEST" });
  });
});
