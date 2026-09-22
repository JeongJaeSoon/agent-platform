import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LaunchIntent } from "@agent-platform/platform";
import {
  ENV,
  LABELS,
  LocalDockerBackend,
  NO_PROXY_VALUE,
  workspaceVolumePrefixFor,
} from "./backend.ts";
import type { LocalDockerBackendConfig } from "./config.ts";
import { DockerClient } from "./docker-client.ts";

/**
 * Talks to a real Docker daemon. Opt in with `DOCKER_BACKEND_TEST=1`; the
 * daemon is whatever `DOCKER_HOST` (or the default socket) points at. Uses a
 * sleeping busybox in place of the worker image, which is a sibling ticket.
 */
const enabled = process.env.DOCKER_BACKEND_TEST === "1";
const integration = enabled ? describe : describe.skip;
const IMAGE = process.env.DOCKER_BACKEND_TEST_IMAGE ?? "busybox:1.36";
const dockerHost = process.env.DOCKER_HOST ?? (await defaultDockerHost());

async function defaultDockerHost(): Promise<string> {
  const candidates = [
    "/var/run/docker.sock",
    `${process.env.HOME}/.docker/run/docker.sock`,
  ];
  for (const path of candidates) {
    if (await Bun.file(path).exists()) return `unix://${path}`;
  }
  return "unix:///var/run/docker.sock";
}

const RESOURCES = { cpus: 0.5, memoryBytes: 128 * 1024 * 1024, pidsLimit: 64 };

function intentFor(overrides: Partial<LaunchIntent> = {}): LaunchIntent {
  const suffix = crypto.randomUUID();
  return {
    executionId: `exec-${suffix}`,
    generation: 1,
    image: IMAGE,
    issueBootstrapNonce: async () => `wln-${suffix}`,
    operationId: `op-${suffix}`,
    resources: RESOURCES,
    sessionId: crypto.randomUUID(),
    ...overrides,
  };
}

