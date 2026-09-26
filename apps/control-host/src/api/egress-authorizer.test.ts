import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as schema from "@agent-platform/db";
import {
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
} from "@agent-platform/db";
import { createLogger } from "@agent-platform/observability";
import {
  acceptAllCheckpoints,
  createWorkerGateway,
} from "@agent-platform/platform";
import { createObjectRouteSigner } from "@agent-platform/storage";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApiApp } from "./app.ts";
import {
  createEgressAuthorizer,
  EGRESS_AUTHORIZER_PATH,
  EGRESS_USAGE_PATH,
  egressAuthorizerConfigFromEnv,
} from "./egress-authorizer.ts";
import { registerWorkerRoutes } from "./routes/worker.ts";

const AUTHORIZER_TOKEN = "authorizer-token-for-tests-0123456789";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let gateway: ReturnType<typeof createWorkerGateway>;
let authorize: (request: Request) => Promise<Response>;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: `${import.meta.dir}/../../../../packages/db/migrations`,
  });
  gateway = createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog: {
      profiles: {
        "claude-coding-v1": {
          runtime_kind: "claude_agent_sdk",
          runtime_version: "0.3.270",
          model: "claude-sonnet-5",
          tools: ["Read"],
          permission_mode: "default",
          provider: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.invalid",
            auth: {
              kind: "api_key",
              value: "catalog-provider-key",
              ref: { value_env: "PROVIDER_KEY" },
            },
          },
        },
      },
      repositories: {
        "sample-app": {
          url: "https://git.invalid/agent/app.git",
          branch: "main",
          profiles: ["claude-coding-v1"],
          auth: {
            kind: "basic",
            username: "reader",
            value: "catalog-repo-token",
            ref: { value_env: "REPO_TOKEN" },
          },
        },
      },
    },
    checkpoints: acceptAllCheckpoints,
    options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 60_000 },
  });
  authorize = createEgressAuthorizer({
    gateway,
    logger: createLogger({ sinks: [] }),
    token: AUTHORIZER_TOKEN,
  });
});

afterEach(async () => {
  await client.close();
});

async function claimed() {
  const accepted = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
    principal: { ownerId: "owner-a" },
    idempotencyKey: crypto.randomUUID(),
    payloadHash: "hash",
    profileId: "claude-coding-v1",
    repository: {
      id: "sample-app",
      url: "https://git.invalid/agent/app.git",
      branch: "main",
    },
    message: "hello",
  });
  if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
  const launch = await gateway.registerLaunch({
    executionId: "exec-1",
    generation: 1,
    backend: "local_docker",
  });
  if (launch.nonce === null) throw new Error("launch already registered");
  return await gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: "exec-1",
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: launch.nonce },
    },
  );
}

function ask(
  body: unknown,
  options: { bearer?: string | null; path?: string; method?: string } = {},
) {
  const bearer =
    options.bearer === undefined ? AUTHORIZER_TOKEN : options.bearer;
  return authorize(
    new Request(
      `http://authorizer.invalid${options.path ?? EGRESS_AUTHORIZER_PATH}`,
      {
        method: options.method ?? "POST",
        headers: {
          "content-type": "application/json",
          ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    ),
  );
}

describe("egress authorizer (94S-252)", () => {
  test("turns a live token into its upstream and the credential to inject", async () => {
    const claim = await claimed();
    const provider = await ask({
      token: claim.runtime_config.provider.auth.token,
      purpose: "provider",
    });
    expect(provider.status).toBe(200);
    expect(await provider.json()).toEqual({
      session_id: claim.session_id,
      attempt_id: claim.attempt_id,
      upstream: {
        url: "https://api.anthropic.invalid",
        headers: [["x-api-key", "catalog-provider-key"]],
      },
    });
    const repository = await ask({
      token: claim.workspace.repository.access?.token,
      purpose: "repository",
    });
    expect(repository.status).toBe(200);
    expect(await repository.json()).toMatchObject({
      upstream: {
        url: "https://git.invalid/agent/app.git",
        headers: [
          [
            "authorization",
            `Basic ${Buffer.from("reader:catalog-repo-token").toString("base64")}`,
          ],
        ],
      },
    });
  });

  test("answers nothing without its own bearer, whatever the token", async () => {
    const claim = await claimed();
    const body = {
      token: claim.runtime_config.provider.auth.token,
      purpose: "provider",
    };
    for (const bearer of [null, "wrong", `${AUTHORIZER_TOKEN}x`, ""]) {
      const response = await ask(body, { bearer });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("catalog-provider-key");
    }
    // The worker's own session credential is not the authorizer's bearer.
    expect((await ask(body, { bearer: claim.session_credential })).status).toBe(
      401,
    );
  });

  test("refuses anything but one small, well-formed request", async () => {
    const claim = await claimed();
    const token = claim.runtime_config.provider.auth.token;
    expect(
      (await ask({ token, purpose: "provider" }, { path: "/" })).status,
    ).toBe(404);
    expect(
      (await ask({ token, purpose: "provider" }, { method: "PUT" })).status,
    ).toBe(404);
    for (const body of [
      "not json",
      { token },
      { token, purpose: "gateway" },
      { token, purpose: "provider", extra: true },
      { token: "", purpose: "provider" },
    ]) {
      expect((await ask(body)).status).toBe(400);
    }
    expect(
      (await ask({ token: "x".repeat(20 * 1024), purpose: "provider" })).status,
    ).toBe(413);
  });

  test("a chunked body is refused at 16 KiB, before the rest is read (94S-388)", async () => {
    let pulled = 0;
    const response = await authorize(
      new Request(`http://authorizer.invalid${EGRESS_AUTHORIZER_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${AUTHORIZER_TOKEN}`,
        },
        // 17 KiB, then a body that never ends.
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            if (pulled <= 17) controller.enqueue(new Uint8Array(1024));
            else return new Promise(() => {});
          },
        }),
      }),
    );
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(18);
  });

  test("an unknown token is 401, and a token for the other route too", async () => {
    const claim = await claimed();
    expect(
      (await ask({ token: "wep_unknown", purpose: "provider" })).status,
    ).toBe(401);
    expect(
      (
        await ask({
          token: claim.runtime_config.provider.auth.token,
          purpose: "repository",
        })
      ).status,
    ).toBe(401);
  });

  test("is not a route on the API's own listener, which workers can reach", async () => {
    const claim = await claimed();
    const app = createApiApp({
      authMode: "api-key",
      registerInternalRoutes: (router) => registerWorkerRoutes(router, gateway),
    });
    for (const path of [
      EGRESS_AUTHORIZER_PATH,
      `/internal${EGRESS_AUTHORIZER_PATH}`,
      `/internal/worker${EGRESS_AUTHORIZER_PATH}`,
    ]) {
      const response = await app.request(path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${AUTHORIZER_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          token: claim.runtime_config.provider.auth.token,
          purpose: "provider",
        }),
      });
      expect(response.status).not.toBe(200);
      expect(await response.text()).not.toContain("catalog-provider-key");
    }
  });
});

