"""Text half of relocate-control-host.sh (94S-117 L1). Runs after the git mv's.

Every edit asserts what it replaces: a miss raises with the file and the
snippet, so a main that drifted since this was written stops the run.
"""
import json
import os
import pathlib
import re
import subprocess

HOST = pathlib.Path("apps/control-host")
SRC = HOST / "src"
MANIFESTS = pathlib.Path(os.environ["MANIFESTS"])


def read(path):
    return pathlib.Path(path).read_text()


def write(path, text):
    pathlib.Path(path).write_text(text)


def replace(path, old, new, count=1):
    text = read(path)
    found = text.count(old)
    if found != count:
        raise SystemExit(f"{path}: expected {count}x {old!r}, found {found}")
    write(path, text.replace(old, new))


def sub(path, pattern, new, count=1, flags=0):
    text, found = re.subn(pattern, new, read(path), flags=flags)
    if found != count:
        raise SystemExit(f"{path}: expected {count}x /{pattern}/, found {found}")
    write(path, text)


# --- one package for the three apps ------------------------------------------
manifests = {app: json.loads(read(MANIFESTS / f"{app}.json"))
             for app in ("api", "scheduler", "reconciler")}
for app, manifest in manifests.items():
    assert manifest["name"] == f"@agent-platform/{app}", manifest["name"]
dependencies, dev_dependencies = {}, {}
for manifest in manifests.values():
    for field, merged in (("dependencies", dependencies),
                          ("devDependencies", dev_dependencies)):
        for name, version in manifest.get(field, {}).items():
            if merged.get(name, version) != version:
                raise SystemExit(f"{name}: {merged[name]} vs {version}")
            merged[name] = version
assert manifests["api"]["scripts"]["keys"] == "bun run src/keys.ts"
assert manifests["scheduler"]["scripts"]["migrate-workspace"] == "bun run src/migrate-workspace.ts"
write(HOST / "package.json", json.dumps({
    "name": "@agent-platform/control-host",
    "version": "0.0.0",
    "private": True,
    "type": "module",
    "scripts": {
        "typecheck": "tsc -p tsconfig.json",
        "dev": "bun --watch src/main.ts api",
        "start": "bun run src/main.ts api",
        "scheduler": "bun run src/main.ts scheduler",
        "reconciler": "bun run src/main.ts reconciler",
        "keys": "bun run src/api/keys.ts",
        "migrate-workspace": "bun run src/scheduler/migrate-workspace.ts",
    },
    "dependencies": dict(sorted(dependencies.items())),
    "devDependencies": dict(sorted(dev_dependencies.items())),
}, indent=2) + "\n")

# --- the executable: a role, named, never defaulted ---------------------------
write(SRC / "main.ts", '''// The control host's one executable (94S-117): `bun run src/main.ts <role>`.
// The role is named, never defaulted, so a container runs what its command
// says. Each role module is imported only when chosen: a process reads and
// validates only its own role's settings, and only the scheduler ever loads
// the Docker backend.
const ROLES = ["api", "scheduler", "reconciler"] as const;
type Role = (typeof ROLES)[number];

function isRole(value: string | undefined): value is Role {
  return (ROLES as readonly (string | undefined)[]).includes(value);
}

const role = process.argv[2];
if (!isRole(role)) {
  console.error(
    `usage: bun run src/main.ts <${ROLES.join("|")}> (got ${role ?? "nothing"})`,
  );
  process.exit(2);
}

switch (role) {
  case "api":
    // Serves until a signal stops it (api/shutdown.ts).
    await import("./api/server.ts");
    break;
  case "scheduler": {
    const { exitCodeFor, main } = await import("./scheduler/main.ts");
    process.exitCode = exitCodeFor(await main());
    break;
  }
  case "reconciler": {
    const { main } = await import("./reconciler/main.ts");
    await main();
    break;
  }
}
''')
write(SRC / "main.test.ts", '''import { describe, expect, test } from "bun:test";

// Each case spawns a bun process per role; a loaded runner needs more than
// the default 5s for three of them.
const TIMEOUT_MS = 30_000;

async function run(...args: string[]) {
  const child = Bun.spawn(
    [process.execPath, "run", `${import.meta.dir}/main.ts`, ...args],
    // An empty environment: a role that got as far as reading its settings
    // would fail on them, not on the role.
    { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr };
}

describe("control host executable", () => {
  test("refuses to guess a role", async () => {
    for (const args of [[], ["worker"], ["API"]]) {
      const { exitCode, stderr } = await run(...args);
      expect(exitCode, args.join(" ")).toBe(2);
      expect(stderr).toContain("usage: bun run src/main.ts <api|scheduler|reconciler>");
    }
  }, TIMEOUT_MS);

  test("each role validates its own settings and nothing else", async () => {
    // Without DATABASE_URL every role refuses, each in its own words: the
    // API before any listener, the jobs before any pass.
    const api = await run("api");
    expect(api.exitCode).not.toBe(0);
    expect(api.stderr).toContain("DATABASE_URL is required");
    const reconciler = await run("reconciler");
    expect(reconciler.exitCode).not.toBe(0);
    expect(reconciler.stderr).toContain("DATABASE_URL or QUEUE_DATABASE_URL is required");
    const scheduler = await run("scheduler");
    expect(scheduler.exitCode).not.toBe(0);
    expect(scheduler.stderr).toContain("DATABASE_URL or QUEUE_DATABASE_URL is required");
  }, TIMEOUT_MS);
});
''')

