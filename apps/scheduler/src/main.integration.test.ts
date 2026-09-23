import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@agent-platform/db";
import { executions, sessions, unassignedSessions } from "@agent-platform/db";
import {
  containerNameFor,
  DockerClient,
  LABELS,
  LocalDockerBackend,
  localDockerConfigFromEnv,
  networkNameFor,
  workspaceVolumePrefixFor,
} from "@agent-platform/execution-local-docker";
import {
  removeWorkerNetworks,
  startStandInProxy,
} from "@agent-platform/execution-local-docker/testing";
import {
  hashWorkerToken,
  launchNonceFingerprint,
} from "@agent-platform/platform";
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
  let proxy: string | undefined;

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
    EXECUTION_SLOT_LIMIT: "10",
    MAX_TURN_SECONDS: "3600",
    QUEUED_INPUT_LIMIT_PER_SESSION: "20",
    SESSION_COST_LIMIT_USD: "25",
    STORAGE_LIMIT_BYTES: "1073741824",
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
    proxy = await startStandInProxy({
      dockerHost,
      image: IMAGE,
      installationId: runLabel,
    });
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
    for (const container of await client
      .listContainers([`${LABELS.installation}=${runLabel}`])
      .catch(() => [])) {
      await client
        .stopAndRemoveContainer(container.Id, 1)
        .catch(() => undefined);
    }
    if (proxy) await client.stopAndRemoveContainer(proxy, 1).catch(() => {});
    await removeWorkerNetworks(client, runLabel).catch((error: unknown) => {
      console.warn("[scheduler.integration] worker networks left", error);
    });
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
    // One network per worker, none shared.
    const networks = await client.listNetworks([
      `${LABELS.workerNetwork}=true`,
      `${LABELS.installation}=${runLabel}`,
    ]);
    expect(networks.map((n) => n.Name).sort()).toEqual(
      rows
        .map((r) =>
          networkNameFor(
            { executionId: r.id, generation: r.generation },
            runLabel,
          ),
        )
        .sort(),
    );
  }, 180_000);

  test("a force-removed worker that is re-ensured keeps its one network", async () => {
    const [row] = await db
      .select({ id: executions.id, generation: executions.generation })
      .from(executions)
      .where(inArray(executions.sessionId, sessionIds));
    if (!row) throw new Error("no execution row");
    const ref = { executionId: row.id, generation: row.generation };
    const before = await client.inspectNetwork(networkNameFor(ref, runLabel));
    await client.stopAndRemoveContainer(containerNameFor(ref, runLabel), 1);

    const summary = await main(environment());

    expect(summary.reensured).toContainEqual(ref);
    expect(summary.networksReclaimed).toEqual([]);
    const after = await client.inspectNetwork(networkNameFor(ref, runLabel));
    expect(after?.Id).toBe(before?.Id);
  }, 180_000);

  test("the network of a worker nothing will relaunch is gone after one pass", async () => {
    // A worker with no launch intent behind it — what a force-removed
    // container leaves when its execution is already finished. With the
    // container gone, only the network is left to find.
    const backend = new LocalDockerBackend(
      localDockerConfigFromEnv(environment()),
    );
    const ref = { executionId: crypto.randomUUID(), generation: 1 };
    const sessionId = crypto.randomUUID();
    // Tracked so afterAll removes its workspace; GC would leave one this young.
    sessionIds.push(sessionId);
    await backend.ensureExecution({
      ...ref,
      bootstrapCredentialState: async () => ({
        claimed: false,
        fingerprint: launchNonceFingerprint(hashWorkerToken("wln-orphan")),
      }),
      image: IMAGE,
      issueBootstrapNonce: async () => "wln-orphan",
      launchSpec: null,
      operationId: crypto.randomUUID(),
      resources: { cpus: 0.25, memoryBytes: 64 * 1024 * 1024, pidsLimit: 32 },
      sessionId,
    });
    await fetch(
      `http://docker/v1.44/containers/${containerNameFor(ref, runLabel)}?force=true`,
      {
        method: "DELETE",
        unix: dockerHost.replace("unix://", ""),
      } as RequestInit,
    );
    const name = networkNameFor(ref, runLabel);
    expect(await client.inspectNetwork(name)).not.toBeNull();

    const summary = await main(environment());

    expect(summary.networksReclaimed).toEqual([name]);
    expect(summary.networksFailed).toEqual([]);
    expect(await client.inspectNetwork(name)).toBeNull();
  }, 180_000);

  test("a second running proxy costs the live networks both, before the pass refuses", async () => {
    const [row] = await db
      .select({ id: executions.id, generation: executions.generation })
      .from(executions)
      .where(inArray(executions.sessionId, sessionIds));
    if (!row) throw new Error("no execution row");
    const network = networkNameFor(
      { executionId: row.id, generation: row.generation },
      runLabel,
    );
    const second = await startStandInProxy({
      dockerHost,
      image: IMAGE,
      installationId: runLabel,
      name: `ap-it-proxy2-${runLabel}`,
    });
    try {
      await client.connectNetwork(network, second, ["egress-proxy"]);
      const proxyNames = async () =>
        Object.values((await client.inspectNetwork(network))?.Containers ?? {})
          .map((member) => member.Name)
          .filter((name) => name === proxy || name === second);
      expect((await proxyNames()).sort()).toEqual([proxy ?? "", second].sort());

      await expect(main(environment())).rejects.toThrow(
        "2 running containers carry",
      );

      expect(await proxyNames()).toEqual([]);
    } finally {
      await client.stopAndRemoveContainer(second, 1).catch(() => undefined);
    }
    // Down to one again: the next pass gives it back.
    const summary = await main(environment());
    expect(summary.networksRepaired).toContain(network);
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
