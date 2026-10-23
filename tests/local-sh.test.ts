import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * scripts/local.sh against stand-ins for docker and curl: the
 * ports it checks, the /readyz it waits on and the worker label `down`
 * deletes all come from the stack compose renders, whatever
 * COMPOSE_PROJECT_NAME, COMPOSE_FILE or EXECUTION_INSTALLATION_ID made it.
 * tests/images.test.ts holds the real render to the fields read here.
 */

const script = join(import.meta.dir, "..", "scripts/local.sh");

const rendered = (
  id: string | undefined,
  ports: string[] = [],
  hostIps: string[] = ports.map(() => "127.0.0.1"),
) =>
  JSON.stringify({
    services: {
      api: {
        ports: ports.map((published, i) => ({
          host_ip: hostIps[i],
          published,
          target: 3000,
        })),
      },
      scheduler: {
        environment: id === undefined ? {} : { EXECUTION_INSTALLATION_ID: id },
      },
    },
  });

describe("scripts/local.sh", () => {
  let dir: string;
  let config: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-sh-"));
    config = join(dir, "config.json");
    await mkdir(join(dir, "bin"));
    await writeFile(
      join(dir, "bin", "docker"),
      `#!/bin/sh
echo "$*" >> "${dir}/docker-calls"
case "$*" in
  "version --format"*) echo 28.1.0 ;;
  "compose version --short") echo 2.39.1 ;;
  *" config --format json") cat "${config}" ;;
  *" port api 3000") [ -z "$STUB_API" ] || echo "$STUB_API" ;;
  *" ps --format "*) echo "$STUB_OURS" ;;
  *" ps -aq egress-proxy")
    [ -z "$STUB_PROXY" ] || echo "$STUB_PROXY"
    exit "\${STUB_PROXY_EXIT:-0}" ;;
  "inspect --format "*) echo "$STUB_STARTED_ID" ;;
  *" down -v --remove-orphans") exit "\${STUB_DOWN_EXIT:-0}" ;;
  "context inspect --format "*) echo "$STUB_CONTEXT" ;;
  *" exec -T -e DEMO_ACCOUNTS=local api "*) exit "\${STUB_SEED_EXIT:-0}" ;;
esac
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(dir, "bin", "curl"),
      `#!/bin/sh
for a; do url=$a; done
echo "$url" >> "${dir}/curl-calls"
echo '{"status":"ready"}'
`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  async function run(args: string[], env: Record<string, string> = {}) {
    const handle = Bun.spawn(["bash", script, ...args], {
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        COMPOSE_FILE: "",
        ANTHROPIC_API_KEY: "",
        AGENT_PLATFORM_DOTENV: join(dir, "no.env"),
        STUB_API: "",
        STUB_OURS: "",
        STUB_PROXY: "",
        STUB_STARTED_ID: "",
        STUB_CONTEXT: "unix:///var/run/docker.sock",
        LOCAL_DEMO_ACCOUNTS: "",
        ...env,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = await Promise.all([
      handle.exited,
      new Response(handle.stderr).text(),
      new Response(handle.stdout).text(),
    ]);
    return { exitCode, stderr, stdout };
  }

  const calls = async (name: string) =>
    (await readFile(join(dir, name), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);

  // status, down and key take no mode, so they see a --fake-model stack too.
  const noMode = "compose --profile apps --profile fake-model";
  const realUp =
    "compose --profile apps -f compose.yaml -f infra/compose.real-model.yml up -d --build";
  const key = { ANTHROPIC_API_KEY: "sk-test" };

  const deletions = (id: string) => [
    `${noMode} down -v --remove-orphans`,
    `ps -aq --filter label=agent-platform.installation=${id}`,
    `network ls -q --filter label=agent-platform.installation=${id}`,
    `volume ls -q --filter label=agent-platform.installation=${id}`,
  ];

  test("parses as bash", () => {
    expect(Bun.spawnSync(["bash", "-n", script]).exitCode).toBe(0);
  });

  test("down deletes the workers of the id the running stack was started with", async () => {
    await writeFile(config, rendered("local"));
    const result = await run(["down"], {
      STUB_PROXY: "proxy-id",
      STUB_STARTED_ID: "ap434local",
    });
    expect(result.exitCode).toBe(0);
    expect(await calls("docker-calls")).toEqual([
      `${noMode} ps -aq egress-proxy`,
      'inspect --format {{index .Config.Labels "agent-platform.egress-proxy"}} proxy-id',
      ...deletions("ap434local"),
    ]);
  });

  test.each(["local", "ap434local"])(
    "with no container left, down deletes the workers of the id compose renders: %p",
    async (id) => {
      await writeFile(config, rendered(id));
      const result = await run(["down"]);
      expect(result.exitCode).toBe(0);
      expect(await calls("docker-calls")).toEqual([
        `${noMode} ps -aq egress-proxy`,
        `${noMode} config --format json`,
        ...deletions(id),
      ]);
    },
  );

  test("down deletes nothing when it cannot tell the installation", async () => {
    for (const [text, env] of [
      [undefined, {}],
      [rendered(undefined), {}],
      [rendered("local"), { STUB_PROXY: "proxy-id" }],
      // Not "no container left": the render may name another installation.
      [rendered("local"), { STUB_PROXY_EXIT: "1" }],
    ] as const) {
      await rm(config, { force: true });
      if (text !== undefined) await writeFile(config, text);
      const result = await run(["down"], env);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "cannot tell the stack's EXECUTION_INSTALLATION_ID; nothing was deleted",
      );
    }
    expect(
      (await calls("docker-calls")).filter((call) =>
        / (down|rm|ls) /.test(call),
      ),
    ).toEqual([]);
  });

  test("reset stops when down fails", async () => {
    await writeFile(config, rendered("local"));
    const result = await run(["reset"], {
      ...key,
      STUB_API: "127.0.0.1:43123",
      STUB_DOWN_EXIT: "1",
    });
    expect(result.exitCode).not.toBe(0);
    const docker = await calls("docker-calls");
    expect(docker).toContain(`${noMode} down -v --remove-orphans`);
    expect(docker).not.toContain(realUp);
    expect(result.stderr).not.toContain("local.sh: deleted");
  });

  test("forget-lost-checkpoints runs its CLI in a one-off api container and deletes nothing", async () => {
    const result = await run(["forget-lost-checkpoints"]);
    expect(result.exitCode).toBe(0);
    expect(await calls("docker-calls")).toEqual([
      `${noMode} run --rm -T --build api bun run apps/control-host/src/api/forget-lost-checkpoints.ts`,
    ]);
  });

  test("up and status read /readyz where compose publishes the api", async () => {
    await writeFile(config, rendered("local"));
    const up = await run(["up"], { ...key, STUB_API: "127.0.0.1:43123" });
    expect(up).toMatchObject({ exitCode: 0, stdout: '{"status":"ready"}\n' });
    const status = await run(["status"], { STUB_API: "0.0.0.0:43124" });
    expect(status.stdout).toContain('readyz: {"status":"ready"}');
    expect(await calls("curl-calls")).toEqual([
      "http://127.0.0.1:43123/readyz",
      "http://127.0.0.1:43124/readyz",
    ]);

    const stopped = await run(["status"]);
    expect(stopped.stdout).toContain("readyz: \n");
    expect(await calls("curl-calls")).toHaveLength(2);
  });

  test.each([
    [[], key, "infra/compose.real-model.yml"],
    [["--fake-model"], {}, "infra/compose.fake-model.yml"],
  ] as const)(
    "up %p puts its overlay on top of COMPOSE_FILE's files",
    async (mode, env, overlay) => {
      await writeFile(config, rendered("local"));
      const result = await run(["up", ...mode], {
        ...env,
        COMPOSE_FILE: "compose.yaml:ports.yml",
        STUB_API: "127.0.0.1:43123",
      });
      expect(result.exitCode).toBe(0);
      expect(await calls("docker-calls")).toContain(
        `compose --profile apps -f compose.yaml -f ports.yml -f ${overlay} up -d --build`,
      );
    },
  );

  const seed = (prefix: string) =>
    `${prefix} exec -T -e DEMO_ACCOUNTS=local api bun run apps/control-host/src/api/demo-accounts.ts`;
  const fakeUp =
    "compose --profile apps -f compose.yaml -f infra/compose.fake-model.yml";

  test("up adds the demo accounts once the api is ready, and stdout stays /readyz", async () => {
    await writeFile(config, rendered("local", ["43123"]));
    const result = await run(["up", "--fake-model"], {
      STUB_API: "127.0.0.1:43123",
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: '{"status":"ready"}\n',
    });
    const docker = await calls("docker-calls");
    expect(docker.at(-1)).toBe(seed(fakeUp));
    expect(docker).toContain(`${fakeUp} up -d --build`);
  });

  test("an ephemeral loopback binding gets the demo accounts too", async () => {
    await writeFile(
      config,
      JSON.stringify({
        services: {
          api: { ports: [{ host_ip: "127.0.0.1", target: 3000 }] },
          scheduler: { environment: { EXECUTION_INSTALLATION_ID: "local" } },
        },
      }),
    );
    const result = await run(["up", "--fake-model"], {
      STUB_API: "127.0.0.1:43123",
    });
    expect(result.exitCode).toBe(0);
    expect(await calls("docker-calls")).toContain(seed(fakeUp));
  });

  test("demo-accounts adds them to a running stack of either mode", async () => {
    await writeFile(config, rendered("local", ["43123"], ["::1"]));
    const result = await run(["demo-accounts"], { STUB_API: "[::1]:43123" });
    expect(result.exitCode).toBe(0);
    expect(await calls("docker-calls")).toContain(seed(noMode));
  });

  const port = ["43123"];
  test.each([
    [rendered("local", port), { LOCAL_DEMO_ACCOUNTS: "0" }, ""],
    [
      rendered("local", port, [""]),
      {},
      "demo accounts not added: the api listens on 0.0.0.0, not loopback alone",
    ],
    [
      rendered("local", ["43123", "43124"], ["127.0.0.1", "192.168.1.5"]),
      {},
      "demo accounts not added: the api listens on 192.168.1.5, not loopback alone",
    ],
    [
      rendered("local"),
      {},
      "demo accounts not added: the api publishes no port",
    ],
    [
      rendered("local", port),
      { STUB_CONTEXT: "tcp://10.0.0.5:2376" },
      "demo accounts not added: Docker is not this machine's (tcp://10.0.0.5:2376)",
    ],
    [
      rendered("local", port),
      { STUB_CONTEXT: "ssh://dev@build-host" },
      "demo accounts not added: Docker is not this machine's (ssh://dev@build-host)",
    ],
  ])(
    "up leaves the demo accounts out for %p %p",
    async (text, vars, message) => {
      await writeFile(config, text);
      const result = await run(["up", "--fake-model"], {
        STUB_API: "127.0.0.1:43123",
        ...vars,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(message);
      expect(await calls("docker-calls")).not.toContain(seed(fakeUp));
    },
  );

  test("a failed seed fails up and says the stack is up", async () => {
    await writeFile(config, rendered("local", ["43123"]));
    const result = await run(["up", "--fake-model"], {
      STUB_API: "127.0.0.1:43123",
      STUB_SEED_EXIT: "2",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "adding the demo accounts failed; the stack itself is up",
    );
    expect(result.stdout).toBe("");
  });

  test("up and reset without a key start nothing and name --fake-model", async () => {
    await writeFile(config, rendered("local"));
    for (const command of ["up", "reset"]) {
      const result = await run([command]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "up needs ANTHROPIC_API_KEY exported or in .env (docs/real-claude.md), or --fake-model to run without one; nothing was started",
      );
    }
    expect(await calls("docker-calls")).toEqual([]);
  });

  test("the key comes from .env when the shell has none", async () => {
    await writeFile(config, rendered("local"));
    const dotenv = join(dir, "key.env");
    await writeFile(dotenv, "ANTHROPIC_API_KEY='sk-from-dotenv'\n");
    const result = await run(["up"], {
      AGENT_PLATFORM_DOTENV: dotenv,
      STUB_API: "127.0.0.1:43123",
    });
    expect(result.exitCode).toBe(0);
    expect(await calls("docker-calls")).toContain(realUp);
  });

  test("up refuses a rendered port another listener holds, not one its stack does", async () => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    try {
      const port = String(listener.port);
      await writeFile(config, rendered("local", [port]));
      const busy = await run(["up"], { ...key, STUB_API: `127.0.0.1:${port}` });
      expect(busy.exitCode).toBe(1);
      expect(busy.stderr).toContain(`port(s) 127.0.0.1:${port} already in use`);
      expect(await calls("docker-calls")).not.toContainEqual(realUp);

      const elsewhere = await run(["up"], {
        ...key,
        STUB_API: `127.0.0.1:${port}`,
        STUB_OURS: `0.0.0.0:${port}->3000/tcp`,
      });
      expect(elsewhere.exitCode).toBe(1);

      const ours = await run(["up"], {
        ...key,
        STUB_API: `127.0.0.1:${port}`,
        STUB_OURS: `127.0.0.1:${port}->3000/tcp`,
      });
      expect(ours.exitCode).toBe(0);
    } finally {
      listener.stop(true);
    }
  });
});

/**
 * scripts/k8s-api.sh against a kubectl stand-in: the Deployment it execs into
 * follows the chart's fullname rule, and only the three operator CLIs run.
 * It shares this file with local.sh, the other operator wrapper, because the
 * CI integration matrix assigns test files by name.
 */

const k8sApiScript = join(import.meta.dir, "..", "scripts/k8s-api.sh");

describe("scripts/k8s-api.sh", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "k8s-api-sh-"));
    await mkdir(join(dir, "bin"));
    await writeFile(
      join(dir, "bin", "kubectl"),
      `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/kubectl-args"
`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (args: string[], env: Record<string, string> = {}) =>
    Bun.spawnSync([k8sApiScript, ...args], {
      env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, ...env },
      stderr: "pipe",
    });
  const kubectlArgs = async () =>
    (await readFile(join(dir, "kubectl-args"), "utf8")).trimEnd().split("\n");

  test("execs the CLI in the default release's api Deployment", async () => {
    const result = run([
      "keys",
      "create",
      "team a",
      "--scopes",
      "sessions:read",
    ]);
    expect(result.exitCode).toBe(0);
    expect(await kubectlArgs()).toEqual([
      "-n",
      "agent-platform",
      "exec",
      "deploy/agent-platform-api",
      "-c",
      "api",
      "--",
      "bun",
      "run",
      "apps/control-host/src/api/keys.ts",
      "create",
      "team a",
      "--scopes",
      "sessions:read",
    ]);
  });

  test("follows the chart's fullname for another release and namespace", async () => {
    expect(
      run(["catalog-authority", "show"], { NAMESPACE: "ap", RELEASE: "prod" })
        .exitCode,
    ).toBe(0);
    const args = await kubectlArgs();
    expect(args.slice(0, 4)).toEqual([
      "-n",
      "ap",
      "exec",
      "deploy/prod-agent-platform-api",
    ]);
    expect(args).toContain("apps/control-host/src/api/catalog-authority.ts");

    run(["grants", "revoke", "x"], { RELEASE: "agent-platform-blue" });
    expect((await kubectlArgs())[3]).toBe("deploy/agent-platform-blue-api");
  });

  test("truncates the fullname to 50 characters like the chart", async () => {
    // 45 + "-agent-platform" = 60, cut at 50 right after a "-".
    run(["keys", "revoke", "x"], { RELEASE: "r".repeat(45) });
    expect((await kubectlArgs())[3]).toBe(`deploy/${"r".repeat(45)}-agen-api`);

    run(["keys", "revoke", "x"], { RELEASE: "r".repeat(36) });
    expect((await kubectlArgs())[3]).toBe(
      `deploy/${"r".repeat(36)}-agent-platfor-api`,
    );

    run(["keys", "revoke", "x"], { RELEASE: `${"r".repeat(49)}-x` });
    expect((await kubectlArgs())[3]).toBe(`deploy/${"r".repeat(49)}-api`);
  });

  test("refuses any other CLI without calling kubectl", async () => {
    for (const args of [[], ["checkpoint-gc"], ["../keys"]]) {
      const result = run(args);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain("usage:");
    }
    expect(await Bun.file(join(dir, "kubectl-args")).exists()).toBe(false);
  });
});
