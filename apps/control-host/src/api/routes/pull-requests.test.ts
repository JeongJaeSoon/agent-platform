import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  commentPullRequestResponseSchema,
  openPullRequestResponseSchema,
  type PullRequest,
  type SessionScope,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createPullRequestService,
  type ForgeAdapter,
  ForgeCredentialError,
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
const KEYS: Record<string, readonly SessionScope[]> = {
  csp_writer: ["sessions:read", "sessions:write"],
  csp_approver: ["sessions:read", "sessions:approve"],
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
    githubPinned?: boolean;
  } = {},
) {
  const receipts: PullRequestReceipt[] = [];
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
  const forge: ForgeAdapter = {
    kind: "github",
    maxBodyLength: 65_536,
    gitCredential: async () => {
      throw new Error("not used");
    },
    getRepository: async () => {
      throw new Error("not used");
    },
    findPullRequestForBranch: async () => {
      fail("lookup");
      return null;
    },
    createPullRequest: async (_repo, input) => ({
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
  };
  const service = createPullRequestService({
    authorization: createAuthorizationPolicy(),
    catalog: CATALOG,
    forges: () => forge,
    github: { pinned: async () => options.githubPinned ?? false },
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
        const token = Object.keys(KEYS).find((candidate) =>
          Buffer.from(hash).equals(Buffer.from(hashApiKey(candidate))),
        );
        return token
          ? {
              id: `key-${token}`,
              ownerId: "owner-a",
              workspaceId: null,
              kind: "operator" as const,
              createdByUserId: null,
              creatorRole: null,
              scopes: [...(KEYS[token] ?? [])],
            }
          : null;
      },
    },
    registerRoutes: (router) => registerPullRequestRoutes(router, service),
  });
  return { api, receipts };
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
    const pinned = app({ githubPinned: true });
    expect(await errorOf(post(pinned, "", {}))).toMatchObject({
      status: 409,
      code: "GITHUB_REFUSED",
      details: {
        refusal: "github_settings_unsupported",
        reason_code: "github_settings_unsupported",
      },
    });
    expect(pinned.receipts.map((r) => r.result.refusal)).toEqual([
      "github_settings_unsupported",
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

  test("a writer key, an unverified caller and a bad body are refused", async () => {
    for (const path of ["", "/comments"]) {
      const writer = app();
      expect(
        await errorOf(post(writer, path, { body: "x" }, "csp_writer")),
      ).toMatchObject({
        status: 403,
        code: "FORBIDDEN",
        details: { refusal: "missing_scope" },
      });
      expect(writer.receipts).toHaveLength(1);
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
