import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { createSessionResponseSchema } from "@agent-platform/contracts";
import { createApiApp } from "@agent-platform/control-host/src/api/app.ts";
import { registerSessionRoutes } from "@agent-platform/control-host/src/api/routes/sessions.ts";
import { registerWorkerRoutes } from "@agent-platform/control-host/src/api/routes/worker.ts";
import * as schema from "@agent-platform/db";
import {
  attempts,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
  unassignedSessions,
} from "@agent-platform/db";
import { createLogger } from "@agent-platform/observability";
import {
  createSessionService,
  createWorkerGateway,
  ownerScopedPolicy,
  type SessionCatalog,
  type WorkerGateway,
} from "@agent-platform/platform";
import { FakeAgentRuntime } from "@agent-platform/runtime-claude";
import { createTempDatabase, type TempDatabase } from "@agent-platform/testkit";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { WorkerCheckpointPort } from "../apps/worker/src/checkpoint.ts";
import { HttpWorkerGatewayClient } from "../apps/worker/src/gateway-client.ts";
import {
  WorkerHost,
  type WorkerLogger,
} from "../apps/worker/src/worker-host.ts";
import { noWorkspace } from "../apps/worker/src/workspace.ts";

/**
 * 94S-322 end to end in one process: a WorkerHost holding a lease from the
 * Worker Gateway's own HTTP routes on PostgreSQL. The wall clock jumps both
 * ways without the worker's lease judgement moving, and once the gateway
 * becomes unreachable the worker gives the lease up — and its engine — a
 * safety margin before the database would end it. This is the clock
 * skew/jump row of 94S-135's fault table, at test scale.
 */
const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const PROFILE_ID = "claude-coding-v1";
const LEASE_TTL_MS = 10_000;
const MARGIN_MS = 3_000;
const HEARTBEAT_MS = 300;

