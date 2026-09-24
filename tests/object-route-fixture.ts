import { join } from "node:path";
import { createEgressAuthorizer } from "@agent-platform/control-host/src/api/egress-authorizer.ts";
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
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

/**
 * The control plane side of the object store route (94S-251), real from the
 * database up: a session in PGlite, the real gateway claiming it, and the
 * real authorizer listening with the real signer. Shared by the in-process
 * suite (`object-store-route.test.ts`) and the Docker egress suite, which
 * runs this file in a container on the proxy's outer network.
 *
 * Each `openSession()` accepts a new session. Its `claim()` starts the
 * session's next execution generation: the first call claims generation 1;
 * each later one sees the previous execution gone, as the scheduler would,
 * and claims the next. It returns the new attempt's object store token.
 */

const PROFILE_ID = "claude-coding-v1";

export type ObjectRouteSession = {
  sessionId: string;
  claim(): Promise<string>;
};

export type ObjectRouteFixture = {
  authorizerUrl: string;
  authorizerToken: string;
  openSession(): Promise<ObjectRouteSession>;
  stop(): Promise<void>;
};

export async function startObjectRouteFixture(options: {
  objectStore: {
    accessKeyId: string;
    bucket: string;
    endpoint: string;
    region: string;
    secretAccessKey: string;
  };
  hostname?: string;
  port?: number;
}): Promise<ObjectRouteFixture> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: join(import.meta.dir, "..", "packages/db/migrations"),
  });
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
            endpoint: "http://provider.invalid",
            auth: {
              kind: "api_key",
              value: "catalog-provider-value",
              ref: { value_env: "PROVIDER_KEY" },
            },
          },
        },
      },
      repositories: {
        app: {
          url: "http://git.invalid/app.git",
          branch: "main",
          profiles: [PROFILE_ID],
        },
      },
    },
    checkpoints: acceptAllCheckpoints,
    options: { sessionCostLimitUsd: 1_000, leaseTtlMs: 60_000 },
  });
  const authorizerToken = `object-route-fixture-${crypto.randomUUID()}`;
  const authorizer = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    fetch: createEgressAuthorizer({
      gateway,
      logger: createLogger({ sinks: [] }),
      objectStore: createObjectRouteSigner({
        bucket: options.objectStore.bucket,
        credentials: {
          accessKeyId: options.objectStore.accessKeyId,
          secretAccessKey: options.objectStore.secretAccessKey,
        },
        endpoint: options.objectStore.endpoint,
        region: options.objectStore.region,
      }),
      token: authorizerToken,
    }),
  });

  const sessions = createPostgresSessionUnitOfWork(db);
  async function openSession(): Promise<ObjectRouteSession> {
    const accepted = await sessions.acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: "owner-a" },
      idempotencyKey: crypto.randomUUID(),
      payloadHash: crypto.randomUUID(),
      profileId: PROFILE_ID,
      repository: {
        id: "app",
        url: "http://git.invalid/app.git",
        branch: "main",
      },
      message: "hello",
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    const sessionId = accepted.response.session_id;
    let generation = 0;
    let execution: string | null = null;
    return {
      sessionId,
      async claim() {
        if (execution !== null) await gateway.confirmExecutionGone(execution);
        generation += 1;
        execution = `exec-${sessionId}-${generation}`;
        const launch = await gateway.registerLaunch({
          executionId: execution,
          generation,
          sessionId,
          backend: "local_docker",
        });
        if (launch.nonce === null) throw new Error("launch already registered");
        const claim = await gateway.bootstrapClaim(
          { kind: "bootstrap" },
          {
            execution_id: execution,
            execution_generation: generation,
            credential: { kind: "launch_nonce", nonce: launch.nonce },
          },
        );
        if (claim.session_id !== sessionId) {
          throw new Error(`claimed ${claim.session_id}, not ${sessionId}`);
        }
        return claim.object_store.access.token;
      },
    };
  }

  return {
    authorizerUrl: `http://${authorizer.hostname}:${authorizer.port}`,
    authorizerToken,
    openSession,
    async stop() {
      authorizer.stop(true);
      await client.close();
    },
  };
}
