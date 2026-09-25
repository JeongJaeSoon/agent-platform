import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSessionCatalog } from "@agent-platform/control-host/src/api/catalog-config.ts";
import { egressProxyConfigFromEnv } from "@agent-platform/egress-proxy/src/config.ts";
import {
  installationLimitsFromEnv,
  providerUpstreamOf,
  runtimeProviderOf,
} from "@agent-platform/platform";
import { LOCAL_LAYERS, layeredServices } from "../compose-layers.ts";

/**
 * The plumbing of `tests/e2e/run.sh --real-model` (94S-373), without Docker
 * or a key: the catalog it mounts, the overlay that hands the key to the API
 * alone, and the script itself run against stand-ins for docker and bun.
 * The paid run is the user's (docs/quickstart.md).
 */
const ROOT = join(import.meta.dir, "../..");
const CATALOG = join(ROOT, "tests/e2e/real-model");
const RUN = join(ROOT, "tests/e2e/run.sh");
const KEY_VARIABLE = "ANTHROPIC_API_KEY";
const PROBE = `leak-probe-${crypto.randomUUID()}`;

type Service = { environment?: Record<string, string | null> };
type Compose = { services: Record<string, Service> };

const compose = async (path: string) =>
  Bun.YAML.parse(await Bun.file(join(ROOT, path)).text()) as Compose;

/** A service's environment as compose resolves it with nothing set. */
function defaults(...layers: Array<Service | undefined>) {
  const env: Record<string, string> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer?.environment ?? {})) {
      if (typeof value === "string") {
        env[key] = value.replace(/\$\{[A-Z_]+:-([^}]*)\}/g, "$1");
      }
    }
  }
  return env;
}

describe("real-model catalog", () => {
  test("its one profile calls api.anthropic.com with the key from the API's environment", async () => {
    const catalog = await loadSessionCatalog({
      dir: CATALOG,
      env: { [KEY_VARIABLE]: PROBE },
      readSecret: async () => {
        throw new Error("the real-model catalog reads no secret");
      },
    });
    expect(Object.keys(catalog.profiles)).toEqual(["claude-coding-real"]);
    expect(catalog.repositories["sample-app"]?.profiles).toEqual([
      "claude-coding-real",
    ]);
    const profile = catalog.profiles["claude-coding-real"];
    if (profile === undefined) throw new Error("no profile");
    expect(providerUpstreamOf(profile)).toEqual({
      url: "https://api.anthropic.com",
      headers: [["x-api-key", PROBE]],
    });
    // What a worker is handed: the route and its egress token, no key.
    const worker = runtimeProviderOf(profile, "egress-token");
    expect(worker.auth).toEqual({
      kind: "egress_token",
      token: "egress-token",
    });
    expect(JSON.stringify(worker)).not.toContain(PROBE);
  });

  test("without the key the API does not start", async () => {
    for (const env of [{}, { [KEY_VARIABLE]: "" }]) {
      await expect(
        loadSessionCatalog({
          dir: CATALOG,
          env,
          readSecret: async () => undefined,
        }),
      ).rejects.toThrow(`value_env: ${KEY_VARIABLE} is not set`);
    }
  });
});

describe("real-model compose overlay", () => {
  test("only the API is given the key, by name and never by value", async () => {
    const files = [
      ...LOCAL_LAYERS,
      "tests/e2e/compose.yml",
      "tests/e2e/compose.real-model.yml",
    ];
    for (const file of files) {
      for (const [name, service] of Object.entries(
        (await compose(file)).services,
      )) {
        const env = service.environment ?? {};
        if (file.endsWith("real-model.yml") && name === "api") {
          expect(env[KEY_VARIABLE]).toBeNull();
        } else {
          expect(Object.hasOwn(env, KEY_VARIABLE)).toBe(false);
        }
      }
    }
    const overlay = await Bun.file(
      join(ROOT, "tests/e2e/compose.real-model.yml"),
    ).text();
    expect(overlay).toContain("../tests/e2e/real-model:/app/config:ro");
  });

  test("the proxy allows the profile's endpoint and the limits cap one run", async () => {
    const base = layeredServices<Service>(LOCAL_LAYERS);
    const overlay = (await compose("tests/e2e/compose.real-model.yml"))
      .services;
    const endpoint = new URL("https://api.anthropic.com");
    const proxy = egressProxyConfigFromEnv(defaults(base["egress-proxy"]));
    // The provider route's upstream, never the forward proxy's (94S-383).
    const destination = { host: endpoint.hostname, port: 443 };
    expect(proxy.credential?.allow).toContainEqual(destination);
    expect(proxy.allow).not.toContainEqual(destination);
    expect(overlay["egress-proxy"]).toBeUndefined();
    for (const name of ["api", "scheduler"]) {
      const limits = installationLimitsFromEnv(
        defaults(base[name], overlay[name]),
      );
      expect(limits.sessionCostLimitUsd).toBe(1);
      expect(limits.maxTurnSeconds).toBe(600);
    }
  });
});

