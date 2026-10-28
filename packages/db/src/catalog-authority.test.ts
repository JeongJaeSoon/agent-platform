import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  type CatalogProfile,
  catalogRevision,
  createAuthorizationPolicy,
  createSessionService,
  createWorkerGateway,
  type SessionCatalog,
  type WorkerGateway,
  WorkerGatewayError,
  withSeededInstallation,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  activateCatalogRevision,
  activeCatalogRevision,
} from "./catalog-authority.ts";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  catalogAuthority,
  executions,
  installationProfiles,
  sessions,
  unassignedSessions,
  users,
  workerLaunches,
} from "./schema.ts";
import { launchSession, type TestLaunch } from "./testing/launches.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

/**
 * two API replicas mid-rollout share one database, each with the
 * catalog it started with. A session whose pair only the newer catalog knows
 * — or that the newer one dropped — must not be failed by whichever replica
 * happens to answer its launch's claim: only the catalog an operator
 * activated may say the pair is gone.
 */

const PROFILE_ID = "claude-coding-v1";
const OWNER = testCaller("owner-a");

const PROFILE: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read"],
  permission_mode: "default",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};

function repository(name: string) {
  return {
    url: `https://example.invalid/${name}.git`,
    branch: "main",
    profiles: [PROFILE_ID],
  };
}

// What the session was created under.
const CREATED: SessionCatalog = withSeededInstallation({
  profiles: { [PROFILE_ID]: PROFILE },
  repositories: { "sample-app": repository("sample-app") },
});
// Two catalogs that both lack the session's pair and differ otherwise, as
// an old replica's and a new one's do.
const A: SessionCatalog = withSeededInstallation({
  profiles: { [PROFILE_ID]: PROFILE },
  repositories: { "other-app": repository("other-app") },
});
const B: SessionCatalog = withSeededInstallation({
  profiles: { [PROFILE_ID]: PROFILE },
  repositories: {
    "other-app": repository("other-app"),
    "third-app": repository("third-app"),
  },
});

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

function gatewayOf(catalog: SessionCatalog): WorkerGateway {
  return createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog,
    checkpoints: {
      async verify() {
        return { status: "verified" };
      },
    },
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 60_000,
    },
  });
}

