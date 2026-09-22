import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  appendEventsResponseSchema,
  type BootstrapClaimResponse,
  bootstrapClaimResponseSchema,
  finalizeResponseSchema,
  heartbeatResponseSchema,
  nextInputResponseSchema,
  releaseResponseSchema,
} from "@agent-platform/contracts";
import * as schema from "@agent-platform/db";
import {
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
  events,
  sessions,
  turns,
} from "@agent-platform/db";
import {
  acceptAllCheckpoints,
  createWorkerGateway,
} from "@agent-platform/platform";
import { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createApiApp } from "../app.ts";
import { registerWorkerRoutes } from "./worker.ts";

const LEASE_TTL_MS = 1_000;

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let app: ReturnType<typeof createApiApp>;
let gateway: ReturnType<typeof createWorkerGateway>;
let clock: Date;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: `${import.meta.dir}/../../../../packages/db/migrations`,
  });
  clock = new Date("2026-09-22T00:00:00.000Z");
  gateway = createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog: {
      profiles: {
        "claude-coding-v1": {
          runtime_kind: "claude_agent_sdk",
          runtime_version: "0.3.270",
          model: "claude-sonnet-5",
          tools: ["Read", "Edit", "Bash"],
          permission_mode: "default",
          provider: {
            kind: "litellm",
            endpoint: "https://litellm.invalid",
            auth: { kind: "api_key", value: "catalog-provider-key" },
          },
        },
      },
      repositories: {},
    },
    checkpoints: acceptAllCheckpoints,
    options: {
      leaseTtlMs: LEASE_TTL_MS,
      now: () => clock,
      sleep: async () => {},
    },
  });
  app = createApiApp({
    authMode: "api-key",
    registerInternalRoutes: (router) => registerWorkerRoutes(router, gateway),
  });
});

afterEach(async () => {
  await client.close();
});

async function seedSession() {
  const result = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    principal: { ownerId: "owner-a" },
    idempotencyKey: crypto.randomUUID(),
    payloadHash: "hash",
    profileId: "claude-coding-v1",
    repository: {
      id: "sample-app",
      url: "https://example.invalid/app.git",
      branch: "main",
    },
    message: "hello worker",
  });
  if (result.outcome !== "accepted") throw new Error(result.outcome);
  return result.response;
}

