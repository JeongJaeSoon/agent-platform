import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LaunchIntent } from "@agent-platform/platform";
import {
  containerNameFor,
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
    bootstrapNonce: `nonce-${suffix}`,
    executionId: `exec-${suffix}`,
    generation: 1,
    image: IMAGE,
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
  const created: LaunchIntent[] = [];
  const track = (intent: LaunchIntent) => {
    created.push(intent);
    return intent;
  };

  beforeAll(async () => {
    await client.version();
    await client.createNetwork({ Internal: true, Name: workerNetwork });
    // Pull once so create does not 404 on a fresh daemon.
    await new DockerClient(dockerHost, "v1.44", {
      timeoutMs: 110_000,
    }).pullImage(IMAGE);
  }, 120_000);

  afterAll(async () => {
    for (const intent of created) {
      for (const generation of [1, 2, 3]) {
        await client
          .stopAndRemoveContainer(
            containerNameFor({ ...intent, generation }, installationId),
            1,
          )
          .catch(() => undefined);
      }
      for (const volume of await client
        .listVolumes([`${LABELS.sessionId}=${intent.sessionId}`])
        .catch(() => [])) {
        await fetchDocker(`/volumes/${volume.Name}?force=true`, "DELETE").catch(
          () => undefined,
        );
      }
    }
    await client.removeNetwork(workerNetwork).catch(() => undefined);
    // Bun's default hook timeout is 5s, and this tears down a container per
    // generation per test — each with a stop that waits on the process.
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
    const intent = track(intentFor());
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
        `${ENV.bootstrapNonce}=${intent.bootstrapNonce}`,
        `${ENV.executionGeneration}=${intent.generation}`,
        `${ENV.executionId}=${intent.executionId}`,
        `${ENV.gatewayUrl}=http://host.docker.internal:3000`,
        `${ENV.httpProxy}=http://egress-proxy:3128`,
        `${ENV.httpProxyLower}=http://egress-proxy:3128`,
        `${ENV.httpsProxy}=http://egress-proxy:3128`,
        `${ENV.httpsProxyLower}=http://egress-proxy:3128`,
        `${ENV.noProxy}=${NO_PROXY_VALUE}`,
        `${ENV.noProxyLower}=${NO_PROXY_VALUE}`,
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
    const intent = track(intentFor());
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
    const gen1 = track({
      ...base,
      generation: 1,
      operationId: `${base.operationId}-1`,
    });
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
    const intent = track(intentFor());
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
    const intent = track(intentFor());
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
