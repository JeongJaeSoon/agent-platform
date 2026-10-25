import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The verify-agent-platform skill's up.sh and its address pool check against
 * a stand-in for docker: what the daemon reports as its pools and networks.
 */

const scripts = join(
  import.meta.dir,
  "..",
  ".claude/skills/verify-agent-platform/scripts",
);

// OrbStack's shape: every pool a single /24.
const orbstackPools = (n: number) => [
  ...Array.from({ length: n }, (_, i) => ({
    Base: `192.168.${100 + i}.0/24`,
    Size: 24,
  })),
  { Base: "fd07:b51a:cc66:d000::/56", Size: 64 },
];

const network = (
  name: string,
  subnets: string[],
  labels: Record<string, string> = {},
) => ({
  Name: name,
  Labels: labels,
  IPAM: { Config: subnets.map((Subnet) => ({ Subnet })) },
});

describe("verify-agent-platform up.sh and address-pool.sh", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "verify-stack-"));
    await mkdir(join(dir, "bin"));
    await writeFile(
      join(dir, "bin", "docker"),
      `#!/bin/sh
echo "$*" >> "${dir}/docker-calls"
case "$*" in
  "info --format {{json .DefaultAddressPools}}") echo "$STUB_POOLS" ;;
  "network ls -q") [ -z "$STUB_IDS" ] || echo "$STUB_IDS" ;;
  "network inspect "*) echo "$STUB_NETWORKS" ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  async function run(
    script: string,
    args: string[],
    stub: { pools: unknown; networks: ReturnType<typeof network>[] },
    env: Record<string, string> = {},
  ) {
    const handle = Bun.spawn(["bash", join(scripts, script), ...args], {
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        VERIFY_AP_ROOT: join(dir, "runs"),
        VERIFY_SLOT_LIMIT: "",
        STUB_POOLS: JSON.stringify(stub.pools),
        STUB_IDS: stub.networks.map((_, i) => `id${i}`).join("\n"),
        STUB_NETWORKS: JSON.stringify(stub.networks),
        ...env,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      handle.exited,
      new Response(handle.stderr).text(),
    ]);
    return { exitCode, stderr };
  }

  const dockerCalls = async () =>
    (
      await Bun.file(join(dir, "docker-calls"))
        .text()
        .catch(() => "")
    )
      .split("\n")
      .filter(Boolean);

  const runs = async () => readdir(join(dir, "runs")).catch(() => []);

  const busy = [
    network("bridge", ["192.168.100.0/24"]),
    network("verify-ap-a_default", ["192.168.101.0/24"], {
      "com.docker.compose.project": "verify-ap-a",
    }),
    ...[102, 103, 104].map((octet) =>
      network(
        `ap-net-verify-ap-a-exec-${octet}-g1`,
        [`192.168.${octet}.0/24`],
        {
          "agent-platform.installation": "verify-ap-a",
        },
      ),
    ),
    network("kind", ["fc00:f853:ccd:e793::/64", "192.168.105.0/24"]),
    network("outside", ["10.9.0.0/24"]),
    network("host", []),
  ];

  test("both scripts parse as bash", () => {
    for (const script of ["up.sh", "address-pool.sh"]) {
      expect(
        Bun.spawnSync(["bash", "-n", join(scripts, script)]).exitCode,
      ).toBe(0);
    }
  });

  test("a pool with room passes and says how much is left", async () => {
    const { exitCode, stderr } = await run("address-pool.sh", ["4"], {
      pools: orbstackPools(10),
      networks: busy,
    });

    expect(exitCode).toBe(0);
    expect(stderr).toContain("4 free of 10, 4 needed");
  });

  test("a short pool fails with the counts and the networks by project or installation, reading only", async () => {
    const { exitCode, stderr } = await run("address-pool.sh", ["5"], {
      pools: orbstackPools(10),
      networks: busy,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "Docker's address pools are short: 4 free of 10, 5 needed",
    );
    expect(stderr).toContain("  4\tverify-ap-a\n");
    expect(stderr).toContain("  1\tbridge\n");
    expect(stderr).toContain("  1\tkind\n");
    expect(stderr).not.toContain("outside");
    expect(await dockerCalls()).toEqual([
      "info --format {{json .DefaultAddressPools}}",
      "network ls -q",
      `network inspect ${busy.map((_, i) => `id${i}`).join(" ")}`,
    ]);
  });

  test("a pool wider than its size holds 2^(size - prefix) networks", async () => {
    const pools = [
      { Base: "172.17.0.0/16", Size: 16 },
      { Base: "192.168.0.0/16", Size: 20 },
    ];
    const networks = [
      network("bridge", ["172.17.0.0/16"]),
      network("a_default", ["192.168.0.0/20"]),
      // A subnet given by hand, wider than the pool's size: two entries.
      network("wide", ["192.168.32.0/19"]),
    ];

    expect(
      (await run("address-pool.sh", ["13"], { pools, networks })).stderr,
    ).toContain("13 free of 17, 13 needed");
    expect(
      (await run("address-pool.sh", ["14"], { pools, networks })).exitCode,
    ).toBe(1);
  });

  test("no IPv4 pool reported is not checked", async () => {
    const { exitCode, stderr } = await run("address-pool.sh", ["4"], {
      pools: null,
      networks: busy,
    });

    expect(exitCode).toBe(0);
    expect(stderr).toContain("not checked");
  });

  test("up.sh stops on a short pool before the run directory or any compose call", async () => {
    const { exitCode, stderr } = await run(
      "up.sh",
      [],
      { pools: orbstackPools(6), networks: busy },
      { VERIFY_SLOT_LIMIT: "2" },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("0 free of 6, 3 needed");
    expect(stderr).toContain("nothing was started");
    expect(await runs()).toEqual([]);
    expect(
      (await dockerCalls()).some((call) => call.startsWith("compose")),
    ).toBe(false);
  });

  test("up.sh refuses a slot limit that is not a positive integer without asking docker", async () => {
    for (const value of ["0", "-1", "two", "08"]) {
      const { exitCode, stderr } = await run(
        "up.sh",
        [],
        { pools: orbstackPools(30), networks: [] },
        { VERIFY_SLOT_LIMIT: value },
      );

      expect(exitCode).toBe(1);
      expect(stderr).toContain("VERIFY_SLOT_LIMIT must be a positive integer");
    }
    expect(await dockerCalls()).toEqual([]);
  });

  test("up.sh hands the stack 3 worker slots, or VERIFY_SLOT_LIMIT", async () => {
    for (const [value, expected] of [
      ["", "3"],
      ["5", "5"],
    ] as const) {
      await rm(join(dir, "runs"), { force: true, recursive: true });
      // The stand-in refuses `docker version`, so local.sh stops right after
      // up.sh has written the run's state.
      const { exitCode } = await run(
        "up.sh",
        [],
        { pools: orbstackPools(30), networks: [] },
        { VERIFY_SLOT_LIMIT: value },
      );
      expect(exitCode).not.toBe(0);

      const [runId] = await runs();
      const state = join(dir, "runs", String(runId), "state.env");
      const read = Bun.spawnSync([
        "bash",
        "-c",
        `. "$1" && printf %s "$EXECUTION_SLOT_LIMIT"`,
        "_",
        state,
      ]);
      expect(read.stdout.toString()).toBe(expected);
    }
  });
});