const catalog: SessionCatalog = {
  profiles: {
    [PROFILE_ID]: {
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: [],
      permission_mode: "default",
      provider: {
        kind: "litellm",
        endpoint: "https://litellm.invalid",
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
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: [PROFILE_ID],
    },
  },
};

const noCheckpoints: WorkerCheckpointPort = {
  restorePlan: async () => ({ mode: "new" }),
  capture: async () => null,
};

async function until(
  done: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await done()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

integration("worker lease on the monotonic clock end to end", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;
  let server: ReturnType<typeof Bun.serve>;
  const owner = `owner-${crypto.randomUUID()}`;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "lease_clock_e2e" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    const logger = createLogger({ sinks: [] });
    const sessions = createSessionService({
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
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog,
      checkpoints: { verify: async () => ({ status: "verified" }) },
      pending: createPostgresWorkerPendingStore(db),
      options: { leaseTtlMs: LEASE_TTL_MS, sessionCostLimitUsd: 1_000 },
    });
    const app = createApiApp({
      authMode: "none",
      logger,
      registerRoutes: (router) => registerSessionRoutes(router, sessions),
      registerInternalRoutes: (router) => registerWorkerRoutes(router, gateway),
    });
    server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) });
  }, 90_000);

  afterAll(async () => {
    setSystemTime();
    server?.stop(true);
    await pool?.end();
    await database?.drop();
  }, 90_000);

  async function dbNowMs(): Promise<number> {
    const [row] = await db
      .select({
        ms: sql<string>`(extract(epoch from clock_timestamp()) * 1000)::text`,
      })
      .from(sql`(SELECT 1) AS one`);
    return Number(row?.ms);
  }

  async function leaseOf(attemptId: string): Promise<number> {
    const [row] = await db
      .select({ leaseExpiresAt: attempts.leaseExpiresAt })
      .from(attempts)
      .where(eq(attempts.id, attemptId));
    if (row === undefined) throw new Error(`no attempt ${attemptId}`);
    return row.leaseExpiresAt.getTime();
  }

  test("a wall clock jump moves nothing; an unreachable gateway loses the lease a margin before the database does", async () => {
    const created = await fetch(`http://127.0.0.1:${server.port}/v1/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-Owner-Id": owner,
      },
      body: JSON.stringify({
        profile_id: PROFILE_ID,
        repository_id: "sample-app",
        message: "long task",
      }),
    });
    expect(created.status).toBe(201);
    const sessionId = createSessionResponseSchema.parse(
      await created.json(),
    ).session_id;
    const partition = `lease-clock-${crypto.randomUUID()}`;
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));
    const executionId = `exec-${crypto.randomUUID()}`;
    const launch = await gateway.registerLaunch({
      executionId,
      generation: 1,
      partition,
      backend: "local_docker",
    });
    if (launch.nonce === null) throw new Error("launch already registered");

    // The first turn runs for a minute: only the lease can end this attempt.
    const runtime = new FakeAgentRuntime([
      { type: "await-input" },
      { type: "delay", delayMs: 60_000 },
    ]);
    let unreachable = false;
    let refusedBeats = 0;
    let attemptId: string | undefined;
    const lost: {
      value?: {
        at: number;
        reason: string;
        lease: Promise<number>;
      };
    } = {};
    const logger: WorkerLogger = {
      info: (event, fields) => {
        if (event === "worker.claimed") {
          attemptId = String(fields?.attempt_id);
        }
        if (event === "worker.stopping" && fields?.kind === "lost") {
          lost.value = {
            at: performance.now(),
            reason: String(fields?.reason),
            lease: leaseOf(attemptId ?? ""),
          };
        }
      },
      warn: () => {},
      error: () => {},
    };
    const host = new WorkerHost({
      checkpoints: noCheckpoints,
      execution: {
        bootstrapNonce: launch.nonce,
        generation: 1,
        id: executionId,
      },
      gateway: new HttpWorkerGatewayClient({
        baseUrl: `http://127.0.0.1:${server.port}`,
        credential: launch.nonce,
        requestTimeoutMs: 5_000,
        fetch: (input, init) =>
          unreachable
            ? Promise.reject(
                new TypeError(
                  `connect ECONNREFUSED (${input.endsWith("/heartbeat") ? refusedBeats++ : "-"})`,
                ),
              )
            : globalThis.fetch(input, init),
      }),
      logger,
      runtimes: {
        launcherFor: () => ({
          start: ({ runtimeConfig, principal, ...rest }, hooks) =>
            runtime.start(
              {
                claudeConfigDir: "/tmp/fake/config",
                cwd: "/tmp/fake/workspace",
                home: "/tmp/fake/home",
                model: runtimeConfig.model,
                profile: {
                  ...runtimeConfig.provider,
                  principal: { ownerScope: principal.owner_scope },
                },
                tools: runtimeConfig.tools,
                ...rest,
              },
              hooks,
            ),
        }),
      },
      timeouts: {
        answerPollIntervalMs: 1_000,
        claimTimeoutMs: 5_000,
        drainTimeoutMs: 5_000,
        heartbeatIntervalMs: HEARTBEAT_MS,
        idleTimeoutMs: 60_000,
        leaseSafetyMarginMs: MARGIN_MS,
        maxTurnMs: 60_000,
        nextInputRetryTimeoutMs: 60_000,
        nextInputWaitMs: 100,
        questionTimeoutMs: 5_000,
        requestTimeoutMs: 5_000,
        startupTimeoutMs: 60_000,
      },
      workspace: noWorkspace,
    });
    const loop = host.runLoop();
    await until(() => runtime.inputs.length === 1, "turn 1 running", 30_000);
    const id = attemptId;
    if (id === undefined) throw new Error("the claim was not logged");

    try {
      // An hour ahead, then two back: longer than the lease many times over
      // in both directions, while the gateway keeps answering.
      const renewedFrom = await leaseOf(id);
      setSystemTime(new Date(Date.now() + 3_600_000));
      await Bun.sleep(LEASE_TTL_MS / 2);
      setSystemTime(new Date(Date.now() - 7_200_000));
      await Bun.sleep(LEASE_TTL_MS);
      setSystemTime();
      // Held past the TTL it was granted with: the beats kept renewing it.
      expect(await leaseOf(id)).toBeGreaterThan(renewedFrom + LEASE_TTL_MS / 2);
      expect(lost.value?.reason).toBeUndefined();
    } finally {
      setSystemTime();
    }

    // Where the database clock stands against this process's monotonic
    // one, bracketed by the round trip of the read: a DB read made after the
    // loss could land late on a loaded runner and see a lapse that had not
    // happened yet. The tightest of a few samples.
    let offset = { low: -Infinity, high: Infinity };
    for (let sample = 0; sample < 5; sample += 1) {
      const sent = performance.now();
      const dbNow = await dbNowMs();
      const answered = performance.now();
      if (dbNow - sent - (dbNow - answered) < offset.high - offset.low) {
        offset = { low: dbNow - answered, high: dbNow - sent };
      }
    }

    unreachable = true;
    const summary = await loop;

    expect(summary.outcome).toBe("lease_lost");
    expect(summary.reason).toContain(
      `lease given up ${MARGIN_MS}ms before it runs out`,
    );
    const loss = lost.value;
    if (loss === undefined) throw new Error("the loss was not logged");
    const leaseAtLoss = await loss.lease;
    // Not late: even the latest the database clock can have read at the
    // loss is short of the lease's end.
    expect(loss.at + offset.high).toBeLessThan(leaseAtLoss);
    // Not early: the worker rode out beats that failed, and let go with
    // about the margin left — plus the round trip of its last renewal,
    // which it counts from the send.
    expect(refusedBeats).toBeGreaterThan(1);
    expect(leaseAtLoss - (loss.at + offset.low)).toBeLessThan(
      MARGIN_MS + 3_000,
    );
  }, 90_000);
});
