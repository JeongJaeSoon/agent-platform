import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { LaunchIntent } from "@agent-platform/platform";
import { LocalDockerBackend, workspaceVolumeFor } from "./backend.ts";
import type { LocalDockerBackendConfig } from "./config.ts";
import { DockerClient } from "./docker-client.ts";

/**
 * The egress contract end to end, against a real daemon and no internet:
 * an internal worker network, an egress proxy that is its only member with
 * a route off it, and two HTTP servers on the outer network — one
 * allowlisted, one not. Opt in with `DOCKER_BACKEND_TEST=1`.
 *
 * The proxy runs from `apps/egress-proxy`, mounted read-only into a stock
 * Bun image. That is deliberate: the deployed proxy has no workspace
 * dependency either, so the fixture and the compose service boot the same
 * way.
 */
const enabled = process.env.DOCKER_BACKEND_TEST === "1";
const integration = enabled ? describe : describe.skip;
const IMAGE = process.env.DOCKER_BACKEND_TEST_IMAGE ?? "busybox:1.36";
const PROXY_IMAGE = process.env.EGRESS_PROXY_TEST_IMAGE ?? "oven/bun:1.3.10";
const PROXY_SOURCE = resolve(
  import.meta.dir,
  "../../../../..",
  "apps/egress-proxy",
);
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