describe("usage reports (94S-451)", () => {
  const counts = {
    input_tokens: 0,
    output_tokens: 1_000,
    cache_creation_input_tokens: 0,
    cache_creation_1h_input_tokens: 0,
    cache_read_input_tokens: 0,
    estimated: false,
  };

  async function report(usage: Record<string, unknown>) {
    const claim = await claimed();
    const exchangeId = crypto.randomUUID();
    const response = await ask(
      {
        exchange_id: exchangeId,
        session_id: claim.session_id,
        attempt_id: claim.attempt_id,
        usage: { model: "claude-opus-5", ...counts, ...usage },
      },
      { path: EGRESS_USAGE_PATH },
    );
    const [row] = await db
      .select({
        speed: schema.providerUsage.speed,
        webSearchRequests: schema.providerUsage.webSearchRequests,
        webFetchRequests: schema.providerUsage.webFetchRequests,
        codeExecutionRequests: schema.providerUsage.codeExecutionRequests,
        pricedBy: schema.providerUsage.pricedBy,
      })
      .from(schema.providerUsage)
      .where(eq(schema.providerUsage.exchangeId, exchangeId));
    const [session] = await db
      .select({ costUsd: schema.sessions.costUsd })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, claim.session_id));
    return {
      status: response.status,
      body: await response.json(),
      row,
      sessionCost: session?.costUsd,
    };
  }

  test("a fast call's searches are charged on top of its fast rate, and the ledger row keeps both", async () => {
    // claude-opus-5 fast: $50 out per million; two searches at $0.01.
    expect(
      await report({
        speed: "fast",
        web_search_requests: 2,
        web_fetch_requests: 4,
        code_execution_requests: 1,
      }),
    ).toEqual({
      status: 200,
      body: { cost_usd: 0.07, priced_by: "table" },
      row: {
        speed: "fast",
        webSearchRequests: 2,
        webFetchRequests: 4,
        codeExecutionRequests: 1,
        pricedBy: "table",
      },
      sessionCost: 0.07,
    });
  });

  test("a report from a proxy that does not send the speed is priced high", async () => {
    const { status, body, row } = await report({});
    expect(status).toBe(200);
    expect(body.priced_by).toBe("fallback");
    expect(row).toMatchObject({
      speed: "unknown",
      webSearchRequests: 0,
      pricedBy: "fallback",
    });
  });
});

describe("egressAuthorizerConfigFromEnv", () => {
  test("is off without both variables and refuses half a pair or a weak token", () => {
    expect(egressAuthorizerConfigFromEnv({})).toBeNull();
    expect(
      egressAuthorizerConfigFromEnv({
        EGRESS_AUTHORIZER_PORT: "3100",
        EGRESS_AUTHORIZER_TOKEN: AUTHORIZER_TOKEN,
      }),
    ).toEqual({ hostname: "0.0.0.0", port: 3100, token: AUTHORIZER_TOKEN });
    expect(() =>
      egressAuthorizerConfigFromEnv({ EGRESS_AUTHORIZER_PORT: "3100" }),
    ).toThrow(/set together/);
    expect(() =>
      egressAuthorizerConfigFromEnv({
        EGRESS_AUTHORIZER_TOKEN: AUTHORIZER_TOKEN,
      }),
    ).toThrow(/set together/);
    expect(() =>
      egressAuthorizerConfigFromEnv({
        EGRESS_AUTHORIZER_PORT: "3100",
        EGRESS_AUTHORIZER_TOKEN: "short",
      }),
    ).toThrow(/at least 32/);
    expect(() =>
      egressAuthorizerConfigFromEnv({
        EGRESS_AUTHORIZER_PORT: "http",
        EGRESS_AUTHORIZER_TOKEN: AUTHORIZER_TOKEN,
      }),
    ).toThrow(/not a port/);
  });
});

