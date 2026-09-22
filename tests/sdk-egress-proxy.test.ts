import { afterEach, describe, expect, test } from "bun:test";
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
 */

const PROXY_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

let isolated: IsolatedWorkspace | undefined;
let proxy: EgressProxyServer | undefined;
let server: FakeAnthropicServer | undefined;
const hostProxyVariables = new Map<string, string | undefined>();

afterEach(async () => {
  proxy?.stop();
  server?.stop();
  await isolated?.dispose();
  for (const [name, value] of hostProxyVariables) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  hostProxyVariables.clear();
  isolated = undefined;
  proxy = undefined;
  server = undefined;
});

describe("SDK child process behind the egress proxy", () => {
  test("reaches the Messages endpoint through the proxy the host was given", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-245-" });
    const { home, workspace } = isolated;
    server = startFakeAnthropicServer(textReply("through the proxy"));
    const endpoint = new URL(server.url);
    const allowed: Array<{ host: string; port: number }> = [];
    const denied: string[] = [];
    const logger: ProxyLogger = {
      debug() {},
      error() {},
      info(message, fields) {
        if (message === "Egress allowed") {
          allowed.push({
            host: String(fields?.host),
            port: Number(fields?.port),
          });
        }
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
        allowPrivate: [
          { host: endpoint.hostname, port: Number(endpoint.port) },
        ],
      },
      port: 0,
    });
    // Exactly what the local-docker backend hands the worker, except that
    // the loopback exemption would let this test's endpoint bypass the proxy.
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    setHostProxy({
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      NO_PROXY: "egress-proxy.invalid",
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      no_proxy: "egress-proxy.invalid",
    });

    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });
    const run = runtime.start(
      {
        claudeConfigDir: home,
        correlationId: "94s-245-proxy",
        cwd: workspace,
        home,
        maxTurns: 1,
        mode: "new",
        model: "claude-sonnet-4-5",
        profile: {
          kind: "anthropic",
          endpoint: server.url,
          auth: { kind: "api_key", value: "placeholder-local" },
        },
        settingSources: ["project"],
        tools: [],
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
    const results = [];
    for await (const frame of run) {
      if (frame.envelope.message.type === "result") results.push(frame);
    }

    expect(results).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers["x-api-key"]).toBe("placeholder-local");
    expect(denied).toEqual([]);
    // The proxy saw the Messages call: without the forwarded variables the
    // child dials the endpoint directly and this list stays empty.
    expect(allowed).toContainEqual({
      host: endpoint.hostname,
      port: Number(endpoint.port),
    });
  }, 30_000);
});

function setHostProxy(
  values: Record<(typeof PROXY_VARIABLES)[number], string>,
) {
  for (const name of PROXY_VARIABLES) {
    hostProxyVariables.set(name, process.env[name]);
    process.env[name] = values[name];
  }
}
