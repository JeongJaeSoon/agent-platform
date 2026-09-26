import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BootstrapClaimResponse } from "@agent-platform/contracts";
import {
  createEgressAuthorizer,
  EGRESS_AUTHORIZER_PATH,
} from "@agent-platform/control-host/src/api/egress-authorizer.ts";
import * as schema from "@agent-platform/db";
import {
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
} from "@agent-platform/db";
import {
  type CredentialProxyServer,
  startCredentialProxy,
} from "@agent-platform/egress-proxy/src/credential.ts";
import { createProxyLogger } from "@agent-platform/egress-proxy/src/logger.ts";
import { createLogger } from "@agent-platform/observability";
import {
  acceptAllCheckpoints,
  createWorkerGateway,
  priceProviderUsage,
  type WorkerGateway,
} from "@agent-platform/platform";
import {
  ClaudeSdkRuntime,
  runtimeEnvironment,
} from "@agent-platform/runtime-claude";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
} from "@agent-platform/testkit/fake-anthropic";
import {
  createServedRepository,
  type GitHttpServer,
  startGitHttpServer,
} from "@agent-platform/testkit/git-http";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@agent-platform/testkit/workspace";
import {
  claimSecrets,
  engineProfile,
  GitWorkspace,
  SecretScrubber,
} from "@agent-platform/worker";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

/**
 * 94S-252 end to end, in one process: the real gateway issues a claim, the
 * real authorizer answers the real credential proxy, and the real engine
 * child and the real `git` go through it. What is checked is where the
 * catalog's credentials are and are not: on the upstream's requests, and
 * nowhere in the claim, the engine's environment or the checkout.
 */

const AUTHORIZER_BEARER = `authorizer-${crypto.randomUUID()}`;
const PROFILE_ID = "claude-coding-v1";
const REPOSITORY_HOST = "git.test";
const silentProxy = createProxyLogger("error", () => {});

let client: PGlite | undefined;
let messages: FakeAnthropicServer | undefined;
let repository: GitHttpServer | undefined;
let authorizer: ReturnType<typeof Bun.serve> | undefined;
let proxy: CredentialProxyServer | undefined;
let isolated: IsolatedWorkspace | undefined;
let scratch: string | undefined;

beforeEach(() => {
  client = new PGlite();
});

afterEach(async () => {
  proxy?.stop();
  authorizer?.stop(true);
  messages?.stop();
  await repository?.stop();
  await isolated?.dispose();
  if (scratch !== undefined) {
    await rm(scratch, { force: true, recursive: true });
  }
  await client?.close();
  proxy = undefined;
  authorizer = undefined;
  messages = undefined;
  repository = undefined;
  isolated = undefined;
  scratch = undefined;
});

type Topology = {
  claim: BootstrapClaimResponse;
  gateway: WorkerGateway;
  bootstrapNonce: string;
  credentialUrl: string;
  providerValue: string;
  repositoryPassword: string;
  repositoryUrl: string;
};