integration("worker egress is confined to the proxy allowlist", () => {
  const client = new DockerClient(dockerHost, "v1.44", { timeoutMs: 120_000 });
  const suffix = crypto.randomUUID().slice(0, 8);
  const installationId = `eg-${suffix}`;
  const workerNetwork = `ap-it-worker-${suffix}`;
  const outerNetwork = `ap-it-outer-${suffix}`;
  const allowedName = `ap-it-allowed-${suffix}`;
  const deniedName = `ap-it-denied-${suffix}`;
  const proxyName = `ap-it-proxy-${suffix}`;
  const proxyUrl = `http://${proxyName}:3128`;
  const created: string[] = [];
  const volumes: string[] = [];

  const backend = new LocalDockerBackend(
    {
      allowedNetworks: [workerNetwork],
      apiVersion: "v1.44",
      command: ["sleep", "600"],
      dockerHost,
      egressProxyUrl: proxyUrl,
      gatewayUrl: `http://${allowedName}:8080`,
      homeDir: "/home/worker",
      installationId,
      network: workerNetwork,
      requestTimeoutMs: 60_000,
      stopTimeoutSeconds: 1,
      tmpfsSizeBytes: 16 * 1024 * 1024,
      user: "1000:1000",
      workspaceDir: "/workspace",
    } satisfies LocalDockerBackendConfig,
    client,
  );

  beforeAll(async () => {
    await client.version();
    for (const image of [IMAGE, PROXY_IMAGE]) {
      await client.pullImage(image);
    }
    await client.createNetwork({ Internal: true, Name: workerNetwork });
    await client.createNetwork({ Internal: false, Name: outerNetwork });
    await startServer(allowedName, "allowed-upstream");
    await startServer(deniedName, "denied-upstream", true);
    await startProxy();
  }, 300_000);

  afterAll(async () => {
    for (const name of created) {
      await client.stopAndRemoveContainer(name, 1).catch(() => undefined);
    }
    for (const volume of volumes) {
      await raw("DELETE", `/volumes/${volume}?force=true`).catch(
        () => undefined,
      );
    }
    for (const network of [workerNetwork, outerNetwork]) {
      await client.removeNetwork(network).catch(() => undefined);
    }
  }, 120_000);

  /**
   * A one-file HTTP server on the outer network, reachable only by name.
   * `publish` also binds it to a host port, which needs `ExposedPorts`: the
   * daemon ignores a binding for a port the container never declared.
   */
  async function startServer(
    name: string,
    body: string,
    publish = false,
  ): Promise<void> {
    created.push(name);
    const response = await raw("POST", `/containers/create?name=${name}`, {
      Cmd: [
        "sh",
        "-c",
        `mkdir -p /www && echo ${body} > /www/index.html && httpd -f -p 8080 -h /www`,
      ],
      // Deliberately the worst case: bound to every host address, which is
      // what a carelessly configured dev stack does.
      ...(publish ? { ExposedPorts: { "8080/tcp": {} } } : {}),
      HostConfig: {
        NetworkMode: outerNetwork,
        ...(publish
          ? {
              PortBindings: {
                "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "" }],
              },
            }
          : {}),
      },
      Image: IMAGE,
      User: "0:0",
    });
    expect(response.status).toBe(201);
    await client.startContainer(name);
  }

  /** The host port Docker picked for a published container port. */
  async function publishedPortOf(name: string): Promise<string> {
    const inspected = (await (
      await raw("GET", `/containers/${name}/json`)
    ).json()) as {
      NetworkSettings: {
        Ports: Record<string, Array<{ HostPort: string }> | null>;
      };
    };
    const port = inspected.NetworkSettings.Ports["8080/tcp"]?.[0]?.HostPort;
    if (!port) throw new Error(`${name} published no host port`);
    return port;
  }

  async function startProxy(): Promise<void> {
    created.push(proxyName);
    const response = await raw("POST", `/containers/create?name=${proxyName}`, {
      Cmd: ["bun", "run", "/app/src/main.ts"],
      Env: [
        `EGRESS_PRIVATE_ALLOWLIST=${allowedName}:8080`,
        "EGRESS_PROXY_PORT=3128",
      ],
      HostConfig: {
        Binds: [`${PROXY_SOURCE}:/app:ro`],
        NetworkMode: outerNetwork,
      },
      Image: PROXY_IMAGE,
    });
    expect(response.status).toBe(201);
    // Two networks: the outer one to reach upstreams, the internal one to be
    // reachable by workers. Only the second can be given at create time.
    const connected = await raw("POST", `/networks/${workerNetwork}/connect`, {
      Container: proxyName,
    });
    expect(connected.status).toBe(200);
    await client.startContainer(proxyName);
    await waitForProxy();
  }

  async function waitForProxy(): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const logs = await logsOf(proxyName);
      if (logs.includes("Egress proxy listening")) return;
      await Bun.sleep(500);
    }
    throw new Error(
      `egress proxy never came up; logs were:\n${await logsOf(proxyName)}`,
    );
  }

  async function logsOf(name: string): Promise<string> {
    const response = await raw(
      "GET",
      `/containers/${name}/logs?stdout=true&stderr=true`,
    );
    return response.ok ? await response.text() : "";
  }

  /**
   * Runs one busybox probe on the worker network and reports what it saw.
   * `Tty` keeps the log stream unmultiplexed so the output reads plainly.
   */
  async function probe(
    command: string,
    environment: string[] = [],
  ): Promise<{ exitCode: number; output: string }> {
    const name = `ap-it-probe-${crypto.randomUUID().slice(0, 8)}`;
    await raw("POST", `/containers/create?name=${name}`, {
      Cmd: ["sh", "-c", command],
      Env: environment,
      HostConfig: { NetworkMode: workerNetwork },
      Image: IMAGE,
      Tty: true,
    });
    try {
      await client.startContainer(name);
      const waited = (await (
        await raw("POST", `/containers/${name}/wait`)
      ).json()) as { StatusCode: number };
      return { exitCode: waited.StatusCode, output: await logsOf(name) };
    } finally {
      await client.stopAndRemoveContainer(name, 1).catch(() => undefined);
    }
  }

  async function raw(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const socket = dockerHost.startsWith("unix://")
      ? dockerHost.slice("unix://".length)
      : undefined;
    const base = socket
      ? "http://docker"
      : dockerHost.replace(/^tcp:\/\//, "http://");
    return fetch(`${base}/v1.44${path}`, {
      method,
      signal: AbortSignal.timeout(120_000),
      ...(socket ? { unix: socket } : {}),
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    } as RequestInit);
  }

  const withProxy = (): string[] => [
    `http_proxy=${proxyUrl}`,
    `https_proxy=${proxyUrl}`,
  ];

  test("the worker network is internal and the backend agrees", async () => {
    const network = await client.inspectNetwork(workerNetwork);
    expect(network).toMatchObject({ Internal: true, Name: workerNetwork });
    await expect(backend.verifyNetworkIsolation()).resolves.toBeUndefined();
  }, 60_000);

  test("without the proxy a worker reaches nothing at all", async () => {
    // The allowlisted upstream, a container on another network and the
    // instance-metadata address are equally unreachable: there is no route.
    const direct = await probe(`wget -T 3 -q -O - http://${allowedName}:8080/`);
    expect(direct.exitCode).not.toBe(0);
    expect(direct.output).not.toContain("allowed-upstream");

    const metadata = await probe(
      "wget -T 3 -q -O - http://169.254.169.254/latest/meta-data/",
    );
    expect(metadata.exitCode).not.toBe(0);

    const gateway = await probe("nc -w 3 -z host.docker.internal 3000");
    expect(gateway.exitCode).not.toBe(0);
  }, 180_000);

  test("the network gateway is not a way back to ports published on the host", async () => {
    // An internal network still has a bridge, and that bridge address is the
    // host. If the worker could open it, every port the dev stack publishes
    // on 0.0.0.0 would be one hop away and the proxy would be decoration.
    const network = await client.inspectNetwork(workerNetwork);
    const gateway = network?.IPAM?.Config?.[0]?.Gateway;
    expect(gateway).toBeTruthy();
    if (!gateway) throw new Error("the worker network has no gateway");
    const hostPort = await publishedPortOf(deniedName);

    // The publish really works, so the refusal below is not vacuous.
    const fromHost = await fetch(`http://127.0.0.1:${hostPort}/`, {
      signal: AbortSignal.timeout(10_000),
    });
    expect(await fromHost.text()).toContain("denied-upstream");

    const direct = await probe(`nc -w 3 -z ${gateway} ${hostPort}`);
    expect(direct.exitCode).not.toBe(0);
    // And the proxy will not carry it either: the gateway is a private
    // address and no allowlist entry names it.
    const proxied = await probe(
      `wget -T 10 -O - http://${gateway}:${hostPort}/ 2>&1`,
      withProxy(),
    );
    expect(proxied.output).toContain("403");
    expect(proxied.output).not.toContain("denied-upstream");
  }, 180_000);

  test("through the proxy an allowlisted destination is reachable", async () => {
    const allowed = await probe(
      `wget -T 10 -q -O - http://${allowedName}:8080/`,
      withProxy(),
    );
    expect(allowed.output).toContain("allowed-upstream");
    expect(allowed.exitCode).toBe(0);
  }, 180_000);

  test("through the proxy everything else is refused", async () => {
    const denied = await probe(
      `wget -T 10 -O - http://${deniedName}:8080/ 2>&1`,
      withProxy(),
    );
    expect(denied.output).toContain("403");
    expect(denied.output).not.toContain("denied-upstream");

    const metadata = await probe(
      "wget -T 10 -O - http://169.254.169.254/latest/meta-data/ 2>&1",
      withProxy(),
    );
    expect(metadata.output).toContain("403");
  }, 240_000);

  test("CONNECT is judged by the same allowlist as plain HTTP", async () => {
    // busybox wget has no TLS, so the tunnel request is spoken by hand. The
    // sleep keeps nc's stdin open long enough for the reply to arrive.
    const connect = (target: string) =>
      probe(
        `{ printf 'CONNECT ${target} HTTP/1.1\\r\\nhost: ${target}\\r\\n\\r\\n'; sleep 3; } | nc ${proxyName} 3128`,
      );
    expect((await connect(`${allowedName}:8080`)).output).toContain(
      "200 Connection Established",
    );
    expect((await connect(`${deniedName}:8080`)).output).toContain("403");
    expect((await connect("169.254.169.254:80")).output).toContain("403");
  }, 240_000);

  test("a worker container launched by the backend gets the proxy variables", async () => {
    const intent: LaunchIntent = {
      bootstrapNonce: `nonce-${suffix}`,
      executionId: `exec-${suffix}`,
      generation: 1,
      image: IMAGE,
      operationId: `op-${suffix}`,
      resources: { cpus: 0.25, memoryBytes: 64 * 1024 * 1024, pidsLimit: 32 },
      sessionId: crypto.randomUUID(),
    };
    const launched = await backend.ensureExecution(intent);
    created.push(launched.providerRef);
    volumes.push(workspaceVolumeFor(intent.sessionId, installationId));
    const inspected = await client.inspectContainer(launched.providerRef);
    expect(inspected?.Config.Env ?? []).toContain(`HTTP_PROXY=${proxyUrl}`);
    expect(inspected?.Config.Env ?? []).toContain(`http_proxy=${proxyUrl}`);
    expect(JSON.stringify(inspected?.HostConfig)).not.toContain("host-gateway");
  }, 180_000);
});
