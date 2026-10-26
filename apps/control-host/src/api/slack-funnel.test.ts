import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../../../scripts/slack-funnel.sh");

let bin: string;
let log: string;

beforeEach(async () => {
  bin = await mkdtemp(join(tmpdir(), "slack-funnel-"));
  log = join(bin, "calls");
  await writeFile(
    join(bin, "tailscale"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n` +
      `[ "$1 $2" = "status --json" ] && printf '{\\n  "Self": {\\n    "DNSName": "box.tail1234.ts.net.",\\n' || true\n`,
  );
  await chmod(join(bin, "tailscale"), 0o755);
  // Answers each DoH query with $FAKE_DOH_<resolver host>, never the network.
  await writeFile(
    join(bin, "curl"),
    `#!/bin/sh\nfor a; do url=$a; done\nprintf 'curl %s\\n' "$url" >> "${log}"\n` +
      `case "$url" in *dns.google*) printf '%s' "$FAKE_DOH_GOOGLE";; *) printf '%s' "$FAKE_DOH_CLOUDFLARE";; esac\n`,
  );
  await chmod(join(bin, "curl"), 0o755);
});

const RESOLVED =
  '{"Status":0,"Answer":[{"name":"box.tail1234.ts.net.","type":1}]}';
const NXDOMAIN = '{"Status":3,"Question":[{"name":"box.tail1234.ts.net."}]}';

afterEach(async () => {
  await rm(bin, { recursive: true, force: true });
});

async function run(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(["bash", script, ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  const calls = await readFile(log, "utf8").then(
    (text) => text.trim().split("\n"),
    () => [],
  );
  return { code, stderr, calls };
}

describe("scripts/slack-funnel.sh", () => {
  test("on maps only the events path to the local API, shows the status, then checks public DNS", async () => {
    expect(
      await run(["on"], {
        PORT: "4310",
        FAKE_DOH_GOOGLE: RESOLVED,
        FAKE_DOH_CLOUDFLARE: RESOLVED,
      }),
    ).toEqual({
      code: 0,
      stderr: "",
      calls: [
        "funnel --bg --https=443 --set-path=/v1/slack/events http://127.0.0.1:4310/v1/slack/events",
        "funnel status",
        "status --json --peers=false",
        "curl https://dns.google/resolve?name=box.tail1234.ts.net&type=A",
        "curl https://cloudflare-dns.com/dns-query?name=box.tail1234.ts.net&type=A",
      ],
    });
  });

  test.each([
    [NXDOMAIN, RESOLVED, "dns.google/resolve: NXDOMAIN"],
    [RESOLVED, "", "cloudflare-dns.com/dns-query: no answer"],
    ['{"Status":0}', RESOLVED, "dns.google/resolve: no address"],
  ])(
    "on warns, still exit 0, when public DNS does not resolve the name (%s / %s)",
    async (google, cloudflare, reason) => {
      const result = await run(["on"], {
        PORT: "4310",
        FAKE_DOH_GOOGLE: google,
        FAKE_DOH_CLOUDFLARE: cloudflare,
      });
      expect(result.code).toBe(0);
      expect(result.stderr).toContain(
        "box.tail1234.ts.net does not resolve in public DNS yet",
      );
      expect(result.stderr).toContain(reason);
      expect(result.stderr).toContain("wait before creating the Slack app");
    },
  );

  test("off repeats on's --https and --set-path, then shows the status", async () => {
    const env = { SLACK_FUNNEL_HTTPS_PORT: "8443" };
    expect((await run(["off"], env)).calls).toEqual([
      "funnel --https=8443 --set-path=/v1/slack/events off",
      "funnel status",
    ]);
  });

  test("status only reads", async () => {
    expect((await run(["status"])).calls).toEqual(["funnel status"]);
  });

  test.each([
    [["on"], {}],
    [["on"], { PORT: "0" }],
    [["on"], { PORT: "70000" }],
    [["on"], { PORT: "4310; id" }],
    [["on"], { PORT: "4310", SLACK_FUNNEL_HTTPS_PORT: "444" }],
    [["serve"], {}],
    [[], {}],
    [["on", "extra"], { PORT: "4310" }],
  ])("refuses %j %j with exit 2 and no tailscale call", async (args, env) => {
    const result = await run(args, env);
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
  });

  test("without tailscale on PATH it stops with exit 1", async () => {
    await rm(join(bin, "tailscale"));
    const result = await run(["status"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("tailscale is not on PATH");
  });
});