# The executable is the only entry; running a role module directly would
# start a second way in.
sub(SRC / "scheduler/main.ts",
    r"\nif \(import\.meta\.main\) \{\n  process\.exitCode = exitCodeFor\(await main\(\)\);\n\}\n", "\n")
sub(SRC / "reconciler/main.ts", r"\nif \(import\.meta\.main\) \{\n  await main\(\);\n\}\n", "\n")
replace(SRC / "reconciler/main.integration.test.ts",
        '[process.execPath, "run", `${import.meta.dir}/main.ts`]',
        '[process.execPath, "run", `${import.meta.dir}/../main.ts`, "reconciler"]')

# One level deeper than before: paths that climb to the repository root.
climbed = 0
for path in (p for d in ("api", "scheduler", "reconciler") for p in (SRC / d).rglob("*.ts")):
    text = read(path)
    new_lines = []
    for line in text.split("\n"):
        if "import.meta.dir" in line:
            line, n = re.subn(r"((?:\.\./){2,})(packages/|config\b)", r"\1../\2", line)
            climbed += n
        new_lines.append(line)
    new = "\n".join(new_lines)
    if new != text:
        write(path, new)
assert climbed >= 6, climbed

# Bun serves a default export only from the entry module, and server.ts is
# now imported by main.ts: before 94S-306 it still ends in one.
server = SRC / "api/server.ts"
if "\nexport default {\n" in read(server):
    sub(server, r"\nexport default \{\n(.*)\n\};\n$", r"\nBun.serve({\n\1\n});\n", flags=re.S)

server_it = SRC / "api/server.integration.ts"
sub(server_it, r"cwd: `\$\{import\.meta\.dir\}/\.\.`", "cwd: `${import.meta.dir}/../..`", count=4)
sub(server_it, r'\["bun", "run", "src/server\.ts"\]', '["bun", "run", "src/main.ts", "api"]', count=3)
replace(server_it, '"src/keys.ts"', '"src/api/keys.ts"')

# --- repo-wide paths ------------------------------------------------------------
# ci.yml domain jobs route files by path prefix and refuse a file two jobs
# claim: the API domain gets api/ and the executable, docker keeps scheduler/.
replace(".github/workflows/ci.yml", "              - apps/api/\n              - apps/reconciler/\n",
        "              - apps/control-host/src/api/\n              - apps/control-host/src/main\n"
        "              - apps/control-host/src/reconciler/\n")

ENTRIES = [("apps/api/src/server.ts", "api"),
           ("apps/scheduler/src/main.ts", "scheduler"),
           ("apps/reconciler/src/main.ts", "reconciler")]
