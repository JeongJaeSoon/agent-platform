import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSessionCatalog } from "@agent-platform/control-host/src/api/catalog-config.ts";
import { egressProxyConfigFromEnv } from "@agent-platform/egress-proxy/src/config.ts";
import { providerUpstreamOf } from "@agent-platform/platform";
import { LOCAL_LAYERS, layeredServices } from "../compose-layers.ts";

/**
 * The plumbing of `tests/e2e/run.sh --local-model`, without Docker or
 * Ollama: the catalog the API reads, the overlay that lets the egress proxy
 * reach both routes to the model, and the runner's stop when there is no
 * Ollama.
 */
const ROOT = join(import.meta.dir, "../..");
const CATALOG = join(ROOT, "config/local-model");
const OVERLAY = "infra/compose.local-model.yml";
const RUN = join(ROOT, "tests/e2e/run.sh");
const KEYS = ["LOCAL_OLLAMA_API_KEY", "LITELLM_MASTER_KEY"] as const;

type Service = { environment?: Record<string, string | null> };

const overlay = async () =>
  (
    Bun.YAML.parse(await Bun.file(join(ROOT, OVERLAY)).text()) as {
      services: Record<string, Service>;
    }
  ).services;

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

const catalog = () =>
  loadSessionCatalog({
    dir: CATALOG,
    env: {
      LOCAL_OLLAMA_API_KEY: "ollama-probe",
      LITELLM_MASTER_KEY: "sk-probe",
    },
    readSecret: async () => {
      throw new Error("the local-model catalog reads no secret");
    },
  });

describe("local-model catalog", () => {
  test("one profile calls Ollama with a key, the other LiteLLM with a bearer", async () => {
    const { profiles, repositories } = await catalog();
    expect(Object.keys(profiles)).toEqual(["local-ollama", "local-litellm"]);
    expect(repositories["sample-app"]?.profiles).toEqual([
      "local-ollama",
      "local-litellm",
    ]);
    const [ollama, litellm] = [
      profiles["local-ollama"],
      profiles["local-litellm"],
    ];
    if (ollama === undefined || litellm === undefined) {
      throw new Error("missing profile");
    }
    expect(providerUpstreamOf(ollama)).toEqual({
      url: "http://ollama.internal:11434",
      headers: [["x-api-key", "ollama-probe"]],
    });
    expect(providerUpstreamOf(litellm)).toEqual({
      url: "http://litellm:4000",
      headers: [["authorization", "Bearer sk-probe"]],
    });
  });
});

describe("local-model compose overlay", () => {
  test("the API reads config/local-model and alone holds the Ollama key", async () => {
    const services = await overlay();
    const api = layeredServices<Service & { volumes?: string[] }>([
      ...LOCAL_LAYERS,
      OVERLAY,
    ]).api;
    expect(api?.volumes).toContain("../config:/app/config:ro");
    expect(api?.environment?.PLATFORM_CONFIG_DIR).toBe(
      "/app/config/local-model",
    );
    for (const [name, service] of Object.entries(services)) {
      const env = service.environment ?? {};
      for (const key of KEYS) {
        const holds =
          name === "api" ||
          (name === "litellm" && key === "LITELLM_MASTER_KEY");
        // By name, from the caller's environment, never a value.
        if (holds) expect(env[key]).toBeNull();
        else expect(Object.hasOwn(env, key)).toBe(false);
      }
    }
  });

  test("the proxy reaches every profile's endpoint on the credential route alone", async () => {
    const base = layeredServices<Service>(LOCAL_LAYERS);
    const proxy = egressProxyConfigFromEnv(
      defaults(base["egress-proxy"], (await overlay())["egress-proxy"]),
    );
    const forward = [...proxy.allow, ...proxy.allowPrivate];
    for (const profile of Object.values((await catalog()).profiles)) {
      const url = new URL(profile.provider.endpoint);
      const destination = { host: url.hostname, port: Number(url.port) };
      expect(proxy.credential?.allowPrivate).toContainEqual(destination);
      expect(forward).not.toContainEqual(destination);
    }
    // What the local stack's own catalog needs stays on the list.
    for (const kept of [
      "gitea:3000",
      "fake-messages:4010",
      "localstack:4566",
    ]) {
      const [host, port] = kept.split(":");
      expect(proxy.credential?.allowPrivate).toContainEqual({
        host,
        port: Number(port),
      });
    }
  });
});

describe("run.sh --local-model", () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "local-model-run-"));
    const stubs = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", stubs]);
    for (const [name, text] of [
      ["docker", `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>"$STUB_ARGV"\n`],
      ["curl", "#!/usr/bin/env bash\nexit 7\n"],
    ] as const) {
      await Bun.write(join(stubs, name), text);
      chmodSync(join(stubs, name), 0o755);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("without Ollama it stops before touching Docker", async () => {
    const argv = join(dir, "argv");
    const result = Bun.spawnSync(["bash", RUN, "--local-model"], {
      cwd: ROOT,
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        HOME: dir,
        TMPDIR: dir,
        E2E_OUT: join(dir, "out"),
        STUB_ARGV: argv,
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain(
      "no Ollama on 127.0.0.1:11434; nothing was started",
    );
    expect(await Bun.file(argv).exists()).toBe(false);
  });
});
