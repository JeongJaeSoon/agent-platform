import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ProxyLogger } from "@agent-platform/egress-proxy/src/logger.ts";
import {
  type EgressProxyServer,
  startEgressProxy,
} from "@agent-platform/egress-proxy/src/proxy.ts";
import { ClaudeSdkRuntime } from "@agent-platform/runtime-claude";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
} from "@agent-platform/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@agent-platform/testkit/workspace";

/**
 * The worker container learns its only route off the worker network through
 * `HTTP_PROXY`/`HTTPS_PROXY` (94S-199), but the engine is a child process
 * with an environment the adapter builds from scratch. This runs the actual
 * SDK child against the actual egress proxy, in-process, with the proxy as
 * the only allowlisted path to a local fake Messages API — the topology the
 * container will have, minus the container (94S-245).
 *
 * Two shapes, because the proxy has two code paths: absolute-form HTTP for a
 * plaintext endpoint, and `CONNECT` for the TLS endpoint production uses.
 */

const HOST_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

type Seen = { host: string; method: string; port: number };

let isolated: IsolatedWorkspace | undefined;
let proxy: EgressProxyServer | undefined;
let server: FakeAnthropicServer | undefined;
const hostVariables = new Map<string, string | undefined>();

afterEach(async () => {
  proxy?.stop();
  server?.stop();
  await isolated?.dispose();
  for (const [name, value] of hostVariables) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  hostVariables.clear();
  isolated = undefined;
  proxy = undefined;
  server = undefined;
});

describe("SDK child process behind the egress proxy", () => {
  test("reaches a plaintext Messages endpoint as an absolute-form request", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-245-" });
    server = startFakeAnthropicServer(textReply("through the proxy"));
    const { allowed, denied } = await startProxyFor(server);

    await runOneTurn(isolated, server);

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers["x-api-key"]).toBe("placeholder-local");
    expect(denied).toEqual([]);
    expect(allowed).toEqual([endpointOf(server, "forward")]);
  }, 30_000);

  test("tunnels to a TLS Messages endpoint with CONNECT", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-245-" });
    const certificate = await selfSignedCertificate(isolated.root);
    server = startFakeAnthropicServer(textReply("through the tunnel"), {
      tls: certificate,
    });
    const { allowed, denied } = await startProxyFor(server);

    // The bundle is named on the config. The host's own trust settings are
    // left pointing at nothing useful to prove they are not what got through.
    process.env.NODE_EXTRA_CA_CERTS = "/nonexistent/host-ca.pem";
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
    await runOneTurn(isolated, server, { trustedCaBundle: certificate.path });

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers["x-api-key"]).toBe("placeholder-local");
    expect(denied).toEqual([]);
    // Every CONNECT the child opened went to the endpoint; without the
    // forwarded variables the child dials it directly and this stays empty.
    expect(allowed.length).toBeGreaterThan(0);
    expect(new Set(allowed.map((seen) => JSON.stringify(seen)))).toEqual(
      new Set([JSON.stringify(endpointOf(server, "connect"))]),
    );
  }, 30_000);
});

async function startProxyFor(
  endpoint: FakeAnthropicServer,
): Promise<{ allowed: Seen[]; denied: string[] }> {
  const target = new URL(endpoint.url);
  const allowed: Seen[] = [];
  const denied: string[] = [];
  const logger: ProxyLogger = {
    debug() {},
    error() {},
    info(message, fields) {
      if (message !== "Egress allowed") return;
      allowed.push({
        host: String(fields?.host),
        method: String(fields?.method),
        port: Number(fields?.port),
      });
    },
    warn(message, fields) {
      denied.push(`${message} ${JSON.stringify(fields ?? {})}`);
    },
  };
  proxy = await startEgressProxy({
    hostname: "127.0.0.1",
    logger,
    policy: {
      allow: [],
      allowPrivate: [{ host: target.hostname, port: Number(target.port) }],
    },
    port: 0,
  });
  // Exactly what the local-docker backend hands the worker, except that its
  // loopback exemption would let this test's endpoint bypass the proxy.
  const proxyUrl = `http://127.0.0.1:${proxy.port}`;
  const values: Record<string, string> = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: "egress-proxy.invalid",
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    no_proxy: "egress-proxy.invalid",
  };
  for (const name of HOST_VARIABLES) {
    hostVariables.set(name, process.env[name]);
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return { allowed, denied };
}

async function runOneTurn(
  workspace: IsolatedWorkspace,
  endpoint: FakeAnthropicServer,
  extra: { trustedCaBundle?: string } = {},
): Promise<void> {
  const { home } = workspace;
  const runtime = new ClaudeSdkRuntime({
    endpoints: [endpoint.url],
    models: ["claude-sonnet-4-5"],
  });
  const run = runtime.start(
    {
      claudeConfigDir: home,
      correlationId: "94s-245-proxy",
      cwd: workspace.workspace,
      home,
      maxTurns: 1,
      mode: "new",
      model: "claude-sonnet-4-5",
      profile: {
        kind: "anthropic",
        endpoint: endpoint.url,
        auth: { kind: "api_key", value: "placeholder-local" },
      },
      settingSources: ["project"],
      tools: [],
      ...extra,
    },
    {
      onPermission: async () => ({
        behavior: "deny",
        message: "No tools expected",
      }),
    },
  );
  run.send({ message: "hello through the proxy", uuid: crypto.randomUUID() });
  run.finishInput();
  let results = 0;
  for await (const frame of run) {
    if (frame.envelope.message.type === "result") results += 1;
  }
  expect(results).toBe(1);
}

function endpointOf(endpoint: FakeAnthropicServer, method: string): Seen {
  const target = new URL(endpoint.url);
  return { host: target.hostname, method, port: Number(target.port) };
}

/** A throwaway loopback certificate; the engine trusts it via `trustedCaBundle`. */
async function selfSignedCertificate(
  directory: string,
): Promise<{ cert: string; key: string; path: string }> {
  const certPath = join(directory, "fake-anthropic.crt");
  const keyPath = join(directory, "fake-anthropic.key");
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
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stderr: "pipe", stdout: "ignore" },
  );
  if ((await generate.exited) !== 0) {
    throw new Error(
      `openssl could not mint a test certificate:\n${await new Response(generate.stderr).text()}`,
    );
  }
  return {
    cert: await Bun.file(certPath).text(),
    key: await Bun.file(keyPath).text(),
    path: certPath,
  };
}