tracked = subprocess.run(
    ["git", "ls-files", "--", ".", ":!bun.lock", ":!docs/references", ":!docs/DESIGN.md",
     ":!spikes", ":!scripts/dev/relocate-control-host"],
    check=True, capture_output=True, text=True,
).stdout.split()
for name in tracked:
    path = pathlib.Path(name)
    if not path.is_file():
        continue
    try:
        text = path.read_text()
    except UnicodeDecodeError:
        continue
    new = text
    for entry, role in ENTRIES:
        # An entry file run as a command becomes the executable plus a role,
        # in an argv array and on a command line alike.
        new = new.replace(f'"{entry}"', f'"apps/control-host/src/main.ts", "{role}"')
        new = re.sub(rf"(bun run \S*?){re.escape(entry)}", rf"\1apps/control-host/src/main.ts {role}", new)
    for old, cwd_new in (("--cwd apps/api start", "--cwd apps/control-host start"),
                         ("--cwd apps/api keys", "--cwd apps/control-host keys"),
                         ("--cwd apps/scheduler start", "--cwd apps/control-host scheduler"),
                         ("--cwd apps/scheduler migrate-workspace", "--cwd apps/control-host migrate-workspace"),
                         ("--cwd apps/reconciler start", "--cwd apps/control-host reconciler")):
        new = new.replace(old, cwd_new)
    for old, dir_new in (("@agent-platform/api/src/", "@agent-platform/control-host/src/api/"),
                         ("@agent-platform/scheduler/src/", "@agent-platform/control-host/src/scheduler/"),
                         ("@agent-platform/reconciler/src/", "@agent-platform/control-host/src/reconciler/"),
                         ("apps/api/src/", "apps/control-host/src/api/"),
                         ("apps/scheduler/src/", "apps/control-host/src/scheduler/"),
                         ("apps/reconciler/src/", "apps/control-host/src/reconciler/"),
                         ("apps/api/Dockerfile", "apps/control-host/Dockerfile"),
                         ("apps/scheduler/Dockerfile", "apps/control-host/Dockerfile"),
                         ("apps/scheduler/", "apps/control-host/src/scheduler/"),
                         ("apps/reconciler/", "apps/control-host/src/reconciler/"),
                         ("apps/api/", "apps/control-host/")):
        new = new.replace(old, dir_new)
    if new != text:
        write(path, new)

# --- one image --------------------------------------------------------------------
dockerfile = HOST / "Dockerfile"
replace(dockerfile, "    --filter ./apps/api --filter ./apps/reconciler \\\n", "    --filter ./apps/control-host \\\n")
replace(dockerfile, "# --filter limits the install to the two apps this image runs",
        "# --filter limits the install to the one app this image runs")
sub(dockerfile, r"# API image: .*?with 94S-117 by changing the paths below\.\n",
    "# Control-host image (94S-117): one executable, three roles —\n"
    "# `apps/control-host/src/main.ts api|scheduler|reconciler` — none of them\n"
    "# with the Agent SDK or the Claude Code executable (docs/DESIGN.md §9.2–9.3).\n"
    "# Only the scheduler role is given the Docker socket, and it runs as root\n"
    "# for that (compose `user:`); the image default stays uid 1000. Built from\n"
    "# the repository root (`docker build -f apps/control-host/Dockerfile .`).\n",
    flags=re.S)

compose = "infra/docker-compose.yml"
replace(compose, "image: ${API_IMAGE:-agent-platform-api:dev}", "image: ${API_IMAGE:-agent-platform-control-host:dev}")
# Only `api` builds the shared image: two services building one tag race on
# export ("image already exists"). The scheduler already waits for a healthy
# api, so `up --build` has the image before the scheduler is created.
replace(compose, "  scheduler:\n    build:\n      context: ..\n      dockerfile: apps/control-host/Dockerfile\n"
        "    image: ${SCHEDULER_IMAGE:-agent-platform-scheduler:dev}\n    profiles: [\"apps\"]\n",
        "  scheduler:\n"
        "    image: ${API_IMAGE:-agent-platform-control-host:dev}\n    profiles: [\"apps\"]\n"
        "    # The control-host image's scheduler role. `api` builds that image, and\n"
        "    # depends_on a healthy api orders the build before this container.\n"
        "    # Root on purpose: the process owns the Docker socket, and whoever\n"
        "    # holds that socket is root on the daemon host anyway. The socket's\n"
        "    # group id differs per daemon (Desktop, colima, Linux), so a fixed\n"
        "    # non-root uid would only work on some of them while buying no\n"
        "    # isolation on any.\n"
        "    user: \"0:0\"\n")


def without_scheduler(match):
    items = [item.strip() for item in match.group(2).split(",")]
    assert items[0] == "api" and "scheduler" in items, items
    items = ["control-host"] + [i for i in items[1:] if i != "scheduler"]
    return f"{match.group(1)}{', '.join(items)}]"


