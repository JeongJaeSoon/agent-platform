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
#    (`soak` resumes from here once they finished, and past a failure only
#    with SOAK_RC_OVERRIDE naming why it was accepted);
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
  : >"$out/images.tsv"
  while read -r service image; do
    id="$(docker image inspect --format '{{.Id}}' "$image")" || die "no image ${image}"
    printf '%s\t%s\t%s\n' "$service" "$image" "$id" >>"$out/images.tsv"
  done <"$out/services.txt"
  lock="$(shasum -a 256 bun.lock | cut -d' ' -f1)"
  config="$(shasum -a 256 scripts/soak/config/soak-24h.json | cut -d' ' -f1)"
  worker="$(docker image inspect --format '{{.Id}}' "$WORKER_IMAGE")" || die "no image ${WORKER_IMAGE}"
  [ -n "$lock" ] && [ -n "$config" ] || die "incomplete provenance"
  jq -n --arg sha "$rc" --rawfile images "$out/images.tsv" --arg lock "$lock" --arg config "$config" \
    --arg worker "$WORKER_IMAGE $worker" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{rc_sha: $sha, built_at: $at, bun_lock_sha256: $lock, soak_24h_config_sha256: $config,
      worker_image: $worker,
      images: ($images | split("\n") | map(select(. != "") | split("\t") | {service: .[0], image: .[1], id: .[2]}))}' \
    >"$out/rc.json" || die "could not write rc.json"
  jq -e '(.images | length > 0 and all(.service != null and .image != null and (.id // "" | startswith("sha256:"))))' \
    "$out/rc.json" >/dev/null || die "rc.json has an image without an id: $out/rc.json"
  stamp "rc.json written"

  stamp "campaigns"
  if SOAK_CAMPAIGNS_OUT="$out/campaigns" scripts/soak/campaign.sh; then
    echo pass >"$out/campaigns.status"
  else
    echo fail >"$out/campaigns.status"
    stamp "a campaign failed: see $out/campaigns/summary.md; once settled, SOAK_RC_OVERRIDE='<why>' $0 ${rc} soak"
    exit 1
  fi
else
  # The soak shares the stack with the campaigns: only after they finished,
  # and past a failed one only with the reason it was accepted on record.
  case "$(cat "$out/campaigns.status" 2>/dev/null)" in
    pass) ;;
    fail)
      [ -n "${SOAK_RC_OVERRIDE:-}" ] || die "campaigns failed; set SOAK_RC_OVERRIDE to the reason it was accepted"
      stamp "soak past failed campaigns: ${SOAK_RC_OVERRIDE}"
      ;;
    *) die "campaigns have not finished (no ${out}/campaigns.status)" ;;
  esac
  # The image tags are fixed, so another candidate may have rebuilt them since.
  source "$state/vars.sh"
  for image in "$API_IMAGE" "$WORKER_IMAGE" "$EGRESS_PROXY_IMAGE"; do
    id="$(docker image inspect --format '{{.Id}}' "$image")" || die "no image ${image}"
    jq -e --arg image "$image" --arg id "$id" 'any(.images[]; .image == $image and .id == $id)' \
      "$out/rc.json" >/dev/null || die "${image} is ${id}, not the image rc.json recorded; rebuild with a full run"
  done
fi

# mkdir is the lock: one soak per run directory, whichever call gets here first.
mkdir "$out/soak" 2>/dev/null || die "${out}/soak exists: a soak already started there"

stamp "soak 24h"
scripts/soak/stack.sh reset || die "stack reset failed"
source "$state/vars.sh"
bun scripts/soak/soak.ts scripts/soak/config/soak-24h.json "$out/soak"
status=$?
stamp "done (status ${status})"
exit "$status"