integration("LocalDockerBackend against a real daemon", () => {
  const client = new DockerClient(dockerHost);
  const installationId = `it-${crypto.randomUUID().slice(0, 8)}`;
  // Workers only ever run on an internal network; the backend refuses
  // anything else, so the fixture has to build one.
  const workerNetwork = `ap-it-net-${crypto.randomUUID().slice(0, 8)}`;
  const backendConfig = (): LocalDockerBackendConfig => ({
    allowedNetworks: [workerNetwork],
    apiVersion: "v1.44",
    command: ["sleep", "600"],
    dockerHost,
    egressProxyUrl: "http://egress-proxy:3128",
    gatewayUrl: "http://host.docker.internal:3000",
    homeDir: "/home/worker",
    installationId,
    network: workerNetwork,
    objectStore: {
      accessKeyId: "test",
      bucket: "claude-sessions",
      endpoint: "http://localstack:4566",
      region: "ap-northeast-1",
      secretAccessKey: "test",
    },
    requestTimeoutMs: 30_000,
    stopTimeoutSeconds: 1,
    tmpfsSizeBytes: 16 * 1024 * 1024,
    user: "1000:1000",
    workspaceDir: "/workspace",
    workspaceGcMinAgeMs: 0,
    // Neither Docker Desktop nor a stock Linux runner puts its storage on a
    // quota-capable filesystem; the quota itself is covered by
    // workspace.integration.test.ts, which probes for one first.
    workspaceQuota: { mode: "off" },
  });
  const backend = new LocalDockerBackend(backendConfig(), client);

  beforeAll(async () => {
    await client.version();
    await client.createNetwork({ Internal: true, Name: workerNetwork });
    // Pull once so create does not 404 on a fresh daemon.
    await new DockerClient(dockerHost, "v1.44", {
      timeoutMs: 110_000,
    }).pullImage(IMAGE);
  }, 120_000);

  afterAll(async () => {
    // Everything the backend makes carries the installation label, so one
    // listing finds exactly what exists — no probing generations that were
    // never created. Stops run in parallel: each one waits out the 1s stop
    // timeout because busybox's `sleep` ignores SIGTERM, and in series that
    // alone used to eat bun's 5s hook budget.
    const owned = [`${LABELS.installation}=${installationId}`];
    const t0 = performance.now();
    // A failed listing is itself a cleanup failure, not an empty daemon:
    // it goes into `failed` instead of quietly skipping everything it owned.
    const [containers, volumes] = await Promise.allSettled([
      client.listContainers(owned),
      client.listVolumes(owned),
    ]);
    const stops = await Promise.allSettled(
      (containers.status === "fulfilled" ? containers.value : []).map((c) =>
        client.stopAndRemoveContainer(c.Id, 1),
      ),
    );
    const removes = await Promise.allSettled(
      (volumes.status === "fulfilled" ? volumes.value : []).map((v) =>
        client.removeVolume(v.Name),
      ),
    );
    const network = await Promise.allSettled([
      client.removeNetwork(workerNetwork),
    ]);
    const failed = [
      containers,
      volumes,
      ...stops,
      ...removes,
      ...network,
    ].filter((r): r is PromiseRejectedResult => r.status === "rejected");
    // Leftovers are a daemon hygiene problem, not a contract violation:
    // report them and let the suite's verdict stand.
    if (failed.length > 0) {
      console.warn(
        `[backend.integration] ${failed.length} cleanup step(s) failed after ${Math.round(performance.now() - t0)}ms; leftovers carry ${owned[0]}`,
        failed.map((r) => String(r.reason)),
      );
    }
  }, 120_000);

  async function fetchDocker(path: string, method = "POST"): Promise<Response> {
    const socket = dockerHost.startsWith("unix://")
      ? dockerHost.slice("unix://".length)
      : undefined;
    const base = socket
      ? "http://docker"
      : dockerHost.replace(/^tcp:\/\//, "http://");
    return fetch(`${base}/v1.44${path}`, {
      method,
      ...(socket ? { unix: socket } : {}),
    } as RequestInit);
  }

  test("ensure twice → one container; docker inspect shows the isolation contract", async () => {
    const intent = intentFor();
    const first = await backend.ensureExecution(intent);
    const second = await backend.ensureExecution(intent);
    expect(first.created).toBe(true);
    expect(second).toEqual({
      created: false,
      providerRef: first.providerRef,
      state: "running",
    });

    const matching = await client.listContainers([
      `${LABELS.executionId}=${intent.executionId}`,
    ]);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.Labels?.[LABELS.generation]).toBe("1");

    const inspected = await client.inspectContainer(first.providerRef);
    if (!inspected) throw new Error("container vanished");
    expect(inspected.Config.User).toBe("1000:1000");
    // Docker merges the image's own Env (PATH etc.) into the container; only
    // the variables the backend adds may be left after removing those.
    const imageEnv = new Set(
      (
        (await (
          await fetchDocker(`/images/${encodeURIComponent(IMAGE)}/json`, "GET")
        ).json()) as { Config: { Env: string[] | null } }
      ).Config.Env ?? [],
    );
    expect(
      (inspected.Config.Env ?? []).filter((e) => !imageEnv.has(e)).sort(),
    ).toEqual(
      [
        `${ENV.home}=/home/worker`,
        `${ENV.workspaceDir}=/workspace`,
        `${ENV.bootstrapNonce}=${await intent.issueBootstrapNonce()}`,
        `${ENV.executionGeneration}=${intent.generation}`,
        `${ENV.executionId}=${intent.executionId}`,
        `${ENV.gatewayUrl}=http://host.docker.internal:3000`,
        `${ENV.httpProxy}=http://egress-proxy:3128`,
        `${ENV.httpProxyLower}=http://egress-proxy:3128`,
        `${ENV.httpsProxy}=http://egress-proxy:3128`,
        `${ENV.httpsProxyLower}=http://egress-proxy:3128`,
        `${ENV.noProxy}=${NO_PROXY_VALUE}`,
        `${ENV.noProxyLower}=${NO_PROXY_VALUE}`,
        `${ENV.objectAccessKeyId}=test`,
        `${ENV.objectBucket}=claude-sessions`,
        `${ENV.objectEndpoint}=http://localstack:4566`,
        `${ENV.objectPrefix}=sessions/${intent.sessionId}/`,
        `${ENV.objectRegion}=ap-northeast-1`,
        `${ENV.objectSecretAccessKey}=test`,
      ].sort(),
    );
    const host = inspected.HostConfig as Record<string, unknown>;
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.Memory).toBe(RESOURCES.memoryBytes);
    expect(host.PidsLimit).toBe(RESOURCES.pidsLimit);
    expect(host.NanoCpus).toBe(500_000_000);
    expect(host.NetworkMode).toBe(workerNetwork);
    // No route around the proxy to the daemon host.
    expect(host.ExtraHosts ?? null).toBeNull();
    expect(host.CapDrop).toEqual(["ALL"]);
    expect(host.SecurityOpt).toEqual(["no-new-privileges"]);
    expect(host.Binds ?? null).toBeNull();
    expect(host.Mounts).toEqual([
      expect.objectContaining({
        Source: expect.stringMatching(
          new RegExp(
            `^${workspaceVolumePrefixFor(intent.sessionId, installationId)}`,
          ),
        ),
        Target: "/workspace",
        Type: "volume",
      }),
    ]);
    expect(Object.keys(host.Tmpfs as Record<string, string>).sort()).toEqual([
      "/home/worker",
      "/tmp",
    ]);
    expect(JSON.stringify(inspected)).not.toContain("docker.sock");
  }, 60_000);

  test("a removed container is re-created from the same intent", async () => {
    const intent = intentFor();
    const first = await backend.ensureExecution(intent);
    await client.stopAndRemoveContainer(first.providerRef, 1);
    expect((await backend.inspect(intent)).found).toBe(false);

    const again = await backend.ensureExecution(intent);
    expect(again.created).toBe(true);
    expect(again.providerRef).not.toBe(first.providerRef);
    expect(await backend.inspect(intent)).toMatchObject({
      found: true,
      state: "running",
    });
  }, 60_000);

  test("terminate touches only the matching generation", async () => {
    const base = intentFor();
    const gen1 = {
      ...base,
      generation: 1,
      operationId: `${base.operationId}-1`,
    };
    const gen2 = {
      ...base,
      generation: 2,
      operationId: `${base.operationId}-2`,
    };
    await backend.ensureExecution(gen1);
    const second = await backend.ensureExecution(gen2);

    expect(await backend.terminate({ ...base, generation: 3 })).toMatchObject({
      outcome: "generation_mismatch",
    });
    expect(await backend.terminate(gen1)).toMatchObject({
      outcome: "terminated",
    });
    expect((await backend.inspect(gen1)).found).toBe(false);
    expect(await backend.inspect(gen2)).toMatchObject({
      found: true,
      providerRef: second.providerRef,
      state: "running",
    });
    expect(await backend.terminate(gen2)).toMatchObject({
      outcome: "terminated",
    });
    expect(await backend.terminate(gen2)).toEqual({ outcome: "absent" });
  }, 60_000);

  test("the non-root worker can write to HOME and /tmp", async () => {
    // busybox has no uid 1000 in /etc/passwd, so a writable HOME must come
    // from the mount options and the HOME env, not from the image.
    const probe = new LocalDockerBackend(
      {
        ...backendConfig(),
        command: [
          "sh",
          "-c",
          'echo ok > "$HOME/probe" && echo ok > /tmp/probe && sleep 600',
        ],
      },
      client,
    );
    const intent = intentFor();
    await probe.ensureExecution(intent);
    await Bun.sleep(1_500);
    const observed = await probe.inspect(intent);
    expect(observed.state).toBe("running");
  }, 60_000);

  test("the worker network the backend launches onto is internal", async () => {
    const network = await client.inspectNetwork(workerNetwork);
    expect(network).toMatchObject({ Internal: true, Name: workerNetwork });
    await expect(backend.verifyNetworkIsolation()).resolves.toBeUndefined();
  }, 30_000);

  test("listManaged sees every container this backend made", async () => {
    const intent = intentFor();
    const result = await backend.ensureExecution(intent);
    const managed = await backend.listManaged();
    expect(managed).toContainEqual({
      executionId: intent.executionId,
      generation: 1,
      providerRef: result.providerRef,
      sessionId: intent.sessionId,
      state: "running",
    });
  }, 60_000);
});