images_yml = ".github/workflows/images.yml"
sub(images_yml, r"(app: \[)([^\]]*)\]", without_scheduler, count=2)
sub(images_yml, r'(test "\$\(ls staged/\*\.json \| wc -l\)" -eq )(\d+)',
    lambda m: f"{m.group(1)}{int(m.group(2)) - 1}")
smoke = ".github/scripts/image-smoke.sh"
sub(smoke, r"`image-smoke\.sh <api\|([^>]*)>", lambda m: "`image-smoke.sh <control-host|" +
    "|".join(a for a in m.group(1).split("|") if a != "scheduler") + ">")
replace(smoke, "\n  api)\n", "\n  control-host)\n")
replace(smoke, "    api_init_smoke \"$image\"\n    ;;\n",
        "    api_init_smoke \"$image\"\n"
        "    # One executable for every role; it refuses to guess one.\n"
        "    if docker run --rm \"$image\" bun run apps/control-host/src/main.ts >/dev/null 2>&1; then\n"
        "      echo \"expected the executable to refuse a missing role\" >&2; exit 1\n"
        "    fi\n    ;;\n")
sub(smoke, r"  scheduler\)\n.*?\n    ;;\n", "", flags=re.S)

images_test = "tests/images.test.ts"
sub(images_test, r'(const apps = \[)([^\]]*)\]',
    lambda m: m.group(1) + ", ".join(
        ['"control-host"'] + [i.strip() for i in m.group(2).split(",")[1:] if i.strip() != '"scheduler"']) + "]")
assert '"api"' not in read(images_test).split("const apps = ")[1].split("\n")[0]
# Lists other cards added (94S-323's installingApps): api first, scheduler gone.
for name in ("installingApps",):
    if f"const {name} = [" in read(images_test):
        sub(images_test, rf'(const {name} = \[)([^\]]*)\]',
            lambda m: m.group(1) + ", ".join(
                ['"control-host"'] + [i.strip() for i in m.group(2).split(",")[1:] if i.strip() != '"scheduler"']) + "]")
sub(images_test, r'for \(const app of \["api", "scheduler"(, [^\]]*)?\] as const\)',
    lambda m: 'for (const app of ["control-host"' + (m.group(1) or "") + '] as const)')
sub(images_test, r"basePins\.api\.source", 'basePins["control-host"].source', count=2)
sub(images_test, r'("app: \[)([^\]]*)\]"', lambda m: without_scheduler(m) + '"')
replace(images_test,
        '  test("the scheduler loop surfaces persistent failure", () => {\n',
        '  test("one service builds the shared control-host image", () => {\n'
        '    // Two services building one tag race on export: "already exists".\n'
        '    expect(compose.match(/dockerfile: apps\\/control-host\\/Dockerfile/g)).toHaveLength(1);\n'
        '    const schedulerBlock = compose.slice(compose.indexOf("\\n  scheduler:"));\n'
        '    expect(schedulerBlock).toContain(\n'
        '      "image: $" + "{API_IMAGE:-agent-platform-control-host:dev}",\n'
        '    );\n'
        '  });\n\n'
        '  test("the scheduler loop surfaces persistent failure", () => {\n')

# --- the D2 gate (94S-247) runs the product images: one control-host image now ----
run_sh = "scripts/d2-gate/run.sh"
replace(run_sh, 'export API_IMAGE="agent-platform-api:${project}"\nexport SCHEDULER_IMAGE="agent-platform-scheduler:${project}"\n',
        'export API_IMAGE="agent-platform-control-host:${project}"\n')
replace(run_sh, '"$API_IMAGE" "$SCHEDULER_IMAGE" "$WORKER_IMAGE"', '"$API_IMAGE" "$WORKER_IMAGE"')
replace(run_sh, "dc build api scheduler worker ", "dc build api worker ")
replace(run_sh, "# Builds the api, scheduler and worker images from this checkout",
        "# Builds the control-host and worker images from this checkout")
replace(run_sh, "installation id, and the three images are removed on exit.",
        "installation id, and the two images are removed on exit.")
sub("tests/d2-gate/harness.ts", r"\n  schedulerImage: string;", "")
sub("tests/d2-gate/harness.ts", r'\n    schedulerImage: need\("SCHEDULER_IMAGE"\),', "")
sub("tests/d2-gate.e2e.test.ts", r"\n    scheduler_image: `[^\n]*`,", "")