describe("the object store route's answers (94S-251)", () => {
  const signed = (withSigner = true) =>
    createEgressAuthorizer({
      gateway,
      logger: createLogger({ sinks: [] }),
      token: AUTHORIZER_TOKEN,
      ...(withSigner
        ? {
            objectStore: createObjectRouteSigner({
              bucket: "claude-sessions",
              credentials: {
                accessKeyId: "AKIDCONTROLHOST",
                secretAccessKey: "control-host-secret",
              },
              endpoint: "http://localstack.invalid:4566",
              region: "ap-northeast-1",
            }),
          }
        : {}),
    });
  const objectAsk = (
    authorizer: typeof authorize,
    token: string,
    method: string,
    target: string,
    headers: Array<[string, string]> = [],
  ) =>
    authorizer(
      new Request(`http://authorizer.invalid${EGRESS_AUTHORIZER_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${AUTHORIZER_TOKEN}`,
        },
        body: JSON.stringify({
          token,
          purpose: "object_store",
          request: { method, target, headers },
        }),
      }),
    );

  test("signs a request under the session's prefix with the API's own key", async () => {
    const claim = await claimed();
    const response = await objectAsk(
      signed(),
      claim.object_store.access.token,
      "PUT",
      `/claude-sessions/sessions/${claim.session_id}/x?x-id=PutObject`,
      [
        ["content-length", "4"],
        ["if-none-match", "*"],
      ],
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      upstream: { headers: Array<[string, string]> };
    };
    expect(body).toMatchObject({
      session_id: claim.session_id,
      attempt_id: claim.attempt_id,
      upstream: {
        url: "http://localstack.invalid:4566",
        target: `/claude-sessions/sessions/${claim.session_id}/x`,
      },
    });
    const headers = new Map(body.upstream.headers);
    expect(headers.get("authorization")).toContain(
      "Credential=AKIDCONTROLHOST/",
    );
    expect(headers.get("content-length")).toBe("4");
  });

  test("refuses what the session may not do, with the reason", async () => {
    const claim = await claimed();
    const token = claim.object_store.access.token;
    for (const [method, target] of [
      ["GET", "/claude-sessions/sessions/another-session/x"],
      ["GET", "/claude-sessions?list-type=2&prefix=sessions%2F"],
      ["DELETE", `/claude-sessions/sessions/${claim.session_id}/x`],
      ["PUT", `/claude-sessions/sessions/${claim.session_id}/x?legal-hold`],
    ] as const) {
      const response = await objectAsk(signed(), token, method, target, [
        ["content-length", "0"],
      ]);
      expect(`${method} ${target} ${response.status}`).toBe(
        `${method} ${target} 403`,
      );
      expect(await response.text()).not.toContain("AKIDCONTROLHOST");
    }
  });

  test("each token opens its own route and no other", async () => {
    const claim = await claimed();
    const target = `/claude-sessions/sessions/${claim.session_id}/x`;
    const repository = claim.workspace.repository.access;
    if (repository === undefined) throw new Error("no repository token");
    for (const token of [
      claim.runtime_config.provider.auth.token,
      repository.token,
      "weo_unknown",
    ]) {
      expect((await objectAsk(signed(), token, "GET", target)).status).toBe(
        401,
      );
    }
    expect(
      (
        await ask({
          token: claim.object_store.access.token,
          purpose: "provider",
        })
      ).status,
    ).toBe(401);
  });

  test("an API with no object store answers 503, and only for a live token", async () => {
    const claim = await claimed();
    const target = `/claude-sessions/sessions/${claim.session_id}/x`;
    expect(
      (
        await objectAsk(
          signed(false),
          claim.object_store.access.token,
          "GET",
          target,
        )
      ).status,
    ).toBe(503);
    expect(
      (await objectAsk(signed(false), "weo_unknown", "GET", target)).status,
    ).toBe(401);
  });

  test("refuses a request line it cannot read", async () => {
    const claim = await claimed();
    const token = claim.object_store.access.token;
    const target = `/claude-sessions/sessions/${claim.session_id}/x`;
    expect((await objectAsk(signed(), token, "get", target)).status).toBe(400);
    expect(
      (
        await objectAsk(
          signed(),
          token,
          "GET",
          target,
          Array.from({ length: 33 }, (_, i) => [`x-amz-meta-${i}`, "v"]),
        )
      ).status,
    ).toBe(400);
    expect((await ask({ token, purpose: "object_store" })).status).toBe(400);
  });
});
