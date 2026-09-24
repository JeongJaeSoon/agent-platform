import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type CatalogProfile,
  createSessionService,
  createWorkerGateway,
  ownerScopedPolicy,
  profileFingerprint,
  type SessionCatalog,
  type WorkerGateway,
  WorkerGatewayError,
} from "@agent-platform/platform";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  executions,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

/**
 * 94S-253: a session is held to the profile settings it was accepted with.
 * Two gateways share one database, as two API replicas mid-rollout would,
 * each with its own catalog: one that defines the same profile id with other
 * settings binds nothing, while one that differs only in the credential
 * value behind the same reference binds and routes with the new value.
 */

const PROFILE_ID = "claude-coding-v1";
const REPOSITORY = {
  url: "https://example.invalid/app.git",
  branch: "main",
};
const OWNER = { ownerId: "owner-a" };

function profile(
  overrides: Partial<Omit<CatalogProfile, "provider">> & { key?: string } = {},
): CatalogProfile {
  const { key = "provider-key-one", ...settings } = overrides;
  return {
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    model: "claude-sonnet-5",
    tools: ["Read"],
    permission_mode: "default",
    ...settings,
    provider: {
      kind: "litellm",
      endpoint: "https://litellm.invalid",
      auth: { kind: "api_key", value: key, ref: { value_env: "PROVIDER_KEY" } },
    },
  };
}

function catalogOf(entry: CatalogProfile): SessionCatalog {
  return {
    profiles: { [PROFILE_ID]: entry },
    repositories: {
      "sample-app": { ...REPOSITORY, profiles: [PROFILE_ID] },
    },
  };
}

const ORIGINAL = catalogOf(profile());
const ROTATED = catalogOf(profile({ key: "provider-key-two" }));
// A wider grant under the same id: what must not run an existing session.
const WIDENED = catalogOf(
  profile({ tools: ["Read", "Bash"], permission_mode: "acceptEdits" }),
);

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
});

afterEach(async () => {
  await client.close();
});

function serviceOf(catalog: SessionCatalog) {
  return createSessionService({
    authorization: ownerScopedPolicy,
    inputs: createPostgresSessionUnitOfWork(db),
    controls: createPostgresSessionControl(db),
    reader: createPostgresSessionReader(db),
    catalog,
    limits: {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
    },
  });
}

function gatewayOf(catalog: SessionCatalog): WorkerGateway {
  return createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog,
    checkpoints: {
      async verify() {
        return { status: "verified" };
      },
    },
    options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 60_000 },
  });
}

async function createSession(catalog: SessionCatalog): Promise<string> {
  const created = await serviceOf(catalog).createSession(OWNER, {
    idempotencyKey: crypto.randomUUID(),
    body: {
      profile_id: PROFILE_ID,
      repository_id: "sample-app",
      message: "hello",
    },
  });
  return created.session_id;
}

async function storedFingerprint(sessionId: string) {
  const [row] = await db
    .select({ fingerprint: sessions.profileFingerprint })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return row?.fingerprint;
}

/**
 * A launch as the scheduler reserves one. `pinned` makes it the session's
 * own, the way the scheduler's reservation does; otherwise it is a pool
 * launch that claims whatever its host may run.
 */
async function launch(
  gateway: WorkerGateway,
  sessionId: string,
  pinned: boolean,
) {
  const executionId = `exec-${crypto.randomUUID()}`;
  const registered = await gateway.registerLaunch({
    executionId,
    generation: 1,
    backend: "local_docker",
    ...(pinned ? { sessionId } : {}),
  });
  if (registered.nonce === null) throw new Error("launch already registered");
  if (pinned) {
    await db.insert(executions).values({
      backend: "local_docker",
      desiredState: "running",
      generation: 1,
      id: executionId,
      observedState: "running",
      sessionId,
    });
    await db
      .update(sessions)
      .set({ executionId })
      .where(eq(sessions.id, sessionId));
  }
  return { executionId, nonce: registered.nonce };
}