async function createSession(): Promise<string> {
  const service = createSessionService({
    authorization: createAuthorizationPolicy(),
    inputs: createPostgresSessionUnitOfWork(db),
    controls: createPostgresSessionControl(db),
    reader: createPostgresSessionReader(db),
    catalog: CREATED,
    limits: {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
  });
  const created = await service.createSession(OWNER, {
    idempotencyKey: crypto.randomUUID(),
    body: {
      profile_id: PROFILE_ID,
      repository_id: "sample-app",
      message: "hello",
    },
  });
  return created.session_id;
}

function claim(gateway: WorkerGateway, launch: TestLaunch) {
  return gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: launch.executionId,
      execution_generation: launch.generation,
      credential: { kind: "launch_nonce", nonce: launch.nonce },
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

async function stateOf(sessionId: string, executionId: string) {
  const [session] = await db
    .select({
      status: sessions.status,
      admissionState: sessions.admissionState,
      executionId: sessions.executionId,
      revision: sessions.revision,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  const [launch] = await db
    .select({
      launchFailureCount: workerLaunches.launchFailureCount,
      lastLaunchError: workerLaunches.lastLaunchError,
      nonceHash: workerLaunches.nonceHash,
      slotReleasedAt: workerLaunches.slotReleasedAt,
    })
    .from(workerLaunches)
    .where(eq(workerLaunches.executionId, executionId));
  const [execution] = await db
    .select({ desiredState: executions.desiredState })
    .from(executions)
    .where(eq(executions.id, executionId));
  const signals = await db
    .select()
    .from(unassignedSessions)
    .where(eq(unassignedSessions.sessionId, sessionId));
  return { session, launch, execution, signalled: signals.length === 1 };
}

describe("catalog authority", () => {
  test("the catalogs under test are distinct revisions", () => {
    expect(catalogRevision(A)).not.toBe(catalogRevision(B));
  });

  test("with no revision activated there is one replica: a host missing the pair fails the pinned session at once, and nothing activates itself", async () => {
    const sessionId = await createSession();
    const gateway = gatewayOf(A);
    expect(
      await refusal(claim(gateway, await launchSession(db, { sessionId }))),
    ).toEqual({ status: 409, code: "CATALOG_MISMATCH" });
    expect(await activeCatalogRevision(db)).toBeNull();
    expect(await db.select().from(catalogAuthority)).toEqual([]);
  });

  test("only the host running the activated revision fails the session; another writes nothing and answers nothing to claim", async () => {
    const sessionId = await createSession();
    const activated = await activateCatalogRevision(db, {
      revision: catalogRevision(B),
      expected: null,
    });
    expect(activated.outcome).toBe("activated");

    const old = gatewayOf(A);
    const launch = await launchSession(db, { sessionId });
    const before = await stateOf(sessionId, launch.executionId);
    expect(await refusal(claim(old, launch))).toEqual({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(await stateOf(sessionId, launch.executionId)).toEqual(before);
    expect(before.session?.status).toBe("queued");
    expect(before.launch?.launchFailureCount).toBe(0);
    expect(before.signalled).toBe(true);

    // The same launch, answered by the authority.
    expect(await refusal(claim(gatewayOf(B), launch))).toEqual({
      status: 409,
      code: "CATALOG_MISMATCH",
    });
    const after = await stateOf(sessionId, launch.executionId);
    expect(after.session?.status).toBe("failed");
    expect(after.launch?.launchFailureCount).toBe(1);
    expect(after.launch?.nonceHash).toBeNull();
    expect(after.execution?.desiredState).toBe("terminated");
  });

  test("a ceiling blocked in its row fails its sessions, though the block moved the host off the activated revision", async () => {
    const activated = await activateCatalogRevision(db, {
      revision: catalogRevision(CREATED),
      expected: null,
    });
    expect(activated.outcome).toBe("activated");
    // What the registry reads once the row is blocked: the ceiling runs
    // nothing, so it leaves the revision.
    const blocked: SessionCatalog = {
      ...CREATED,
      profiles: {},
      installation: new Map([
        [
          PROFILE_ID,
          {
            id: PROFILE_ID,
            origin: "catalog",
            state: "blocked",
            repository_ids: ["sample-app"],
          },
        ],
      ]),
    };
    expect(catalogRevision(blocked)).not.toBe(catalogRevision(CREATED));
    const ownerId = crypto.randomUUID();
    await db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.invalid`,
      displayName: "owner",
    });
    await db.insert(installationProfiles).values({
      id: PROFILE_ID,
      version: 1,
      origin: "catalog",
      definition: { permission_mode: "default" },
      permissionMode: "default",
      fingerprint: "sha256:test",
      repositoryIds: ["sample-app"],
    });

    // The row not blocked: this host is off the activated revision and
    // leaves the session alone.
    const left = await createSession();
    const leftLaunch = await launchSession(db, { sessionId: left });
    const before = await stateOf(left, leftLaunch.executionId);
    expect(await refusal(claim(gatewayOf(blocked), leftLaunch))).toEqual({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(await stateOf(left, leftLaunch.executionId)).toEqual(before);

    await db
      .update(installationProfiles)
      .set({ blockedAt: new Date(), blockedBy: ownerId });
    const sessionId = await createSession();
    const launch = await launchSession(db, { sessionId });
    expect(await refusal(claim(gatewayOf(blocked), launch))).toEqual({
      status: 409,
      code: "CATALOG_MISMATCH",
    });
    const after = await stateOf(sessionId, launch.executionId);
    expect(after.session?.status).toBe("failed");
    expect(after.execution?.desiredState).toBe("terminated");
  });

  test("activation is a compare-and-swap on the revision it replaces", async () => {
    const a = catalogRevision(A);
    const b = catalogRevision(B);
    const first = await activateCatalogRevision(db, {
      revision: a,
      expected: null,
    });
    if (first.outcome !== "activated") throw new Error(first.outcome);
    expect(first.authority.revision).toBe(a);

    // Someone else activated first: "none" is no longer what is there.
    expect(
      await activateCatalogRevision(db, { revision: b, expected: null }),
    ).toEqual({ outcome: "conflict", current: first.authority });
    expect(
      await activateCatalogRevision(db, { revision: b, expected: b }),
    ).toEqual({ outcome: "conflict", current: first.authority });

    const second = await activateCatalogRevision(db, {
      revision: b,
      expected: a,
    });
    if (second.outcome !== "activated") throw new Error(second.outcome);
    expect(second.authority.revision).toBe(b);
    expect(second.authority.activatedAt.getTime()).toBeGreaterThanOrEqual(
      first.authority.activatedAt.getTime(),
    );
    expect(await activeCatalogRevision(db)).toEqual(second.authority);
    // Rolled back the same way.
    expect(
      (await activateCatalogRevision(db, { revision: a, expected: b })).outcome,
    ).toBe("activated");
  });
});
