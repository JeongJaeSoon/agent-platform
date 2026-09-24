#!/usr/bin/env bash
# The 94S-135 judgement run on one release candidate, as one command:
#
#   scripts/soak/rc.sh <rc-sha>
#
# Refuses unless this checkout is exactly <rc-sha> with nothing uncommitted,
# so the images, the runner and the configs are all that one commit. Then:
#
# 1. builds the images (scripts/soak/stack.sh up) and writes rc.json: the
#    SHA, every image id the stack runs, bun.lock's and the 24h config's
#    sha256 — before anything is measured;
# 2. runs every fault/contention campaign, each on its own reset stack;
# 3. resets the stack and runs the 24-hour soak (config/soak-24h.json).
#
# Campaigns go first: they share the soak135 project with the soak, so the
# two cannot overlap, and a defect they find should stop the run before a
# day is spent on it. Everything lands in $SOAK_STATE/rc-<sha7>/; progress
# is in its rc.log. The exit code is non-zero when either part failed.
set -uo pipefail
umask 077

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

[ "$#" -eq 1 ] || { echo "usage: $0 <rc-sha>" >&2; exit 2; }
rc="$(git rev-parse --verify "$1^{commit}")" || exit 2
head="$(git rev-parse HEAD)"
[ "$rc" = "$head" ] || { echo "checkout is ${head}, not the RC ${rc}" >&2; exit 2; }
[ -z "$(git status --porcelain)" ] || { echo "uncommitted changes; the run must be the RC alone" >&2; exit 2; }

state="${SOAK_STATE:-${TMPDIR:-/tmp}/soak135-state}"
out="$state/rc-${rc:0:7}"
[ ! -e "$out" ] || { echo "${out} exists; move it aside first" >&2; exit 2; }
mkdir -p "$out"
exec > >(tee -a "$out/rc.log") 2>&1
stamp() { echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

stamp "build ${rc}"
scripts/soak/stack.sh up || exit 1
# shellcheck disable=SC1091
source "$state/vars.sh"
images="$(scripts/soak/stack.sh compose ps -a --format '{{.Service}} {{.Image}}' |
  while read -r service image; do
    printf '%s\t%s\t%s\n' "$service" "$image" "$(docker image inspect --format '{{.Id}}' "$image")"
  done)"
jq -n --arg sha "$rc" --arg images "$images" \
  --arg lock "$(shasum -a 256 bun.lock | cut -d' ' -f1)" \
  --arg config "$(shasum -a 256 scripts/soak/config/soak-24h.json | cut -d' ' -f1)" \
  --arg worker "$WORKER_IMAGE $(docker image inspect --format '{{.Id}}' "$WORKER_IMAGE")" \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{rc_sha: $sha, built_at: $at, bun_lock_sha256: $lock, soak_24h_config_sha256: $config,
    worker_image: $worker,
    images: ($images | split("\n") | map(select(. != "") | split("\t") | {service: .[0], image: .[1], id: .[2]}))}' \
  >"$out/rc.json"
stamp "rc.json written"

status=0
stamp "campaigns"
SOAK_CAMPAIGNS_OUT="$out/campaigns" scripts/soak/campaign.sh || status=1

stamp "soak 24h"
scripts/soak/stack.sh reset || exit 1
source "$state/vars.sh"
bun scripts/soak/soak.ts scripts/soak/config/soak-24h.json "$out/soak" || status=1
stamp "done (status ${status})"
exit "$status"
