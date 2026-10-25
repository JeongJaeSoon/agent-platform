import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * deploy/preview/preview.sh reap against stand-ins for kubectl, gh, docker
 * and git: which preview namespaces it hands to `down`, and which it keeps.
 */

const script = join(import.meta.dir, "..", "deploy/preview/preview.sh");

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");

describe("deploy/preview/preview.sh reap", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preview-reap-"));
    await mkdir(join(dir, "bin"));
    await writeFile(
      join(dir, "bin", "kubectl"),
      `#!/bin/sh
echo "$*" >> "${dir}/kubectl-calls"
case "$*" in
  "config view "*) echo "apiVersion: v1" ;;
  "get namespaces -l agent-platform.dev/preview=true -o json") cat "${dir}/namespaces.json" ;;
  "get namespace "*" -o jsonpath="*) echo true ;;
  "get namespace "*) ;;
  "delete namespace "*) exit "\${STUB_DELETE_EXIT:-0}" ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    // STUB_STATES is "<N>=<state> ...", where the state "fail" makes the
    // lookup fail.
    await writeFile(
      join(dir, "bin", "gh"),
      `#!/bin/sh
echo "$*" >> "${dir}/gh-calls"
for pair in $STUB_STATES; do
  [ "\${pair%%=*}" = "$3" ] || continue
  if [ "\${pair#*=}" = fail ]; then
    echo "error connecting to api.github.com" >&2
    exit 1
  fi
  echo "\${pair#*=}"
  exit 0
done
echo "no pull requests found" >&2
exit 1
`,
      { mode: 0o755 },
    );
    // No containers left, no image tags to remove.
    await writeFile(join(dir, "bin", "docker"), `#!/bin/sh\n[ "$1" = ps ]\n`, {
      mode: 0o755,
    });
    await writeFile(join(dir, "bin", "git"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  async function reap(
    namespaces: { name: string; upAt?: string }[],
    env: Record<string, string> = {},
  ) {
    await writeFile(
      join(dir, "namespaces.json"),
      JSON.stringify({
        items: namespaces.map(({ name, upAt }) => ({
          metadata: {
            name,
            annotations:
              upAt === undefined
                ? {}
                : { "agent-platform.dev/preview-up-at": upAt },
          },
        })),
      }),
    );
    const handle = Bun.spawn(["bash", script, "reap"], {
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        PREVIEW_HOME: join(dir, "home"),
        PREVIEW_TTL_HOURS: "",
        STUB_STATES: "",
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

  const deleted = async () =>
    (await calls("kubectl-calls"))
      .filter((call) => call.startsWith("delete namespace "))
      .map((call) => call.split(" ")[2]);

  test("downs closed and merged PRs' previews and keeps open ones", async () => {
    const result = await reap(
      [
        { name: "pr-1", upAt: hoursAgo(1) },
        { name: "pr-2", upAt: hoursAgo(1) },
        { name: "pr-3", upAt: hoursAgo(1) },
      ],
      { STUB_STATES: "1=MERGED 2=CLOSED 3=OPEN" },
    );
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual(["pr-1", "pr-2"]);
    expect(result.stdout).toContain("pr-1: deleting, PR MERGED");
    expect(result.stdout).toContain("pr-3: kept, PR OPEN, last up 1h ago");
    expect(result.stdout).toContain("reap deleted: pr-1 pr-2\n");
    expect(await calls("gh-calls")).toEqual([
      "pr view 1 --json state --jq .state",
      "pr view 2 --json state --jq .state",
      "pr view 3 --json state --jq .state",
    ]);
  });

  test("asks Kubernetes only for namespaces with the preview label", async () => {
    await reap([]);
    expect(await calls("kubectl-calls")).toContain(
      "get namespaces -l agent-platform.dev/preview=true -o json",
    );
  });

  test("keeps a labeled namespace not named pr-<N>", async () => {
    const result = await reap([
      { name: "pr-x964", upAt: hoursAgo(100) },
      { name: "pr-0", upAt: hoursAgo(100) },
      { name: "preview-ingress", upAt: hoursAgo(100) },
    ]);
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual([]);
    expect(await calls("gh-calls")).toEqual([]);
    expect(result.stdout).toContain("pr-x964: kept, not named pr-<N>");
    expect(result.stdout).toContain("reap deleted: none\n");
  });

  test("downs an open PR's preview past the TTL without asking GitHub", async () => {
    const result = await reap(
      [
        { name: "pr-4", upAt: hoursAgo(25) },
        { name: "pr-5", upAt: hoursAgo(23) },
      ],
      { STUB_STATES: "4=OPEN 5=OPEN" },
    );
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual(["pr-4"]);
    expect(result.stdout).toContain("pr-4: deleting, last up 25h ago");
    expect(await calls("gh-calls")).toEqual([
      "pr view 5 --json state --jq .state",
    ]);
  });

  test("PREVIEW_TTL_HOURS sets the TTL", async () => {
    const result = await reap([{ name: "pr-6", upAt: hoursAgo(3) }], {
      PREVIEW_TTL_HOURS: "2",
      STUB_STATES: "6=OPEN",
    });
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual(["pr-6"]);
  });

  test("refuses a PREVIEW_TTL_HOURS that is not a whole number", async () => {
    const result = await reap([], { PREVIEW_TTL_HOURS: "1d" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("PREVIEW_TTL_HOURS must be a whole number");
    expect(await calls("gh-calls")).toEqual([]);
  });

  test("keeps the preview and says why when GitHub cannot be read", async () => {
    const result = await reap(
      [
        { name: "pr-7", upAt: hoursAgo(1) },
        { name: "pr-8", upAt: hoursAgo(1) },
      ],
      { STUB_STATES: "7=fail" },
    );
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual([]);
    expect(result.stdout).toContain(
      "pr-7: kept, GitHub lookup failed: error connecting to api.github.com",
    );
    expect(result.stdout).toContain(
      "pr-8: kept, GitHub lookup failed: no pull requests found",
    );
  });

  test("keeps an open PR's preview with no readable up time", async () => {
    const result = await reap(
      [{ name: "pr-9" }, { name: "pr-10", upAt: "yesterday" }],
      { STUB_STATES: "9=OPEN 10=OPEN" },
    );
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual([]);
    expect(result.stdout).toContain(
      "pr-9: no readable agent-platform.dev/preview-up-at, TTL not applied",
    );
    expect(result.stdout).toContain("pr-10: kept, PR OPEN\n");
  });

  test("goes on past a failed down and exits non-zero", async () => {
    const result = await reap(
      [
        { name: "pr-11", upAt: hoursAgo(1) },
        { name: "pr-12", upAt: hoursAgo(1) },
      ],
      { STUB_STATES: "11=MERGED 12=MERGED", STUB_DELETE_EXIT: "1" },
    );
    expect(result.exitCode).toBe(1);
    expect(await deleted()).toEqual(["pr-11", "pr-12"]);
    expect(result.stdout).toContain(
      "reap deleted: none, failed: pr-11 pr-12\n",
    );
  });
});