async function topology(): Promise<Topology> {
  if (client === undefined) throw new Error("no database");
  const db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: join(import.meta.dir, "..", "packages/db/migrations"),
  });
  const providerValue = `catalog-provider-${crypto.randomUUID()}`;
  const repositoryPassword = `catalog-repository-${crypto.randomUUID()}`;
  const basic = `Basic ${Buffer.from(`reader:${repositoryPassword}`).toString("base64")}`;

  messages = startFakeAnthropicServer(
    textReply("through the credential route"),
  );
  repository = await startGitHttpServer({ authorization: basic });
  await createServedRepository(repository, "app", {
    "README.md": "hello\n",
  });
  const repositoryUrl = `http://${REPOSITORY_HOST}:${repository.port}/app.git`;

  const gateway = createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog: {
      profiles: {
        [PROFILE_ID]: {
          runtime_kind: "claude_agent_sdk",
          runtime_version: "0.3.270",
          model: "claude-sonnet-4-5",
          tools: [],
          permission_mode: "default",
          provider: {
            kind: "anthropic",
            endpoint: messages.url,
            auth: {
              kind: "api_key",
              value: providerValue,
              ref: { value_env: "PROVIDER_KEY" },
            },
          },
        },
      },
      repositories: {
        app: {
          url: repositoryUrl,
          branch: "main",
          profiles: [PROFILE_ID],
          auth: {
            kind: "basic",
            username: "reader",
            value: repositoryPassword,
            ref: { value_env: "REPOSITORY_PASSWORD" },
          },
        },
      },
    },
    checkpoints: acceptAllCheckpoints,
    options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 60_000 },
  });
  authorizer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createEgressAuthorizer({
      gateway,
      logger: createLogger({ sinks: [] }),
      token: AUTHORIZER_BEARER,
    }),
  });
  const upstreams = [
    { host: "127.0.0.1", port: Number(new URL(messages.url).port) },
    { host: REPOSITORY_HOST, port: repository.port },
  ];
  proxy = startCredentialProxy({
    authorizer: {
      url: `http://127.0.0.1:${authorizer.port}`,
      token: AUTHORIZER_BEARER,
    },
    hostname: "127.0.0.1",
    logger: silentProxy,
    policy: { allow: [], allowPrivate: upstreams },
    port: 0,
    resolve: async (host) =>
      isIP(host) !== 0 ? [host] : host === REPOSITORY_HOST ? ["127.0.0.1"] : [],
  });

  const accepted = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
    principal: { ownerId: "owner-a" },
    idempotencyKey: crypto.randomUUID(),
    payloadHash: "hash",
    profileId: PROFILE_ID,
    repository: { id: "app", url: repositoryUrl, branch: "main" },
    message: "hello",
  });
  if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
  const launch = await gateway.registerLaunch({
    executionId: "exec-1",
    generation: 1,
    backend: "local_docker",
  });
  if (launch.nonce === null) throw new Error("launch already registered");
  const claim = await gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: "exec-1",
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: launch.nonce },
    },
  );
  return {
    claim,
    gateway,
    bootstrapNonce: launch.nonce,
    credentialUrl: `http://127.0.0.1:${proxy.port}`,
    providerValue,
    repositoryPassword,
    repositoryUrl,
  };
}

/** One engine turn through the credential route, as a worker runs it. */
async function engineTurn(
  claim: BootstrapClaimResponse,
  credentialUrl: string,
) {
  isolated = await createIsolatedWorkspace({ prefix: "94s-252-" });
  const profile = engineProfile(
    claim.runtime_config.provider,
    claim.principal.owner_scope,
    credentialUrl,
  );
  const config = {
    claudeConfigDir: isolated.home,
    correlationId: "94s-252",
    cwd: isolated.workspace,
    home: isolated.home,
    maxTurns: 1,
    mode: "new" as const,
    model: claim.runtime_config.model,
    profile,
    settingSources: [] as [],
    tools: [],
  };
  const environment = runtimeEnvironment(config, { PATH: process.env.PATH });
  const run = new ClaudeSdkRuntime({
    endpoints: [claim.runtime_config.provider.endpoint],
    models: [claim.runtime_config.model],
  }).start(config, {
    onPermission: async () => ({ behavior: "deny", message: "no tools" }),
  });
  run.send({ message: "hello through the route", uuid: crypto.randomUUID() });
  run.finishInput();
  const results: Array<Record<string, unknown>> = [];
  for await (const frame of run) {
    const message = frame.envelope.message as Record<string, unknown>;
    if (message.type === "result") results.push(message);
  }
  return { environment, results };
}

/** The session's cost once `rows` metered calls have been recorded. */
async function meteredCost(sessionId: string, rows: number) {
  if (client === undefined) throw new Error("no database");
  const db = drizzle(client, { schema });
  const by = performance.now() + 10_000;
  for (;;) {
    const recorded = await db
      .select({ costUsd: schema.providerUsage.costUsd })
      .from(schema.providerUsage)
      .where(eq(schema.providerUsage.sessionId, sessionId));
    if (recorded.length >= rows) {
      const [session] = await db
        .select({ costUsd: schema.sessions.costUsd })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId));
      return {
        session: session?.costUsd,
        metered: recorded.reduce((sum, row) => sum + row.costUsd, 0),
      };
    }
    if (performance.now() > by) throw new Error("usage never recorded");
    await Bun.sleep(20);
  }
}