describe("run.sh --real-model", () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "real-model-run-"));
    const stubs = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", stubs]);
    // Answers what run.sh asks of docker, writing every argument list down.
    const docker = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$STUB_ARGV"
case "$*" in
  "version --format"*) echo 28.1.0 ;;
  *" exec -T api "*) echo e2e-platform-key ;;
  *" logs --no-color worker") echo "worker-1  | 2.1.270 (Claude Code)" ;;
  *" logs --no-color --timestamps")
    echo "api-1  | listening"
    if [ -n "\${STUB_LEAK:-}" ]; then echo "api-1  | \${${KEY_VARIABLE}}"; fi ;;
  *" port api 3000") echo 127.0.0.1:40000 ;;
  *" port fake-messages 4011") echo 127.0.0.1:40001 ;;
  "image inspect"*) echo sha256:0000 ;;
esac
`;
    const bun = `#!/usr/bin/env bash
printf 'bun %s key=%s\\n' "$*" "\${${KEY_VARIABLE}:+present}" >>"$STUB_ARGV"
echo " 1 pass"
echo " 0 fail"
`;
    for (const [name, text] of [
      ["docker", docker],
      ["bun", bun],
    ] as const) {
      await Bun.write(join(stubs, name), text);
      chmodSync(join(stubs, name), 0o755);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(
    name: string,
    env: Record<string, string>,
    args = ["--real-model"],
  ) {
    const out = join(dir, name);
    const argv = join(dir, `${name}.argv`);
    const result = Bun.spawnSync(["bash", RUN, ...args], {
      cwd: ROOT,
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        HOME: dir,
        TMPDIR: dir,
        E2E_OUT: out,
        STUB_ARGV: argv,
        ...env,
      },
    });
    const read = (path: string) => {
      const file = Bun.file(path);
      return file.size > 0 ? file.text() : Promise.resolve("");
    };
    return {
      status: result.exitCode,
      stderr: result.stderr.toString(),
      argv: read(argv),
      out,
    };
  }

  async function recordText(out: string): Promise<string> {
    const texts: string[] = [];
    const walk = (path: string) => {
      for (const item of readdirSync(path, { withFileTypes: true })) {
        if (item.isDirectory()) walk(join(path, item.name));
        else if (item.isFile()) texts.push(join(path, item.name));
      }
    };
    walk(out);
    return (await Promise.all(texts.map((path) => Bun.file(path).text()))).join(
      "\n",
    );
  }

  test("stops before Docker when the key is unset or empty", async () => {
    for (const [name, env] of [
      ["unset", {}],
      ["empty", { [KEY_VARIABLE]: "" }],
    ] as const) {
      const result = run(`no-key-${name}`, env);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`${KEY_VARIABLE} is unset or empty`);
      expect(await result.argv).toBe("");
    }
    const unknown = run("bad-arg", { [KEY_VARIABLE]: PROBE }, ["--real"]);
    expect(unknown.status).toBe(2);
    expect(await unknown.argv).toBe("");
  });

  test("runs the real-model suite on the overlay without the key in any argument or record", async () => {
    const result = run("clean", { [KEY_VARIABLE]: PROBE });
    expect(result.status).toBe(0);
    const argv = await result.argv;
    expect(argv).toContain("-f tests/e2e/compose.real-model.yml");
    expect(argv).toContain(
      "bun test ./tests/e2e/real-model.e2e.ts --timeout 900000",
    );
    // The suite gets no key: it drives the public API only.
    expect(argv).toMatch(/^bun test .* key=$/m);
    expect(argv).not.toContain(PROBE);
    const record = await Bun.file(join(result.out, "record.txt")).text();
    expect(record).toContain("command: tests/e2e/run.sh --real-model");
    expect(record).toContain("model: claude-sonnet-5");
    expect(record).toContain("provider_endpoint: https://api.anthropic.com");
    expect(record).toContain("session_cost_limit_usd: 1");
    expect(record).toMatch(/^tested_sha: [0-9a-f]{40} /m);
    expect(await recordText(result.out)).not.toContain(PROBE);
    expect(result.stderr).not.toContain(PROBE);
  });

  test("fails, naming the file but not the value, when the key reaches the record", async () => {
    const result = run("leak", { [KEY_VARIABLE]: PROBE, STUB_LEAK: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("value is in the record");
    expect(result.stderr).toContain(join(result.out, "compose.log"));
    expect(result.stderr).not.toContain(PROBE);
  });

  test("the scripted run keeps its suites and adds no overlay", async () => {
    const result = run("fake", { [KEY_VARIABLE]: PROBE }, []);
    expect(result.status).toBe(0);
    const argv = await result.argv;
    expect(argv).not.toContain("compose.real-model.yml");
    expect(argv).toContain(
      "bun test ./tests/e2e/alpha-path.e2e.ts ./tests/e2e/pause-coverage.e2e.ts --timeout 900000",
    );
    const record = await Bun.file(join(result.out, "record.txt")).text();
    expect(record).toContain("command: tests/e2e/run.sh\n");
    expect(record).not.toContain("model:");
  });
});