function post(path: string, token: string | null, body: unknown) {
  return app.request(`/internal/worker/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response) {
  const body = apiErrorResponseSchema.parse(await response.json());
  return { status: response.status, code: body.error.code };
}

function scope(claimed: BootstrapClaimResponse, turnId: string | null = null) {
  return {
    session_id: claimed.session_id,
    turn_id: turnId,
    attempt_id: claimed.attempt_id,
    lease_epoch: claimed.lease_epoch,
    execution_generation: claimed.execution_generation,
    auth_revision: claimed.auth_revision,
  };
}

async function claimed() {
  const launch = await gateway.registerLaunch({
    executionId: "exec-1",
    generation: 1,
    backend: "local_docker",
  });
  const response = await post("bootstrap-claim", launch.nonce, {
    execution_id: "exec-1",
    execution_generation: 1,
    credential: { kind: "launch_nonce", nonce: launch.nonce },
  });
  expect(response.status).toBe(200);
  return {
    nonce: launch.nonce,
    binding: bootstrapClaimResponseSchema.parse(await response.json()),
  };
}

describe("/internal/worker", () => {
  test("is not behind the /v1 API-key middleware: a missing or unknown token is 401 from the gateway", async () => {
    await seedSession();
    expect(await errorOf(await post("heartbeat", null, {}))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(await errorOf(await post("heartbeat", "wsc_nope", {}))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    // A /v1 API key is not a worker token either.
    const v1 = await app.request("/v1/sessions", {
      headers: { authorization: "Bearer csp_whatever" },
    });
    expect(v1.status).toBe(401);
  });

  test("the bootstrap token can only call bootstrap-claim", async () => {
    await seedSession();
    const { nonce, binding } = await claimed();
    expect(
      await errorOf(await post("next-input", nonce, scope(binding))),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(
      await errorOf(
        await post("heartbeat", nonce, {
          ...scope(binding),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
    // The session token, conversely, cannot re-enter bootstrap.
    expect(
      await errorOf(
        await post("bootstrap-claim", binding.session_credential, {
          execution_id: "exec-1",
          execution_generation: 1,
          credential: { kind: "launch_nonce", nonce },
        }),
      ),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
  });

  test("a session token cannot act for a binding it does not own", async () => {
    const seeded = await seedSession();
    const { binding } = await claimed();
    const forged = { ...scope(binding), attempt_id: "att_other" };
    expect(
      await errorOf(
        await post("heartbeat", binding.session_credential, {
          ...forged,
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(seeded.session_id).toBe(binding.session_id);
  });

  test("bootstrap-claim answers 404 when the partition has no waiting session", async () => {
    const launch = await gateway.registerLaunch({
      executionId: "exec-idle",
      generation: 1,
      backend: "local_docker",
    });
    const response = await post("bootstrap-claim", launch.nonce, {
      execution_id: "exec-idle",
      execution_generation: 1,
      credential: { kind: "launch_nonce", nonce: launch.nonce },
    });
    expect(await errorOf(response)).toEqual({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  test("runs one attempt end to end over HTTP", async () => {
    const seeded = await seedSession();
    const { binding } = await claimed();
    const token = binding.session_credential;
    expect(binding.workspace.repository).toEqual({
      id: "sample-app",
      url: "https://example.invalid/app.git",
      branch: "main",
    });
    expect(binding.runtime_config.provider.auth.value).toBe(
      "catalog-provider-key",
    );

    const next = nextInputResponseSchema.parse(
      await (await post("next-input", token, scope(binding))).json(),
    );
    expect(next.input?.turn_id).toBe("1");
    expect(next.input?.message).toBe("hello worker");
    const [turn] = await db
      .select({ deliveryStartedAt: turns.deliveryStartedAt })
      .from(turns)
      .where(eq(turns.sessionId, seeded.session_id));
    expect(turn?.deliveryStartedAt?.toISOString()).toBe(clock.toISOString());

    clock = new Date(clock.getTime() + 400);
    // PGlite runs in this process, so its clock is Date.now().
    const floor = Date.now();
    const beat = heartbeatResponseSchema.parse(
      await (
        await post("heartbeat", token, {
          ...scope(binding),
          attempt_state: "running",
        })
      ).json(),
    );
    const extended = new Date(beat.lease_expires_at).getTime();
    expect(extended).toBeGreaterThanOrEqual(floor + LEASE_TTL_MS);
    expect(extended).toBeLessThanOrEqual(Date.now() + LEASE_TTL_MS);

    const batch = {
      ...scope(binding, "1"),
      batch_key: "b-1",
      events: [
        {
          event: "assistant",
          data: { type: "assistant", message: { text: "hi" } },
          source_sequence: 1,
          occurred_at: clock.toISOString(),
        },
        {
          event: "result",
          data: { type: "result", subtype: "success", session_id: "sdk-1" },
          source_sequence: 2,
          occurred_at: clock.toISOString(),
        },
      ],
    };
    const appended = appendEventsResponseSchema.parse(
      await (await post("append-events", token, batch)).json(),
    );
    expect(appended.accepted_through).toBe(2);
    const resent = await post("append-events", token, batch);
    expect(resent.status).toBe(200);
    expect(appendEventsResponseSchema.parse(await resent.json())).toEqual(
      appended,
    );
    const [stored] = await db
      .select({ n: count() })
      .from(events)
      .where(eq(events.sessionId, seeded.session_id));
    expect(stored?.n).toBe(2);

    const finalized = finalizeResponseSchema.parse(
      await (
        await post("finalize", token, {
          ...scope(binding, "1"),
          turn_id: "1",
          finalize_key: "fin-1",
          terminal: {
            status: "completed",
            reason: null,
            result: { ok: true },
            usage: null,
          },
          checkpoint: {
            revision: 1,
            manifest_ref: "s3://b/m.json",
            manifest_sha256: "f".repeat(64),
          },
        })
      ).json(),
    );
    expect(finalized).toEqual({
      turn_id: "1",
      status: "completed",
      checkpoint_revision: 1,
    });
    const [row] = await db
      .select({
        status: sessions.status,
        checkpointRevision: sessions.checkpointRevision,
      })
      .from(sessions)
      .where(eq(sessions.id, seeded.session_id));
    expect(row).toEqual({ status: "idle", checkpointRevision: 1 });

    const released = releaseResponseSchema.parse(
      await (
        await post("release", token, {
          ...scope(binding),
          reason: "idle_timeout",
        })
      ).json(),
    );
    expect(released).toEqual({ released: true });
    // The token died with the attempt.
    expect(
      await errorOf(
        await post("heartbeat", token, {
          ...scope(binding),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 401, code: "UNAUTHORIZED" });
  });

  test("heartbeat after the TTL is 409 LEASE_EXPIRED", async () => {
    await seedSession();
    const { binding } = await claimed();
    // The lease runs on the database clock, so only real time ends it.
    await new Promise((resolve) => setTimeout(resolve, LEASE_TTL_MS + 50));
    expect(
      await errorOf(
        await post("heartbeat", binding.session_credential, {
          ...scope(binding),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 409, code: "LEASE_EXPIRED" });
  });

  test("a stale epoch is 409 STALE_EPOCH", async () => {
    await seedSession();
    const { binding } = await claimed();
    expect(
      await errorOf(
        await post("append-events", binding.session_credential, {
          ...scope(binding),
          lease_epoch: binding.lease_epoch - 1,
          batch_key: "b",
          events: [
            {
              event: "status",
              data: { phase: "running" },
              source_sequence: 1,
              occurred_at: clock.toISOString(),
            },
          ],
        }),
      ),
    ).toEqual({ status: 409, code: "STALE_EPOCH" });
  });

  test("rejects a malformed body with 400 before touching the gateway", async () => {
    await seedSession();
    const { binding } = await claimed();
    expect(
      await errorOf(
        await post("heartbeat", binding.session_credential, {
          ...scope(binding),
          attempt_state: "running",
          extra: true,
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
    // These columns are int4, so a larger number is a bad request rather
    // than a failed insert surfacing as 500.
    expect(
      await errorOf(
        await post("append-events", binding.session_credential, {
          ...scope(binding),
          turn_id: "1",
          batch_key: "b",
          events: [
            {
              event: "status",
              data: { phase: "running" },
              source_sequence: 2_147_483_648,
              occurred_at: clock.toISOString(),
            },
          ],
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
    expect(
      await errorOf(
        await post("finalize", binding.session_credential, {
          ...scope(binding),
          turn_id: "1",
          finalize_key: "f",
          terminal: {
            status: "completed",
            reason: null,
            result: null,
            usage: null,
          },
          checkpoint: {
            revision: 2_147_483_648,
            manifest_ref: "s3://bucket/m.json",
            manifest_sha256: "a".repeat(64),
          },
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
  });
});
