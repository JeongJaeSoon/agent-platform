import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@agent-platform/db";
import { executions, sessions, unassignedSessions } from "@agent-platform/db";
import {
  containerNameFor,
  DockerClient,
  LABELS,
  workspaceVolumePrefixFor,
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
  const workerNetwork = `ap-it-net-${crypto.randomUUID().slice(0, 8)}`;

  const environment = () => ({
    ...process.env,
    AWS_ACCESS_KEY_ID: "test",
    AWS_ENDPOINT_URL: "http://localstack:4566",
    AWS_REGION: "ap-northeast-1",
    AWS_SECRET_ACCESS_KEY: "test",
    DATABASE_URL: database.url,
    DOCKER_HOST: dockerHost,
    EXECUTION_EGRESS_PROXY_URL: "http://egress-proxy:3128",
    EXECUTION_INSTALLATION_ID: runLabel,
    EXECUTION_DOCKER_COMMAND: "sleep 600",
    EXECUTION_DOCKER_NETWORK: workerNetwork,
    EXECUTION_DOCKER_NETWORK_ALLOWLIST: workerNetwork,
    EXECUTION_SLOT_LIMIT: "10",
    // The runner's data root is on ext4, so the daemon cannot carry a
    // volume quota; the quota itself is covered by workspace.integration.test.ts.
    EXECUTION_WORKSPACE_QUOTA: "off",
    S3_BUCKET: "claude-sessions",
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
    await client.createNetwork({ Internal: true, Name: workerNetwork });
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
        .stopAndRemoveContainer(
          containerNameFor(
            { executionId: row.id, generation: row.generation },
            runLabel,
          ),
          1,
        )
        .catch(() => undefined);
    }
    for (const sessionId of sessionIds) {
      for (const volume of await client
        .listVolumes([`${LABELS.sessionId}=${sessionId}`])
        .catch(() => [])) {
        await fetch(`http://docker/v1.44/volumes/${volume.Name}?force=true`, {
          method: "DELETE",
          unix: dockerHost.replace("unix://", ""),
        } as RequestInit).catch(() => undefined);
      }
    }
    await client.removeNetwork(workerNetwork).catch(() => undefined);
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

  test("a refused quota preflight still reclaims the workspaces it can", async () => {
    // The probe needs disk, so the daemon that fails it is often the one that
    // is full — the moment reclaiming finished sessions matters most. This
    // daemon fails the probe for a different reason (no project quota behind
    // its storage), which exercises the same path: refuse to admit work, but
    // not before the pass has had its chance to free disk.
    const closedSession = crypto.randomUUID();
    sessionIds.push(closedSession);
    await db.insert(sessions).values({
      id: closedSession,
      ownerId: runLabel,
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${closedSession}`,
      admissionState: "closed",
    });
    const name = `${workspaceVolumePrefixFor(closedSession, runLabel)}7a6b5c4d`;
    await client.createVolume({
      Driver: "local",
      Labels: {
        [LABELS.installation]: runLabel,
        [LABELS.managed]: "true",
        [LABELS.sessionId]: closedSession,
        [LABELS.workspaceQuota]: "off",
      },
      Name: name,
    });

    await expect(
      main({
        ...environment(),
        EXECUTION_WORKSPACE_QUOTA: "on",
        EXECUTION_WORKSPACE_GC_MIN_AGE_SEC: "0",
      }),
    ).rejects.toThrow("cannot put a size quota");

    expect(await client.inspectVolume(name)).toBeNull();
  }, 180_000);
});
