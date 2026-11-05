import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

type Namespace = {
  name: string;
  upAt?: string;
  labels?: Record<string, string>;
};

const OLD_LABEL = { "agent-platform.dev/preview": "true" };
const NEW_LABEL = { "werft.dev/preview": "true" };

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
  "config view --raw --minify --context "*)
    # Only the contexts in STUB_CONTEXTS exist.
    case " \${STUB_CONTEXTS:-orbstack} " in *" $6 "*) echo "apiVersion: v1" ;; *) exit 1 ;; esac ;;
  "get namespaces -o json") cat "${dir}/namespaces.json" ;;
  "get namespace "*" -o json")
    # STUB_CURRENT_UP_AT is an \`up\` that ran after reap read the list.
    # STUB_CURRENT_WERFT_UP_AT is the same \`up\`, recorded under the new key.
    if [ -n "\${STUB_CURRENT_UP_AT+set}" ]; then
      jq --arg ns "$3" --arg at "$STUB_CURRENT_UP_AT" '.items[] | select(.metadata.name == $ns)
        | .metadata.annotations["agent-platform.dev/preview-up-at"] = $at' "${dir}/namespaces.json"
    elif [ -n "\${STUB_CURRENT_WERFT_UP_AT+set}" ]; then
      jq --arg ns "$3" --arg at "$STUB_CURRENT_WERFT_UP_AT" '.items[] | select(.metadata.name == $ns)
        | .metadata.annotations["werft.dev/preview-up-at"] = $at' "${dir}/namespaces.json"
    else
      jq --arg ns "$3" '.items[] | select(.metadata.name == $ns)' "${dir}/namespaces.json"
    fi ;;
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
    await writeFile(
      join(dir, "bin", "docker"),
      `#!/bin/sh\necho "$*" >> "${dir}/docker-calls"\n[ "$1" = ps ]\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(dir, "bin", "git"),
      `#!/bin/sh\necho "$*" >> "${dir}/git-calls"\nexit 0\n`,
      { mode: 0o755 },
    );
    await writeFile(join(dir, "bin", "orb"), "#!/bin/sh\necho false\n", {
      mode: 0o755,
    });
    // Answers `helm status` for STUB_RELEASES; everything else fails, which
    // ends `up` at the Traefik install.
    await writeFile(
      join(dir, "bin", "helm"),
      `#!/bin/sh
echo "$*" >> "${dir}/helm-calls"
[ "$1" = status ] && case " $STUB_RELEASES " in *" $2 "*) exit 0 ;; esac
exit 1
`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  async function reap(
    namespaces: Namespace[],
    env: Record<string, string> = {},
  ) {
    await writeFile(
      join(dir, "namespaces.json"),
      JSON.stringify({
        items: namespaces.map(({ name, upAt, labels = OLD_LABEL }) => ({
          metadata: {
            name,
            labels,
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

  // Namespaces named pr-<N> in every case, so only the labels keep them.
  test("downs a PR-closed preview labeled with the old key, the new key, or both", async () => {
    const result = await reap(
      [
        { name: "pr-20", upAt: hoursAgo(1), labels: OLD_LABEL },
        { name: "pr-21", upAt: hoursAgo(1), labels: NEW_LABEL },
        {
          name: "pr-22",
          upAt: hoursAgo(1),
          labels: { ...OLD_LABEL, ...NEW_LABEL },
        },
      ],
      { STUB_STATES: "20=CLOSED 21=CLOSED 22=CLOSED" },
    );
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual(["pr-20", "pr-21", "pr-22"]);
  });

  test("never touches a namespace with no preview label or a conflicting one", async () => {
    const states = "23=CLOSED 24=CLOSED 25=CLOSED 26=CLOSED 27=CLOSED";
    const result = await reap(
      [
        { name: "pr-23", upAt: hoursAgo(100), labels: {} },
        {
          name: "pr-24",
          upAt: hoursAgo(100),
          labels: {
            "agent-platform.dev/preview": "true",
            "werft.dev/preview": "false",
          },
        },
        {
          name: "pr-25",
          upAt: hoursAgo(100),
          labels: {
            "agent-platform.dev/preview": "false",
            "werft.dev/preview": "true",
          },
        },
        {
          name: "pr-26",
          upAt: hoursAgo(100),
          labels: { "werft.dev/preview": "yes" },
        },
        {
          name: "pr-27",
          upAt: hoursAgo(100),
          labels: { "app.kubernetes.io/name": "x" },
        },
      ],
      { STUB_STATES: states },
    );
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual([]);
    expect(await calls("gh-calls")).toEqual([]);
    expect(result.stdout).toContain("reap deleted: none\n");
  });

  test("down refuses a conflicting namespace even when reap is not the caller", async () => {
    await writeFile(
      join(dir, "namespaces.json"),
      JSON.stringify({
        items: [
          {
            metadata: {
              name: "pr-28",
              labels: {
                "agent-platform.dev/preview": "true",
                "werft.dev/preview": "false",
              },
            },
          },
        ],
      }),
    );
    const handle = Bun.spawn(["bash", script, "down", "28"], {
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        PREVIEW_HOME: join(dir, "home"),
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      handle.exited,
      new Response(handle.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("pr-28 exists without a consistent");
    expect(await deleted()).toEqual([]);
  });

  test("the later of two up-at annotations counts", async () => {
    await writeFile(
      join(dir, "namespaces.json"),
      JSON.stringify({
        items: [
          {
            metadata: {
              name: "pr-29",
              labels: NEW_LABEL,
              annotations: {
                "agent-platform.dev/preview-up-at": hoursAgo(100),
                "werft.dev/preview-up-at": hoursAgo(1),
              },
            },
          },
        ],
      }),
    );
    const handle = Bun.spawn(["bash", script, "reap"], {
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        PREVIEW_HOME: join(dir, "home"),
        PREVIEW_TTL_HOURS: "",
        STUB_STATES: "29=OPEN",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const stdout = await new Response(handle.stdout).text();
    await handle.exited;
    expect(stdout).toContain("pr-29: kept, PR OPEN, last up 1h ago");
    expect(await deleted()).toEqual([]);
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
      "pr-9: no readable preview-up-at annotation, TTL not applied",
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

  test("keeps a preview brought up again after reap read it", async () => {
    const result = await reap([{ name: "pr-13", upAt: hoursAgo(30) }], {
      STUB_CURRENT_UP_AT: hoursAgo(0),
    });
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual([]);
    expect(result.stderr).toContain("pr-13: up again at ");
    expect(result.stdout).toContain("pr-13: kept, see above");
    expect(result.stdout).toContain("reap deleted: none\n");
  });

  test("keeps a preview brought up again under the new up-at key", async () => {
    const result = await reap(
      [{ name: "pr-30", upAt: hoursAgo(30), labels: NEW_LABEL }],
      { STUB_CURRENT_WERFT_UP_AT: hoursAgo(0) },
    );
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual([]);
    expect(result.stderr).toContain("pr-30: up again at ");
  });

  test("uses the orbstack context by default", async () => {
    await reap([]);
    expect((await calls("kubectl-calls"))[0]).toBe(
      "config view --raw --minify --context orbstack",
    );
  });

  test("PREVIEW_KUBE_CONTEXT picks the only context kubectl is pointed at", async () => {
    const result = await reap([], {
      PREVIEW_KUBE_CONTEXT: "kind-scratch",
      STUB_CONTEXTS: "kind-scratch",
    });
    expect(result.exitCode).toBe(0);
    const all = await calls("kubectl-calls");
    expect(all[0]).toBe("config view --raw --minify --context kind-scratch");
    expect(all.some((call) => call.includes("orbstack"))).toBe(false);
  });

  test("a context that does not exist stops before any namespace is read", async () => {
    const result = await reap([{ name: "pr-31", upAt: hoursAgo(100) }], {
      PREVIEW_KUBE_CONTEXT: "kind-missing",
      STUB_CONTEXTS: "orbstack",
      STUB_STATES: "31=CLOSED",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no kind-missing context");
    // No fallback to orbstack and no call past the context check.
    expect(await calls("kubectl-calls")).toEqual([
      "config view --raw --minify --context kind-missing",
    ]);
    expect(await deleted()).toEqual([]);
  });

  // Names that differ only in case, or that end like another run's temporary
  // file (kubeconfig-<x>.<pid>), must not share or shadow a file; macOS folds
  // case, so the files are told apart by a lowercase digest.
  test("each context gets its own kubeconfig file and leaves no temporary one", async () => {
    const contexts = ["kind-dev", "KIND-DEV", "kind-dev.1234"];
    await reap([]);
    for (const name of contexts) {
      await reap([], { PREVIEW_KUBE_CONTEXT: name, STUB_CONTEXTS: name });
    }
    const digest = (name: string) =>
      `kubeconfig-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
    const files = (await readdir(join(dir, "home"))).sort();
    expect(files).toEqual(["kubeconfig", ...contexts.map(digest)].sort());
    expect(new Set(files.map((file) => file.toLowerCase())).size).toBe(4);
  });

  test("down on another context leaves the local images, checkout and refs alone", async () => {
    await mkdir(join(dir, "home", "pr-32"), { recursive: true });
    const result = await reap([{ name: "pr-32", upAt: hoursAgo(100) }], {
      PREVIEW_KUBE_CONTEXT: "kind-scratch",
      STUB_CONTEXTS: "kind-scratch",
    });
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual(["pr-32"]);
    expect(result.stdout).toContain("pr-32: local images and checkout kept");
    expect(await calls("docker-calls")).toEqual([]);
    expect(await calls("git-calls")).toEqual([]);
    expect(await readdir(join(dir, "home", "pr-32"))).toEqual([]);
  });

  test("refuses a context name that is not plain", async () => {
    for (const name of ["a/b", "-x", "a b", "../x", "x:y"]) {
      const result = await reap([], { PREVIEW_KUBE_CONTEXT: name });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("must be a plain context name");
    }
    expect(await calls("kubectl-calls")).toEqual([]);
  });

  test("up refuses another context, which its installer would leave", async () => {
    const handle = Bun.spawn(["bash", script, "up", "18"], {
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        PREVIEW_HOME: join(dir, "home"),
        PREVIEW_KUBE_CONTEXT: "kind-scratch",
        STUB_CONTEXTS: "kind-scratch",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      handle.exited,
      new Response(handle.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("up installs only into the orbstack context");
    expect(await calls("kubectl-calls")).toEqual([
      "config view --raw --minify --context kind-scratch",
    ]);
  });

  test("keeps a preview another up or down holds", async () => {
    await mkdir(join(dir, "home"));
    await symlink(String(process.pid), join(dir, "home", "pr-14.lock"));
    const result = await reap([{ name: "pr-14", upAt: hoursAgo(1) }], {
      STUB_STATES: "14=MERGED",
    });
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual([]);
    expect(result.stderr).toContain(
      `pr-14: busy, pid ${process.pid} is running up or down on it`,
    );
    expect(await readlink(join(dir, "home", "pr-14.lock"))).toBe(
      String(process.pid),
    );
  });

  test("takes over a lock whose holder is gone and releases it", async () => {
    await mkdir(join(dir, "home"));
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    await symlink(String(gone.pid), join(dir, "home", "pr-15.lock"));
    const result = await reap([{ name: "pr-15", upAt: hoursAgo(1) }], {
      STUB_STATES: "15=CLOSED",
    });
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual(["pr-15"]);
    expect(
      await readlink(join(dir, "home", "pr-15.lock")).catch(() => null),
    ).toBe(null);
    expect(
      await readlink(join(dir, "home", "pr-15.lock.reclaim")).catch(() => null),
    ).toBe(null);
  });

  test("leaves a gone holder's lock to the process already reclaiming it", async () => {
    await mkdir(join(dir, "home"));
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    await symlink(String(gone.pid), join(dir, "home", "pr-16.lock"));
    await symlink(String(process.pid), join(dir, "home", "pr-16.lock.reclaim"));
    const result = await reap([{ name: "pr-16", upAt: hoursAgo(1) }], {
      STUB_STATES: "16=CLOSED",
    });
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual([]);
    expect(result.stderr).toContain("pr-16: busy, another process is taking");
    expect(await readlink(join(dir, "home", "pr-16.lock"))).toBe(
      String(gone.pid),
    );
  });

  test("down removes the image tags of both names", async () => {
    const result = await reap([{ name: "pr-17", upAt: hoursAgo(1) }], {
      STUB_STATES: "17=CLOSED",
    });
    expect(result.exitCode).toBe(0);
    const removed = (await calls("docker-calls")).filter((call) =>
      call.startsWith("image rm "),
    );
    expect(removed).toEqual(
      ["control-host", "egress-proxy", "worker"].flatMap((app) => [
        `image rm werft-${app}:pr-17`,
        `image rm agent-platform-${app}:pr-17`,
      ]),
    );
  });

  const up = async (releases: string) => {
    await writeFile(
      join(dir, "namespaces.json"),
      JSON.stringify({
        items: [{ metadata: { name: "pr-18", labels: NEW_LABEL } }],
      }),
    );
    const handle = Bun.spawn(["bash", script, "up", "18"], {
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        PREVIEW_HOME: join(dir, "home"),
        STUB_RELEASES: releases,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      handle.exited,
      new Response(handle.stderr).text(),
    ]);
    return { exitCode, stderr };
  };

  test("up refuses a namespace still holding the old release", async () => {
    const result = await up("agent-platform");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pr-18 holds a release from before");
    expect(await calls("helm-calls")).toEqual([
      "status agent-platform --namespace pr-18",
    ]);
  });

  test("up goes on in a namespace without the old release", async () => {
    const result = await up("");
    expect(result.stderr).not.toContain("holds a release from before");
    expect(await calls("helm-calls")).toContain(
      "status traefik --namespace preview-ingress -o json",
    );
  });
});
