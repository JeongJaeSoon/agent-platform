import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHealth } from "./healthcheck.ts";
import { createProxyLogger } from "./logger.ts";
import { type EgressProxyServer, startEgressProxy } from "./proxy.ts";
import { sourceDigest } from "./source.ts";

const silent = createProxyLogger("error", () => undefined);
const policy = { allow: [], allowPrivate: [{ host: "api", port: 3000 }] };

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function proxy(digest?: string): Promise<EgressProxyServer> {
  const server = await startEgressProxy({
    logger: silent,
    policy,
    port: 0,
    ...(digest === undefined ? {} : { sourceDigest: digest }),
  });
  cleanups.push(() => server.stop());
  return server;
}

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "egress-checkout-"));
  cleanups.push(() => rmSync(dir, { force: true, recursive: true }));
  writeFileSync(
    join(dir, "proxy.ts"),
    "// pipes bytes to the first upstream\n",
  );
  return dir;
}

const healthz = (server: EgressProxyServer) =>
  `http://127.0.0.1:${server.port}/healthz`;

describe("checkHealth", () => {
  test("a proxy running the source on disk is healthy", async () => {
    const dir = checkout();
    const server = await proxy(sourceDigest(dir));
    expect(await checkHealth({ dir, url: healthz(server) })).toEqual({
      healthy: true,
    });
  });

  test("a checkout moved under a running proxy makes it unhealthy", async () => {
    // qa-main in 94S-319: the proxy started, then the checkout moved to the
    // commit carrying the fix; the process kept the old modules.
    const dir = checkout();
    const server = await proxy(sourceDigest(dir));
    writeFileSync(join(dir, "proxy.ts"), "// frames the answer, then closes\n");
    const verdict = await checkHealth({ dir, url: healthz(server) });
    expect(verdict.healthy).toBe(false);
    if (!verdict.healthy) expect(verdict.reason).toStartWith("stale:");
  });

  test("a proxy that reports no digest is unhealthy", async () => {
    const dir = checkout();
    const server = await proxy();
    const verdict = await checkHealth({ dir, url: healthz(server) });
    expect(verdict).toEqual({
      healthy: false,
      reason: "/healthz reported no source digest",
    });
  });

  test("no proxy listening is unhealthy", async () => {
    const dir = checkout();
    const server = await proxy(sourceDigest(dir));
    const url = healthz(server);
    server.stop();
    const verdict = await checkHealth({ dir, url });
    expect(verdict.healthy).toBe(false);
  });
});

describe("the compose healthcheck script", () => {
  // What compose runs: `bun run /app/src/healthcheck.ts` next to the proxy's
  // own src. main.ts records the same digest at start.
  const script = join(import.meta.dir, "healthcheck.ts");
  // Async: the proxy under test answers from this process's event loop.
  const run = async (port: number) => {
    const child = Bun.spawn(["bun", "run", script], {
      env: { ...process.env, EGRESS_PROXY_PORT: String(port) },
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stderr };
  };

  test("passes against the proxy compose starts (main.ts)", async () => {
    const free = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const port = free.port;
    free.stop(true);
    const child = Bun.spawn(["bun", "run", join(import.meta.dir, "main.ts")], {
      env: {
        ...process.env,
        EGRESS_PRIVATE_ALLOWLIST: "api:3000",
        EGRESS_PROXY_HOST: "127.0.0.1",
        EGRESS_PROXY_PORT: String(port),
        LOG_LEVEL: "error",
      },
      stdout: "ignore",
      stderr: "inherit",
    });
    cleanups.push(() => child.kill());
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const up = await fetch(`http://127.0.0.1:${port}/healthz`)
        .then((response) => response.ok)
        .catch(() => false);
      if (up) break;
      await Bun.sleep(100);
    }
    const result = await run(port);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("fails and says why against a proxy running other source", async () => {
    const server = await proxy("0".repeat(64));
    const result = await run(server.port);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("stale: the running proxy");
  });
});