# 94S-320's pass supervisor, when it is there: its child is the reconciler
# role of the one executable, not a module run on its own.
loop = SRC / "reconciler/loop.ts"
if loop.exists():
    replace(loop, 'join(import.meta.dir, "main.ts")]', 'join(import.meta.dir, "..", "main.ts"), "reconciler"]')

# --- the layout is a checked promise --------------------------------------------------
replace(
    "tests/architecture.test.ts",
    '  test("the worker keeps its process layout: entry, composition, host, transport, heartbeat", async () => {',
    '''  test("the control host is one app with one executable and three roles", async () => {
    const host = join(root, "apps", "control-host", "src");
    const missing: string[] = [];
    for (const name of [
      "main.ts",
      join("api", "server.ts"),
      join("scheduler", "main.ts"),
      join("reconciler", "main.ts"),
    ]) {
      if (!(await Bun.file(join(host, name)).exists())) missing.push(name);
    }
    expect(missing).toEqual([]);
    for (const gone of ["api", "scheduler", "reconciler"])
      expect(existsSync(join(root, "apps", gone))).toBe(false);
  });

  test("only the control host's scheduler role reaches the Docker backend", async () => {
    const host = join(root, "apps", "control-host");
    const importing = (
      await filesImporting(
        await sourceFiles(join(host, "src")),
        "@agent-platform/execution-local-docker",
      )
    ).map((file) => relative(join(host, "src"), file));
    expect(importing.length).toBeGreaterThan(0);
    expect(importing.filter((file) => !file.startsWith(`scheduler${sep}`))).toEqual([]);
  });

  test("the worker keeps its process layout: entry, composition, host, transport, heartbeat", async () => {''',
)

arch = read("tests/architecture.test.ts")
if 'import { existsSync } from "node:fs";' not in arch:
    replace("tests/architecture.test.ts", 'import { describe, expect, test } from "bun:test";\n',
            'import { describe, expect, test } from "bun:test";\nimport { existsSync } from "node:fs";\n')
path_import = re.search(r'import \{ ([^}]*) \} from "node:path";', read("tests/architecture.test.ts"))
assert path_import, "node:path import drifted"
if "sep" not in [n.strip() for n in path_import.group(1).split(",")]:
    names = sorted([n.strip() for n in path_import.group(1).split(",")] + ["sep"])
    sub("tests/architecture.test.ts", r'import \{ [^}]* \} from "node:path";',
        'import { ' + ", ".join(names) + ' } from "node:path";')

# --- prose ----------------------------------------------------------------------------
readme = "README.md"
sub(readme, r"^\| `apps/api` \|.*\n",
    "| `apps/control-host` | 제어 영역 배포 단위(94S-117). 실행물 하나(`src/main.ts <api\\|scheduler\\|reconciler>`)가 role을 인자로 받고 기본값은 없다. `src/api`는 Hono `/v1`·`/internal`(Worker Gateway)·API 키·키 발급 CLI, `src/scheduler`는 launch intent를 커밋하고 LocalDockerBackend로 worker 컨테이너를 보장하는 pass, `src/reconciler`는 만료된 lease를 회수하는 pass다. Docker backend는 scheduler role만 로드한다 |\n",
    flags=re.M)
sub(readme, r"^\| `apps/reconciler` \|.*\n", "", flags=re.M)
sub(readme, r"^\| `apps/scheduler` \|.*\n", "", flags=re.M)
sub(readme, r"^\| `agent-platform-api` \|.*\n",
    "| `agent-platform-control-host` | `apps/control-host` 실행물 하나로 api·scheduler·reconciler role을 모두 돌린다. `--filter`로 그 앱의 closure만 설치하며 Agent SDK·Claude Code executable을 담지 않는다(빌드가 `node_modules/@anthropic-ai` 부재를 확인). 기본 uid 1000, scheduler role만 compose `user: \"0:0\"`로 root가 되어 Docker socket을 쥔다 | `bun run apps/control-host/src/main.ts <role>` (CMD 기본은 `api`) |\n",
    flags=re.M)
sub(readme, r"^\| `agent-platform-scheduler` \| `apps/[^`]*` one-shot\. ", "| (scheduler role) | ", flags=re.M)
