import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * scripts/local.sh against stand-ins for docker and curl (94S-439): the
 * ports it checks, the /readyz it waits on and the worker label `down`
 * deletes all come from the stack compose renders, whatever
 * COMPOSE_PROJECT_NAME, COMPOSE_FILE or EXECUTION_INSTALLATION_ID made it.
 * tests/images.test.ts holds the real render to the fields read here.
 */

const script = join(import.meta.dir, "..", "scripts/local.sh");

const rendered = (id: string | undefined, ports: string[] = []) =>
  JSON.stringify({
    services: {
      api: { ports: ports.map((published) => ({ published, target: 3000 })) },
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
        STUB_API: "",
        STUB_OURS: "",
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

  test("parses as bash", () => {
    expect(Bun.spawnSync(["bash", "-n", script]).exitCode).toBe(0);
  });

  test.each(["local", "ap434local"])(
    "down deletes the workers of installation %p, the one compose renders",
    async (id) => {
      await writeFile(config, rendered(id));
      const result = await run(["down"]);
      expect(result.exitCode).toBe(0);
      expect(await calls("docker-calls")).toEqual([
        "compose --profile apps config --format json",
        "compose --profile apps down -v --remove-orphans",
        `ps -aq --filter label=agent-platform.installation=${id}`,
        `network ls -q --filter label=agent-platform.installation=${id}`,
        `volume ls -q --filter label=agent-platform.installation=${id}`,
      ]);
    },
  );

  test("down deletes nothing when compose cannot say which installation", async () => {
    for (const [text, reason] of [
      [undefined, "cannot render the stack"],
      [rendered(undefined), "names no EXECUTION_INSTALLATION_ID"],
    ] as const) {
      await rm(config, { force: true });
      if (text !== undefined) await writeFile(config, text);
      const result = await run(["down"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(reason);
    }
    expect(
      (await calls("docker-calls")).filter(
        (call) => !call.includes(" config "),
      ),
    ).toEqual([]);
  });

  test("up and status read /readyz where compose publishes the api", async () => {
    await writeFile(config, rendered("local"));
    const up = await run(["up"], { STUB_API: "127.0.0.1:43123" });
    expect(up).toMatchObject({ exitCode: 0, stdout: '{"status":"ready"}\n' });
    const status = await run(["status"], { STUB_API: "127.0.0.1:43123" });
    expect(status.stdout).toContain('readyz: {"status":"ready"}');
    expect(await calls("curl-calls")).toEqual([
      "http://127.0.0.1:43123/readyz",
      "http://127.0.0.1:43123/readyz",
    ]);

    const stopped = await run(["status"]);
    expect(stopped.stdout).toContain("readyz: \n");
    expect(await calls("curl-calls")).toHaveLength(2);
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
      const busy = await run(["up"], { STUB_API: `127.0.0.1:${port}` });
      expect(busy.exitCode).toBe(1);
      expect(busy.stderr).toContain(`port(s) ${port} already in use`);
      expect(await calls("docker-calls")).not.toContainEqual(
        "compose --profile apps up -d --build",
      );

      const ours = await run(["up"], {
        STUB_API: `127.0.0.1:${port}`,
        STUB_OURS: `127.0.0.1:${port}->3000/tcp`,
      });
      expect(ours.exitCode).toBe(0);
    } finally {
      listener.stop(true);
    }
  });
});