function claim(
  gateway: WorkerGateway,
  l: { executionId: string; nonce: string },
) {
  return gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: l.executionId,
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    },
  );
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkerGatewayError) {
      return { status: error.status, code: error.code };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("profile fingerprint pinned at create (94S-253)", () => {
  test("create stores the fingerprint of the profile as the catalog defined it, never the credential", async () => {
    const sessionId = await createSession(ORIGINAL);
    const stored = await storedFingerprint(sessionId);
    expect(stored).toBe(profileFingerprint(profile()));
    expect(stored).not.toContain("provider-key-one");
    // The value is not part of it: a rotated key hashes the same.
    expect(stored).toBe(
      profileFingerprint(profile({ key: "provider-key-two" })),
    );
  });

  test("a gateway whose catalog defines the id with other settings binds nothing, and the one it was created under does", async () => {
    const sessionId = await createSession(ORIGINAL);
    const widened = gatewayOf(WIDENED);
    expect(
      await refusal(claim(widened, await launch(widened, sessionId, false))),
    ).toEqual({
      status: 404,
      code: "NOT_FOUND",
    });
    // Its reader says why, from the same comparison.
    const detail = await serviceOf(WIDENED).getSession(OWNER, sessionId);
    expect(detail.attention?.code).toBe("CATALOG_MISMATCH");
    expect(
      (await serviceOf(ORIGINAL).getSession(OWNER, sessionId)).attention,
    ).toBeNull();

    const original = gatewayOf(ORIGINAL);
    const claimed = await claim(
      original,
      await launch(original, sessionId, false),
    );
    expect(claimed.session_id).toBe(sessionId);
    expect(claimed.profile_fingerprint).toBe(profileFingerprint(profile()));
    expect(claimed.runtime_config.tools).toEqual(["Read"]);
    expect(claimed.runtime_config.permission_mode).toBe("default");
  });

  test("a launch reserved for the session on a host with other settings fails the session with CATALOG_MISMATCH naming the settings", async () => {
    const sessionId = await createSession(ORIGINAL);
    const widened = gatewayOf(WIDENED);
    expect(
      await refusal(claim(widened, await launch(widened, sessionId, true))),
    ).toEqual({
      status: 409,
      code: "CATALOG_MISMATCH",
    });
    const detail = await serviceOf(ORIGINAL).getSession(OWNER, sessionId);
    expect(detail.status).toBe("failed");
    const [row] = await db
      .select({ podId: sessions.podId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(row?.podId).toBeNull();
    const [given] = await db
      .select({ error: workerLaunches.lastLaunchError })
      .from(workerLaunches)
      .where(eq(workerLaunches.sessionId, sessionId));
    expect(given?.error).toBe(
      `profile ${PROFILE_ID} has other settings in this host's catalog than the session was created with`,
    );
  });

  test("a replay through a host with other settings is refused before it rotates the token", async () => {
    const sessionId = await createSession(ORIGINAL);
    const original = gatewayOf(ORIGINAL);
    const l = await launch(original, sessionId, false);
    const first = await claim(original, l);
    expect(await refusal(claim(gatewayOf(WIDENED), l))).toEqual({
      status: 409,
      code: "BACKEND_UNAVAILABLE",
    });
    // Nothing moved: the first token still authenticates.
    const principal = await original.authenticate(first.session_credential);
    expect(principal).toMatchObject({
      kind: "session",
      sessionId,
      authRevision: first.auth_revision,
    });
  });

  test("only the credential is taken at claim: a rotated value behind the same reference binds and reaches the provider route", async () => {
    const sessionId = await createSession(ORIGINAL);
    const rotated = gatewayOf(ROTATED);
    const claimed = await claim(
      rotated,
      await launch(rotated, sessionId, false),
    );
    expect(claimed.session_id).toBe(sessionId);
    const auth = claimed.runtime_config.provider.auth;
    if (auth.kind !== "egress_token") throw new Error(auth.kind);
    const grant = await rotated.authorizeEgress({
      token: auth.token,
      purpose: "provider",
    });
    expect(grant.upstream.headers).toEqual([["x-api-key", "provider-key-two"]]);
  });

  test("a row from before the column, bound before it, replays only under the settings its first claim issued the provider token for", async () => {
    const sessionId = await createSession(ORIGINAL);
    const original = gatewayOf(ORIGINAL);
    const l = await launch(original, sessionId, false);
    const first = await claim(original, l);
    // As a claim made before 0119 left it: bound, nothing pinned.
    await db
      .update(sessions)
      .set({ profileFingerprint: null })
      .where(eq(sessions.id, sessionId));

    expect(await refusal(claim(gatewayOf(WIDENED), l))).toEqual({
      status: 409,
      code: "BACKEND_UNAVAILABLE",
    });
    expect(await storedFingerprint(sessionId)).toBeNull();
    expect(await original.authenticate(first.session_credential)).toMatchObject(
      { kind: "session", sessionId, authRevision: first.auth_revision },
    );

    const replayed = await claim(original, l);
    expect(replayed.auth_revision).toBe(first.auth_revision + 1);
    expect(await storedFingerprint(sessionId)).toBe(
      profileFingerprint(profile()),
    );
  });

  test("a row from before the column is pinned by its first claim", async () => {
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: OWNER.ownerId,
      profileId: PROFILE_ID,
      repositoryId: "sample-app",
      repoUrl: REPOSITORY.url,
      branch: REPOSITORY.branch,
    });
    await db
      .insert(turns)
      .values({ sessionId, sequence: 1, message: "hello", status: "queued" });
    await db.insert(unassignedSessions).values({ sessionId });
    expect(await storedFingerprint(sessionId)).toBeNull();

    const widened = gatewayOf(WIDENED);
    await claim(widened, await launch(widened, sessionId, false));
    expect(await storedFingerprint(sessionId)).toBe(
      profileFingerprint(WIDENED.profiles[PROFILE_ID] as CatalogProfile),
    );
  });
});