describe("credential routes end to end (94S-252)", () => {
  test("AC1: the engine's Messages call gets the provider key only at the proxy", async () => {
    const { claim, credentialUrl, providerValue } = await topology();
    if (messages === undefined) throw new Error("no Messages server");
    // Nothing the worker is handed carries the key.
    expect(JSON.stringify(claim)).not.toContain(providerValue);
    expect(claim.runtime_config.provider.auth.kind).toBe("egress_token");

    const { environment, results } = await engineTurn(claim, credentialUrl);
    expect(JSON.stringify(environment)).not.toContain(providerValue);
    expect(environment.ANTHROPIC_BASE_URL).toBe(`${credentialUrl}/provider`);
    expect(results).toHaveLength(1);

    // The upstream saw the catalog's key and never the attempt's token.
    expect(messages.requests.length).toBeGreaterThan(0);
    for (const request of messages.requests) {
      expect(request.headers["x-api-key"]).toBe(providerValue);
      expect(JSON.stringify(request.headers)).not.toContain(
        claim.runtime_config.provider.auth.token,
      );
    }
  }, 60_000);

  test("AC2: the repository is cloned through the route and stored without userinfo", async () => {
    const { claim, credentialUrl, repositoryPassword, repositoryUrl } =
      await topology();
    if (repository === undefined) throw new Error("no repository server");
    expect(JSON.stringify(claim)).not.toContain(repositoryPassword);
    const access = claim.workspace.repository.access;
    if (access === undefined) throw new Error("no repository token");

    scratch = await mkdtemp(join(tmpdir(), "94s-252-clone-"));
    const root = join(scratch, "workspace");
    const action = await new GitWorkspace(root, credentialUrl).prepare({
      descriptor: claim.workspace,
      restore: null,
      signal: AbortSignal.timeout(60_000),
    });
    expect(action).toBe("clone");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("hello\n");

    const config = await readFile(join(root, ".git", "config"), "utf8");
    // The repository's own URL, no userinfo, and neither credential.
    expect(config).toContain(`url = ${repositoryUrl}`);
    expect(config).not.toContain("@");
    expect(config).not.toContain(access.token);
    expect(config).not.toContain(repositoryPassword);
    expect(config).not.toContain(credentialUrl);

    // Every request the repository answered carried the catalog's login,
    // and only upload-pack was asked for.
    const served = repository.requests;
    expect(served.length).toBeGreaterThan(0);
    for (const request of served) {
      expect(request.authorization).toStartWith("Basic ");
      expect(request.path).toMatch(
        /^\/app\.git\/(info\/refs\?service=git-upload-pack|git-upload-pack)$/,
      );
    }
  }, 60_000);

  test("AC3: a real shell dumping the engine's environment and the remote shows no catalog value, and the scrubber takes the rest (Codex R2)", async () => {
    const {
      claim,
      bootstrapNonce,
      credentialUrl,
      providerValue,
      repositoryPassword,
    } = await topology();
    scratch = await mkdtemp(join(tmpdir(), "94s-252-dump-"));
    const root = join(scratch, "workspace");
    await new GitWorkspace(root, credentialUrl).prepare({
      descriptor: claim.workspace,
      restore: null,
      signal: AbortSignal.timeout(60_000),
    });
    // What a Bash tool call in the engine sees: the engine's own
    // environment, in the checkout the worker prepared.
    const environment = runtimeEnvironment(
      {
        claudeConfigDir: join(scratch, "home"),
        correlationId: "94s-252",
        cwd: root,
        home: join(scratch, "home"),
        maxTurns: 1,
        mode: "new",
        model: claim.runtime_config.model,
        profile: engineProfile(
          claim.runtime_config.provider,
          claim.principal.owner_scope,
          credentialUrl,
        ),
        settingSources: [],
        tools: [],
      },
      { PATH: process.env.PATH },
    );
    const dump = spawnSync(
      "sh",
      ["-c", "env; git remote -v; git config --list --show-origin"],
      { cwd: root, env: environment, encoding: "utf8" },
    );
    expect(dump.status).toBe(0);
    const printed = `${dump.stdout}${dump.stderr}`;
    expect(printed).toContain("origin");

    // The catalog's credentials are not there to print at all.
    expect(printed).not.toContain(providerValue);
    expect(printed).not.toContain(repositoryPassword);
    // Nor is the engine's own token: it goes down a descriptor the engine
    // closes (94S-410). Whatever else of the attempt's a tool finds, the
    // scrubber the worker puts in front of its events removes.
    const held = claimSecrets(claim, bootstrapNonce);
    expect(printed).not.toContain(claim.runtime_config.provider.auth.token);
    const scrubbed = new SecretScrubber(held).scrub(printed);
    for (const value of held) {
      if (value !== undefined) expect(scrubbed).not.toContain(value);
    }
  }, 60_000);

  test("94S-394: a direct call on the engine's token stops once the session has spent its limit", async () => {
    const { claim, credentialUrl } = await topology();
    if (client === undefined || messages === undefined) {
      throw new Error("no topology");
    }
    const direct = () =>
      fetch(`${credentialUrl}/provider/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": claim.runtime_config.provider.auth.token,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: claim.runtime_config.model,
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
    const within = await direct();
    expect(within.status).toBe(200);
    await within.text();
    const served = messages.requests.length;
    await drizzle(client, { schema })
      .update(schema.sessions)
      .set({ costUsd: 1_000 })
      .where(eq(schema.sessions.id, claim.session_id));
    const over = await direct();
    expect(over.status).toBe(403);
    await over.text();
    expect(messages.requests).toHaveLength(served);
  }, 60_000);

  test("94S-409: a tool's direct call on the engine's token is metered into the session's cost", async () => {
    const { claim, credentialUrl } = await topology();
    const direct = await fetch(`${credentialUrl}/provider/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": claim.runtime_config.provider.auth.token,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: claim.runtime_config.model,
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(direct.status).toBe(200);
    await direct.text();

    // The fake answers with one input and four output tokens.
    const { costUsd } = priceProviderUsage({
      model: claim.runtime_config.model,
      inputTokens: 1,
      outputTokens: 4,
      cacheCreationInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    expect(costUsd).toBeGreaterThan(0);
    expect(await meteredCost(claim.session_id, 1)).toEqual({
      session: costUsd,
      metered: costUsd,
    });
  }, 60_000);

  test("94S-409: an engine turn is counted once: the session's cost is what the proxy metered, and finalize adds nothing", async () => {
    const { claim, gateway, credentialUrl } = await topology();
    if (messages === undefined) throw new Error("no Messages server");
    const principal = {
      kind: "session" as const,
      sessionId: claim.session_id,
      attemptId: claim.attempt_id,
      leaseEpoch: claim.lease_epoch,
      executionGeneration: claim.execution_generation,
      authRevision: claim.auth_revision,
    };
    const scope = (turnId: string | null) => ({
      session_id: claim.session_id,
      turn_id: turnId,
      attempt_id: claim.attempt_id,
      lease_epoch: claim.lease_epoch,
      execution_generation: claim.execution_generation,
      auth_revision: claim.auth_revision,
    });
    const next = await gateway.nextInput(principal, scope(null));
    const turnId = next.input?.turn_id ?? null;
    expect(turnId).not.toBeNull();

    const { results } = await engineTurn(claim, credentialUrl);
    const sdkCost = results[0]?.total_cost_usd;
    if (typeof sdkCost !== "number") throw new Error("no engine cost");
    const calls = messages.requests.filter((request) =>
      request.path.startsWith("/v1/messages?"),
    ).length;
    expect(calls).toBeGreaterThan(0);
    const metered = await meteredCost(claim.session_id, calls);

    await gateway.finalize(principal, {
      ...scope(turnId),
      turn_id: turnId ?? "",
      finalize_key: "fin-1",
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
        cost_usd: sdkCost,
      },
      checkpoint: null,
    });

    const settled = await meteredCost(claim.session_id, calls);
    expect(settled.session).toBe(metered.metered);
    expect(settled.metered).toBe(metered.metered);
    // The engine priced the same calls the same way.
    expect(settled.session).toBeCloseTo(sdkCost, 6);
  }, 60_000);

  test("the route refuses a token for the other purpose and one it never issued", async () => {
    const { claim, credentialUrl } = await topology();
    const providerHeld = claim.runtime_config.provider.auth.token;
    const refs = await fetch(
      `${credentialUrl}/repository/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${providerHeld}` } },
    );
    expect(refs.status).toBe(401);
    const unknown = await fetch(`${credentialUrl}/provider/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "wep_never-issued" },
      body: "{}",
    });
    expect(unknown.status).toBe(401);
    expect(messages?.requests).toEqual([]);
    expect(repository?.requests).toEqual([]);
    // The authorizer answers only its own bearer, on its own listener.
    const direct = await fetch(
      `http://127.0.0.1:${authorizer?.port}${EGRESS_AUTHORIZER_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: providerHeld, purpose: "provider" }),
      },
    );
    expect(direct.status).toBe(401);
  }, 60_000);
});
