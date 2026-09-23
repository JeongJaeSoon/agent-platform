#!/usr/bin/env bash
# Smoke for one app image: `image-smoke.sh <api|worker|scheduler> <image ref>`.
# Shared by images.yml's build (loaded image) and publish (the digest that
# was actually pushed) jobs so both check the same things.
set -euo pipefail

app="$1"
image="$2"

# Only containers this run started carry this label, so cleanup never
# touches anything else on the daemon.
smoke_label="agent-platform.image-smoke=$$-${RANDOM}"
cleanup() {
  ids="$(docker ps -aq --filter "label=${smoke_label}")"
  [ -z "$ids" ] || docker rm -f $ids >/dev/null
}
trap cleanup EXIT

# Times git out five times the way the checkpoint verifier does (own process
# group, SIGKILL to the group) and prints how many zombies the container
# holds afterwards. The alias makes git fork a shell that forks again, so
# every kill orphans processes that only PID 1 can reap.
zombie_probe='
const { defaultGitRunner } = await import("/app/packages/storage/src/git-runner.ts");
const { readdirSync, readFileSync } = await import("node:fs");
for (let i = 0; i < 5; i++) {
  const r = await defaultGitRunner(
    ["-c", "alias.hang=!sleep 30 & sleep 30", "hang"],
    { env: {}, timeoutMs: 500 },
  );
  if (!r.timedOut) throw new Error("git was expected to time out");
}
await Bun.sleep(1000);
let zombies = 0;
for (const pid of readdirSync("/proc").filter((d) => /^[0-9]+$/.test(d))) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) zombies++;
  } catch {}
}
console.log(zombies);
'

# 94S-272: the API image must reap what the verifier orphans wherever it
# runs, not only under compose's `init: true`.
api_init_smoke() {
  local image="$1" cid pid1 server_ppid zombies control
  # The default command, with a database that is never reached: the server
  # stays up (readiness answers 503) and nothing here needs it. The
  # installation limits have no code default (94S-131).
  cid="$(docker run -d --label "$smoke_label" \
    -e DATABASE_URL=postgres://smoke:smoke@127.0.0.1:1/smoke \
    -e CHECKPOINT_OBJECT_STORE=disabled \
    -e EXECUTION_SLOT_LIMIT=1 -e QUEUED_INPUT_LIMIT_PER_SESSION=1 \
    -e STORAGE_LIMIT_BYTES=1000000 -e MAX_TURN_SECONDS=60 \
    -e SESSION_COST_LIMIT_USD=1 \
    "$image")"
  sleep 3
  if [ "$(docker inspect -f '{{.State.Running}}' "$cid")" != true ]; then
    docker logs "$cid" >&2
    echo "API container exited" >&2
    exit 1
  fi
  pid1="$(docker exec "$cid" cat /proc/1/comm)"
  echo "PID 1: $pid1"
  [ "$pid1" = tini ] || { echo "expected tini as PID 1, not $pid1" >&2; exit 1; }
  # The server is the only bun in the container at this point.
  server_ppid="$(docker exec "$cid" sh -c 'for d in /proc/[0-9]*; do awk "/^Name:/ { n = \$2 } /^PPid:/ && n == \"bun\" { print \$2 }" "$d/status" 2>/dev/null; done')"
  echo "server parent: $server_ppid"
  [ "$server_ppid" = 1 ] || { echo "expected the server to be tini's child" >&2; exit 1; }
  zombies="$(docker exec "$cid" bun -e "$zombie_probe")"
  echo "zombies after 5 git timeouts under tini: $zombies"
  [ "$zombies" = 0 ] || { echo "expected no zombies" >&2; exit 1; }

  # Negative control: with bun as PID 1 the same probe must find zombies,
  # or the check above proves nothing.
  cid="$(docker run -d --label "$smoke_label" --entrypoint /usr/local/bin/bun \
    "$image" -e 'setInterval(() => {}, 1 << 30)')"
  control="$(docker exec "$cid" bun -e "$zombie_probe")"
  echo "zombies after 5 git timeouts under bun as PID 1: $control"
  [ "$control" -gt 0 ] || { echo "the zombie probe found none without an init" >&2; exit 1; }
}

case "$app" in
  worker)
    # The ticket's check: the bundled executable resolves and is the version
    # the SDK pin promises. Also non-root, git present, workspace mount point.
    version="$(docker run --rm "$image" claude --version)"
    echo "claude --version: $version"
    echo "$version" | grep -q '^2\.1\.270 ' || { echo "expected 2.1.270"; exit 1; }
    docker run --rm "$image" sh -c 'test "$(id -u)" = 1000 && git --version && test -d /workspace'
    ;;
  api)
    # git: the checkpoint bundle verifier spawns it (94S-201).
    docker run --rm "$image" sh -c 'test "$(id -u)" = 1000 && test ! -e node_modules/@anthropic-ai && git --version && bun --version'
    api_init_smoke "$image"
    ;;
  scheduler)
    docker run --rm "$image" sh -c 'test ! -e node_modules/@anthropic-ai && bun --version'
    ;;
  *)
    echo "unknown app: $app" >&2
    exit 2
    ;;
esac
