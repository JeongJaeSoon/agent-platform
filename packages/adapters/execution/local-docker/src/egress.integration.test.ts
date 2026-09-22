import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type LaunchIntent,
  sessionObjectPrefix,
} from "@agent-platform/platform";
import {
  createLocalstackBucket,
  type LocalstackBucket,
} from "@agent-platform/testkit";
import {
  asPrintfEscapes,
  clientHello,
} from "../../../../../apps/egress-proxy/src/testing/client-hello.ts";
import {
  ENV,
  LABELS,
  LocalDockerBackend,
  workerEnvironmentFor,
} from "./backend.ts";
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
/**
 * A real TLS client for the tunnel: curl on OpenSSL, which sends a plain
 * ClientHello. Bun's own fetch is BoringSSL and sends GREASE ECH, which the
 * proxy refuses on purpose, so it is the negative case below, not this.
 */
const CURL_IMAGE =
  process.env.EGRESS_CURL_TEST_IMAGE ?? "curlimages/curl:8.11.1";
/** The same tag CI runs as a service, so the pull is a cache hit there. */
const LOCALSTACK_IMAGE =
  process.env.LOCALSTACK_TEST_IMAGE ?? "localstack/localstack:3";
const REPOSITORY = resolve(import.meta.dir, "../../../../..");
const PROXY_SOURCE = join(REPOSITORY, "apps/egress-proxy");
const OBJECT_REGION = "ap-northeast-1";
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
  const tlsName = `ap-it-tls-${suffix}`;
  const proxyUrl = `http://${proxyName}:3128`;
  const localstackName = `ap-it-localstack-${suffix}`;
  const created: string[] = [];
  const volumes: string[] = [];
  let bucket: LocalstackBucket;
  let probeDir: string;

  // Built once the bucket exists, since its name is part of the config.
  let backend: LocalDockerBackend;
  const configFor = (bucketName: string): LocalDockerBackendConfig => ({
    allowedNetworks: [workerNetwork],
    apiVersion: "v1.44",
    command: ["sleep", "600"],
    dockerHost,
    egressProxyUrl: proxyUrl,
    gatewayUrl: `http://${allowedName}:8080`,
    homeDir: "/home/worker",
    installationId,
    network: workerNetwork,
    objectStore: {
      accessKeyId: "test",
      bucket: bucketName,
      endpoint: `http://${localstackName}:4566`,
      region: OBJECT_REGION,
      secretAccessKey: "test",
    },
    requestTimeoutMs: 60_000,
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

  beforeAll(async () => {
    await client.version();
    for (const image of [IMAGE, PROXY_IMAGE, LOCALSTACK_IMAGE, CURL_IMAGE]) {
      await client.pullImage(image);
    }
    await client.createNetwork({ Internal: true, Name: workerNetwork });
    await client.createNetwork({ Internal: false, Name: outerNetwork });
    probeDir = await mkdtemp(join(tmpdir(), "ap-object-probe-"));
    await startServer(allowedName, "allowed-upstream");
    await startServer(deniedName, "denied-upstream", true);
    await startTlsServer();
    await startLocalstack();
    await startProxy();
  }, 300_000);

  afterAll(async () => {
    await bucket?.destroy().catch(() => undefined);
    if (probeDir) await rm(probeDir, { recursive: true, force: true });
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
  async function publishedPortOf(
    name: string,
    containerPort = "8080/tcp",
  ): Promise<string> {
    const inspected = (await (
      await raw("GET", `/containers/${name}/json`)
    ).json()) as {
      NetworkSettings: {
        Ports: Record<string, Array<{ HostPort: string }> | null>;
      };
    };
    const port = inspected.NetworkSettings.Ports[containerPort]?.[0]?.HostPort;
    if (!port) throw new Error(`${name} published no host port`);
    return port;
  }

  /**
   * Runs the worker's own object-store module on the worker network with
   * exactly the env the backend would put in a worker container. The
   * repository is mounted read-only into a stock Bun image the way the
   * proxy is, so this is the production factory — bounded S3 client, prefix
   * guard and all — not a re-implementation of it.
   */
  async function objectProbe(
    environment: string[],
  ): Promise<{ exitCode: number; output: string }> {
    const name = `ap-it-object-probe-${crypto.randomUUID().slice(0, 8)}`;
    const script = join(probeDir, `${name}.ts`);
    await writeFile(script, OBJECT_PROBE);
    await raw("POST", `/containers/create?name=${name}`, {
      Cmd: ["bun", "run", "/probe/probe.ts"],
      Env: environment,
      HostConfig: {
        Binds: [`${REPOSITORY}:/app:ro`, `${script}:/probe/probe.ts:ro`],
        NetworkMode: workerNetwork,
        // Bun writes its cache under HOME; the worker's HOME is a tmpfs.
        Tmpfs: { "/home/worker": "rw,size=16m" },
      },
      Image: PROXY_IMAGE,
      Tty: true,
      WorkingDir: "/app",
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

  function workerEnv(sessionId: string): string[] {
    return workerEnvironmentFor(
      configFor(bucket.bucket),
      { executionId: `exec-${suffix}`, generation: 1, sessionId },
      `wln-${suffix}`,
    );
  }

  /**
   * The object store, on the outer network like every other upstream and
   * published to the host so the test can make the bucket and look inside
   * it. Workers only ever see it through the proxy.
   */
  async function startLocalstack(): Promise<void> {
    created.push(localstackName);
    const response = await raw(
      "POST",
      `/containers/create?name=${localstackName}`,
      {
        Env: ["SERVICES=s3", "EAGER_SERVICE_LOADING=1"],
        ExposedPorts: { "4566/tcp": {} },
        HostConfig: {
          NetworkMode: outerNetwork,
          PortBindings: {
            "4566/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
          },
        },
        Image: LOCALSTACK_IMAGE,
      },
    );
    expect(response.status).toBe(201);
    await client.startContainer(localstackName);
    const port = await publishedPortOf(localstackName, "4566/tcp");
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 120_000;
    for (;;) {
      const health = await fetch(`${endpoint}/_localstack/health`, {
        signal: AbortSignal.timeout(5_000),
      }).catch(() => null);
      if (health?.ok) break;
      if (Date.now() > deadline) {
        throw new Error(
          `LocalStack never came up; logs were:\n${await logsOf(localstackName)}`,
        );
      }
      await Bun.sleep(1_000);
    }
    bucket = await createLocalstackBucket({
      env: {
        accessKeyId: "test",
        endpoint,
        region: OBJECT_REGION,
        secretAccessKey: "test",
      },
      prefix: "egress-it",
    });
    backend = new LocalDockerBackend(configFor(bucket.bucket), client);
  }

  /**
   * A TLS upstream on the outer network, so the CONNECT path is exercised
   * by a real handshake and not only by a hand-written request line. The
   * certificate is minted on the host with openssl; only the fixture ever
   * trusts it.
   */
  async function startTlsServer(): Promise<void> {
    const tlsDir = join(probeDir, "tls");
    await mkdir(tlsDir, { recursive: true });
    const generate = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        `/CN=${tlsName}`,
        "-addext",
        `subjectAltName=DNS:${tlsName}`,
        "-keyout",
        join(tlsDir, "key.pem"),
        "-out",
        join(tlsDir, "cert.pem"),
      ],
      { stderr: "pipe", stdout: "ignore" },
    );
    if ((await generate.exited) !== 0) {
      throw new Error(
        `openssl could not mint a test certificate:\n${await new Response(generate.stderr).text()}`,
      );
    }
    await writeFile(join(tlsDir, "server.ts"), TLS_SERVER);
    created.push(tlsName);
    const response = await raw("POST", `/containers/create?name=${tlsName}`, {
      Cmd: ["bun", "run", "/tls/server.ts"],
      HostConfig: {
        Binds: [`${tlsDir}:/tls:ro`],
        NetworkMode: outerNetwork,
      },
      Image: PROXY_IMAGE,
    });
    expect(response.status).toBe(201);
    await client.startContainer(tlsName);
    const deadline = Date.now() + 90_000;
    while (!(await logsOf(tlsName)).includes("tls listening")) {
      if (Date.now() > deadline) {
        throw new Error(
          `TLS upstream never came up; logs were:\n${await logsOf(tlsName)}`,
        );
      }
      await Bun.sleep(500);
    }
  }

  /** curl on the worker network, through the proxy, with the fixture's CA. */
  async function curlProbe(url: string): Promise<{
    exitCode: number;
    output: string;
  }> {
    const name = `ap-it-curl-probe-${crypto.randomUUID().slice(0, 8)}`;
    await raw("POST", `/containers/create?name=${name}`, {
      Cmd: [
        "curl",
        "-sS",
        "--max-time",
        "20",
        "--proxy",
        proxyUrl,
        "--cacert",
        "/tls/cert.pem",
        url,
      ],
      HostConfig: {
        Binds: [`${join(probeDir, "tls")}:/tls:ro`],
        NetworkMode: workerNetwork,
      },
      Image: CURL_IMAGE,
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

  /**
   * Bun's fetch on the worker network, told to use the proxy: a BoringSSL
   * client, whose ClientHello carries GREASE ECH.
   */
  async function bunFetchProbe(url: string): Promise<{
    exitCode: number;
    output: string;
  }> {
    const name = `ap-it-tls-probe-${crypto.randomUUID().slice(0, 8)}`;
    const script = join(probeDir, `${name}.ts`);
    await writeFile(
      script,
      `const response = await fetch(${JSON.stringify(url)}, {
  proxy: ${JSON.stringify(proxyUrl)},
  tls: { rejectUnauthorized: false },
});
console.log("TLS " + response.status + " " + (await response.text()));
`,
    );
    await raw("POST", `/containers/create?name=${name}`, {
      Cmd: ["bun", "run", "/probe/probe.ts"],
      HostConfig: {
        Binds: [`${script}:/probe/probe.ts:ro`],
        NetworkMode: workerNetwork,
      },
      Image: PROXY_IMAGE,
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

  async function startProxy(): Promise<void> {
    created.push(proxyName);
    const response = await raw("POST", `/containers/create?name=${proxyName}`, {
      Cmd: ["bun", "run", "/app/src/main.ts"],
      Env: [
        `EGRESS_PRIVATE_ALLOWLIST=${allowedName}:8080,${localstackName}:4566,${tlsName}:8443`,
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

  test("a real TLS client handshakes through the tunnel when its server name is the authority", async () => {
    // Verified against the fixture CA, so the tunnel carried a genuine
    // handshake with the upstream and not merely bytes.
    const result = await curlProbe(`https://${tlsName}:8443/`);
    expect(result.output).toContain("tls-upstream");
    expect(result.exitCode).toBe(0);
    expect(await logsOf(tlsName)).toContain(`served ${tlsName}:8443`);
  }, 240_000);

  test("a client that sends GREASE ECH is refused, Bun's own fetch included", async () => {
    // Measured on Bun 1.3.x: fetch and node:https send encrypted_client_hello
    // on every hello. The proxy cannot tell GREASE from real ECH, so it is
    // refused, and this pins that consequence where a runtime upgrade would
    // change it.
    const before = await logsOf(proxyName);
    const result = await bunFetchProbe(`https://${tlsName}:8443/`);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).not.toContain("tls-upstream");
    const after = (await logsOf(proxyName)).slice(before.length);
    expect(after).toContain("encrypted_client_hello");
  }, 240_000);

  test("a tunnel to an allowlisted authority is cut when the handshake names another host", async () => {
    // busybox has no TLS client, so the ClientHello is spelled out for
    // printf: the same bytes a client would send, with the server name of
    // a host the allowlist never judged.
    const hello = asPrintfEscapes(clientHello({ serverNames: [deniedName] }));
    const before = await logsOf(proxyName);
    const result = await probe(
      `{ printf 'CONNECT ${tlsName}:8443 HTTP/1.1\\r\\nhost: ${tlsName}:8443\\r\\n\\r\\n'; sleep 1; printf '${hello}'; sleep 3; } | nc ${proxyName} 3128`,
    );
    expect(result.output).toContain("200 Connection Established");
    const after = (await logsOf(proxyName)).slice(before.length);
    expect(after).toContain("failed the gate");
    expect(after).toContain(
      `server name ${deniedName} is not the CONNECT authority ${tlsName}`,
    );
    // And the TLS upstream never heard from that client at all.
    expect(await logsOf(tlsName)).not.toContain(deniedName);
  }, 240_000);

  test("through the proxy the worker's object store reaches its session prefix and nothing else", async () => {
    const sessionId = crypto.randomUUID();
    const result = await objectProbe(workerEnv(sessionId));
    expect(result.output).toContain("PROBE ");
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(
      result.output.slice(result.output.indexOf("PROBE ") + "PROBE ".length),
    ) as Record<string, unknown>;
    expect(report).toEqual({
      conflict: "conflict",
      duplicate: "duplicate",
      foreignGet: "ObjectScopeError",
      foreignList: "ObjectScopeError",
      foreignPut: "ObjectScopeError",
      get: '{"revision":0}',
      head: 14,
      list: [
        `${sessionObjectPrefix(sessionId)}checkpoints/0000000000/a1/manifest.json`,
      ],
      put: "ok",
      putImmutable: "created",
    });
    // What the probe wrote is really in the bucket, under the session.
    const stored = await bucket.s3.send(
      new (await import("@aws-sdk/client-s3")).ListObjectsV2Command({
        Bucket: bucket.bucket,
        Prefix: sessionObjectPrefix(sessionId),
      }),
    );
    expect((stored.Contents ?? []).map((o) => o.Key).sort()).toEqual([
      `${sessionObjectPrefix(sessionId)}checkpoints/0000000000/a1/manifest.json`,
      `${sessionObjectPrefix(sessionId)}transcript/part-0`,
    ]);
  }, 300_000);

  test("without the proxy variables the same object store reaches nothing", async () => {
    // A refusal by the wrapper looks nothing like this: the request leaves
    // the process and dies on the internal network, so the first call fails
    // with a network error and the probe exits non-zero before "PROBE".
    const environment = workerEnv(crypto.randomUUID()).filter(
      (entry) => !/^(https?_proxy|HTTPS?_PROXY)=/.test(entry),
    );
    const result = await objectProbe(environment);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).not.toContain("PROBE ");
  }, 300_000);

  test("a worker container launched by the backend gets the proxy variables", async () => {
    const intent: LaunchIntent = {
      executionId: `exec-${suffix}`,
      generation: 1,
      image: IMAGE,
      issueBootstrapNonce: async () => `wln-${suffix}`,
      operationId: `op-${suffix}`,
      resources: { cpus: 0.25, memoryBytes: 64 * 1024 * 1024, pidsLimit: 32 },
      sessionId: crypto.randomUUID(),
    };
    const launched = await backend.ensureExecution(intent);
    created.push(launched.providerRef);
    for (const volume of await client.listVolumes([
      `${LABELS.sessionId}=${intent.sessionId}`,
    ])) {
      volumes.push(volume.Name);
    }
    const inspected = await client.inspectContainer(launched.providerRef);
    expect(inspected?.Config.Env ?? []).toContain(`HTTP_PROXY=${proxyUrl}`);
    expect(inspected?.Config.Env ?? []).toContain(`http_proxy=${proxyUrl}`);
    expect(inspected?.Config.Env ?? []).toContain(
      `${ENV.objectEndpoint}=http://${localstackName}:4566`,
    );
    expect(inspected?.Config.Env ?? []).toContain(
      `${ENV.objectPrefix}=${sessionObjectPrefix(intent.sessionId)}`,
    );
    expect(JSON.stringify(inspected?.HostConfig)).not.toContain("host-gateway");
  }, 180_000);
});

/** Answers one line over TLS; written to the fixture directory at run time. */
const TLS_SERVER = `
Bun.serve({
  port: 8443,
  tls: { cert: Bun.file("/tls/cert.pem"), key: Bun.file("/tls/key.pem") },
  fetch: (request) => {
    console.log("served " + new URL(request.url).host);
    return new Response("tls-upstream");
  },
});
console.log("tls listening");
`;

/**
 * Everything the worker's store must do, from inside the container, reported
 * as one JSON line. Written to a file at run time so no probe script lives
 * in the source tree; it imports the module under test from the mounted
 * repository, which is what makes this the real factory.
 */
const OBJECT_PROBE = `
const { createWorkerObjectStore, objectStoreConfigFromEnv } = await import(
  "/app/apps/worker/src/object-store.ts"
);
const store = createWorkerObjectStore(objectStoreConfigFromEnv(process.env));
const prefix = process.env.WORKER_OBJECT_PREFIX;
const key = prefix + "checkpoints/0000000000/a1/manifest.json";
const encode = (text) => new TextEncoder().encode(text);
const refusal = async (run) => {
  try {
    await run();
    return "allowed";
  } catch (error) {
    return error.name;
  }
};
const report = {};
report.putImmutable = (await store.putImmutable(key, encode('{"revision":0}'))).outcome;
report.duplicate = (await store.putImmutable(key, encode('{"revision":0}'))).outcome;
report.conflict = (await store.putImmutable(key, encode('{"revision":1}'))).outcome;
await store.put(prefix + "transcript/part-0", encode("part"));
report.put = "ok";
report.get = new TextDecoder().decode(await store.get(key));
report.head = (await store.head(key))?.bytes;
report.list = await store.list(prefix + "checkpoints/");
const foreign = "sessions/" + crypto.randomUUID() + "/checkpoints/0000000000/a1/manifest.json";
report.foreignGet = await refusal(() => store.get(foreign));
report.foreignPut = await refusal(() => store.put(foreign, encode("x")));
report.foreignList = await refusal(() => store.list("sessions/"));
console.log("PROBE " + JSON.stringify(report));
`;
