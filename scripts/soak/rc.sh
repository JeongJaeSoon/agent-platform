#!/usr/bin/env bash
# The 94S-135 judgement run on one release candidate, as one command:
#
#   scripts/soak/rc.sh <rc-sha>         build, record, campaigns, then the soak
#   scripts/soak/rc.sh <rc-sha> soak    only the soak, into the same run
#
# Refuses unless this checkout is exactly <rc-sha> with nothing uncommitted,
# so the images, the runner and the configs are all that one commit. Then:
#
# 1. builds the images (never reusing tags) and writes rc.json: the SHA,
#    every image id the stack runs, bun.lock's and the 24h config's sha256 —
#    before anything is measured, and refusing to go on with a field empty;
# 2. runs every fault/contention campaign, each on its own reset stack, and
#    stops if any failed, so no day is spent on a candidate with a defect
#    (`soak` resumes from here once that is settled);
# 3. resets the stack and runs the 24-hour soak (config/soak-24h.json).
#
# Campaigns go first because they share the soak135 project with the soak.
# Everything lands in $SOAK_STATE/rc-<sha7>/, progress in its rc.log.
set -uo pipefail
umask 077

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

die() { echo "rc.sh: $*" >&2; exit 2; }
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || die "usage: $0 <rc-sha> [soak]"
stage="${2:-all}"
[ "$stage" = all ] || [ "$stage" = soak ] || die "unknown stage '${stage}'"
rc="$(git rev-parse --verify "$1^{commit}")" || die "no commit $1"
head="$(git rev-parse HEAD)"
[ "$rc" = "$head" ] || die "checkout is ${head}, not the RC ${rc}"
[ -z "$(git status --porcelain)" ] || die "uncommitted changes; the run must be the RC alone"

state="${SOAK_STATE:-${TMPDIR:-/tmp}/soak135-state}"
out="$state/rc-${rc:0:7}"
if [ "$stage" = all ]; then
  [ ! -e "$out" ] || die "${out} exists; move it aside first"
else
  [ -f "$out/rc.json" ] || die "no ${out}/rc.json; run without a stage first"
fi
mkdir -p "$out"
exec > >(tee -a "$out/rc.log") 2>&1
stamp() { echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

if [ "$stage" = all ]; then
  stamp "build ${rc}"
  SOAK_SKIP_BUILD=0 scripts/soak/stack.sh up || die "stack up failed"
  # shellcheck disable=SC1091
  source "$state/vars.sh"
  # A file, not a heredoc: Homebrew's bash 5.3 hangs on large ones.
  scripts/soak/stack.sh compose ps -a --format '{{.Service}} {{.Image}}' >"$out/services.txt" ||
    die "compose ps failed"
  images=""
  while read -r service image; do
    id="$(docker image inspect --format '{{.Id}}' "$image")" || die "no image ${image}"
    images="${images}${service}	${image}	${id}
"
  done <"$out/services.txt"
  lock="$(shasum -a 256 bun.lock | cut -d' ' -f1)"
  config="$(shasum -a 256 scripts/soak/config/soak-24h.json | cut -d' ' -f1)"
  worker="$(docker image inspect --format '{{.Id}}' "$WORKER_IMAGE")" || die "no image ${WORKER_IMAGE}"
  [ -n "$images" ] && [ -n "$lock" ] && [ -n "$config" ] || die "incomplete provenance"
  jq -n --arg sha "$rc" --arg images "$images" --arg lock "$lock" --arg config "$config" \
    --arg worker "$WORKER_IMAGE $worker" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{rc_sha: $sha, built_at: $at, bun_lock_sha256: $lock, soak_24h_config_sha256: $config,
      worker_image: $worker,
      images: ($images | split("\n") | map(select(. != "") | split("\t") | {service: .[0], image: .[1], id: .[2]}))}' \
    >"$out/rc.json" || die "could not write rc.json"
  stamp "rc.json written"

  stamp "campaigns"
  if ! SOAK_CAMPAIGNS_OUT="$out/campaigns" scripts/soak/campaign.sh; then
    stamp "a campaign failed: see $out/campaigns/summary.md; once settled, $0 ${rc} soak"
    exit 1
  fi
fi

stamp "soak 24h"
scripts/soak/stack.sh reset || die "stack reset failed"
source "$state/vars.sh"
bun scripts/soak/soak.ts scripts/soak/config/soak-24h.json "$out/soak"
status=$?
stamp "done (status ${status})"
exit "$status"
