import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@agent-platform/db";
import { executions, sessions, unassignedSessions } from "@agent-platform/db";
import {
  DockerClient,
  LABELS,
  workspaceVolumeFor,
} from "@agent-platform/execution-local-docker";
import { createTempDatabase, type TempDatabase } from "@agent-platform/testkit";
import { inArray } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { main } from "./main.ts";

/**
 * The acceptance run for the slot limit: 15 unassigned sessions, one pass,
 * at most `EXECUTION_SLOT_LIMIT` containers. Needs both opt-ins: a real
 * Docker daemon (`DOCKER_BACKEND_TEST=1`) and PostgreSQL
 * (`QUEUE_DATABASE_URL`). Uses a sleeping busybox as the worker image.
 */
const databaseUrl = process.env.QUEUE_DATABASE_URL;
const enabled = process.env.DOCKER_BACKEND_TEST === "1" && databaseUrl;
const integration = enabled ? describe : describe.skip;
const IMAGE = process.env.DOCKER_BACKEND_TEST_IMAGE ?? "busybox:1.36";
const dockerHost =
  process.env.DOCKER_HOST ??
  ((await Bun.file(`${process.env.HOME}/.docker/run/docker.sock`).exists())
    ? `unix://${process.env.HOME}/.docker/run/docker.sock`
    : "unix:///var/run/docker.sock");

integration("scheduler pass against Docker and PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const client = new DockerClient(dockerHost);
  const sessionIds: string[] = [];
  const runLabel = `it-${crypto.randomUUID()}`;

  const environment = () => ({
    ...process.env,
    DATABASE_URL: database.url,
    DOCKER_HOST: dockerHost,
    EXECUTION_DOCKER_COMMAND: "sleep 600",
    EXECUTION_SLOT_LIMIT: "10",
    WORKER_CPUS: "0.25",
    WORKER_GATEWAY_URL: "http://host.docker.internal:3000",
    WORKER_IMAGE: IMAGE,
    WORKER_MEMORY_MB: "64",
    WORKER_PIDS_LIMIT: "32",
  });

  beforeAll(async () => {
    await new DockerClient(dockerHost, "v1.44", {
      timeoutMs: 110_000,
    }).pullImage(IMAGE);
    database = await createTempDatabase({ prefix: "scheduler_it" });
    pool = new Pool({ connectionString: database.url });
    db = drizzle(pool, { schema });
    for (let i = 0; i < 15; i += 1) {
      const id = crypto.randomUUID();
      sessionIds.push(id);
      await db.insert(sessions).values({
        id,
        ownerId: runLabel,
        repoUrl: "https://example.invalid/repo.git",
        branch: `session/${id}`,
      });
      await db.insert(unassignedSessions).values({ sessionId: id });
    }
  }, 120_000);

  afterAll(async () => {
    const rows = await db
      .select({ id: executions.id, generation: executions.generation })
      .from(executions)
      .where(inArray(executions.sessionId, sessionIds));
    for (const row of rows) {
      await client
        .stopAndRemoveContainer(`ap-worker-${row.id}-g${row.generation}`, 1)
        .catch(() => undefined);
    }
    for (const sessionId of sessionIds) {
      await fetch(
        `http://docker/v1.44/volumes/${workspaceVolumeFor(sessionId)}?force=true`,
        {
          method: "DELETE",
          unix: dockerHost.replace("unix://", ""),
        } as RequestInit,
      ).catch(() => undefined);
    }
    await pool.end();
    await database.drop();
  }, 120_000);

  test("15 unassigned sessions → at most 10 containers, and a rerun adds none", async () => {
    const first = await main(environment());
    expect(first.launched).toHaveLength(10);
    expect(first.failedLaunches).toEqual([]);

    const second = await main(environment());
    expect(second.launched).toEqual([]);
    expect(second.reensured).toEqual([]);
    expect(second.orphansTerminated).toEqual([]);
    expect(second.activeAfter).toBe(10);

    const ours = (
      await client.listContainers([`${LABELS.managed}=true`])
    ).filter((c) => sessionIds.includes(c.Labels?.[LABELS.sessionId] ?? ""));
    expect(ours).toHaveLength(10);
    expect(ours.every((c) => c.State === "running")).toBe(true);

    const live = await db
      .select({
        sessionId: executions.sessionId,
        state: executions.observedState,
      })
      .from(executions)
      .where(inArray(executions.sessionId, sessionIds));
    expect(live).toHaveLength(10);
    expect(new Set(live.map((row) => row.sessionId)).size).toBe(10);

    // Every container is labelled with exactly the row it belongs to.
    const rows = await db
      .select({ id: executions.id, generation: executions.generation })
      .from(executions)
      .where(inArray(executions.sessionId, sessionIds));
    const rowKeys = new Set(rows.map((r) => `${r.id}#${r.generation}`));
    for (const container of ours) {
      const key = `${container.Labels?.[LABELS.executionId]}#${container.Labels?.[LABELS.generation]}`;
      expect(rowKeys.has(key)).toBe(true);
    }
  }, 180_000);
});
