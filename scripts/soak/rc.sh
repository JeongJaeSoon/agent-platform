#!/usr/bin/env bash
# The 94S-135 judgement run on one release candidate, as one command:
#
#   scripts/soak/rc.sh <rc-sha>         build, record, campaigns, then the soak
#   scripts/soak/rc.sh <rc-sha> soak    only the soak, into the same run
#
# Refuses unless this checkout is <rc-sha>, or a later commit that changed
# nothing under infra/ since, with nothing uncommitted. A later checkout is
# the tools commit: the images are built from <rc-sha> in a throwaway
# worktree, and the runner, overlays and configs come from this checkout, so
# a tool fix never moves the product under test. Then:
#
# 1. runs the D2 gate (scripts/d2-gate/run.sh: A–E, R1–R2, H1–H5) on images
#    built from <rc-sha>, under a project of its own, and stops if it failed:
#    no candidate goes on without it (94S-404);
# 2. builds the images (never reusing tags) and writes rc.json: the RC and
#    tools SHAs, every image id the stack runs, the RC's bun.lock and the 24h
#    config's sha256 — before anything is measured, and refusing to go on
#    with a field empty;
# 3. runs every fault/contention campaign, each on its own reset stack, and
#    stops if any failed, so no day is spent on a candidate with a defect
#    (`soak` resumes from here once they finished, and past a failure only
#    with SOAK_RC_OVERRIDE naming why it was accepted);
# 4. resets the stack and runs the 24-hour soak (config/soak-24h.json).
#
# Campaigns go first because they share the soak135 project with the soak.
# Everything lands in $SOAK_STATE/rc-<sha7>/, progress in its rc.log, the
# gate's report in d2-gate/.
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
[ -z "$(git status --porcelain)" ] || die "uncommitted changes; the run must be committed tools alone"
if [ "$rc" != "$head" ]; then
  git merge-base --is-ancestor "$rc" "$head" || die "checkout ${head} does not descend from the RC ${rc}"
  # The compose base file is product configuration: it must be the RC's.
  git diff --quiet "$rc" "$head" -- infra || die "infra/ changed since the RC ${rc}"
fi
export SOAK_PRODUCT_SHA="$rc"

state="${SOAK_STATE:-${TMPDIR:-/tmp}/soak135-state}"
out="$state/rc-${rc:0:7}"
if [ "$stage" = all ]; then
  [ ! -e "$out" ] || die "${out} exists; move it aside first"
else
  [ -f "$out/rc.json" ] || die "no ${out}/rc.json; run without a stage first"
  jq -e --arg head "$head" '.tools_sha == $head' "$out/rc.json" >/dev/null ||
    die "checkout ${head} is not the tools commit the campaigns ran with ($out/rc.json)"
fi
mkdir -p "$out"
exec > >(tee -a "$out/rc.log") 2>&1
stamp() { echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

if [ "$stage" = all ]; then
  # From nothing: a stack left up (its database, bucket and Gitea) fails the
  # fixture and would carry state into the run.
  scripts/soak/stack.sh down || die "stack down failed"
  # down swallows removal errors: check nothing of the project or installation survived.
  for label in com.docker.compose.project=soak135 agent-platform.installation=soak135; do
    for list in "container ls -a" "volume ls"; do
      # shellcheck disable=SC2086
      left="$(docker $list -q --filter "label=${label}")" || die "docker ${list} failed"
      [ -z "$left" ] || die "${list%% *}s labelled ${label} survived stack down"
    done
  done
  src="$root"
  if [ "$rc" != "$head" ]; then
    src="$state/src-${rc:0:7}"
    git worktree remove --force "$src" 2>/dev/null
    # The images copy these files as checked out: umask 077 would leave them
    # unreadable to the containers' non-root users.
    (umask 022 && git worktree add --detach "$src" "$rc" >/dev/null) || die "could not check out ${rc}"
  fi
  stamp "d2 gate"
  D2_GATE_OUT="$out/d2-gate" D2_GATE_BUILD_ROOT="$src" scripts/d2-gate/run.sh
  gated=$?
  if [ "$gated" -ne 0 ]; then
    [ "$src" = "$root" ] || git worktree remove --force "$src"
    die "the D2 gate failed: see $out/d2-gate/report.md and test.log"
  fi
  stamp "build ${rc}"
  lock="$(shasum -a 256 "$src/bun.lock" | cut -d' ' -f1)"
  export SOAK_PRODUCT_BUN_LOCK="$lock"
  SOAK_SKIP_BUILD=0 SOAK_BUILD_ROOT="$src" scripts/soak/stack.sh up
  built=$?
  [ "$src" = "$root" ] || git worktree remove --force "$src"
  [ "$built" -eq 0 ] || die "stack up failed"
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
  config="$(shasum -a 256 scripts/soak/config/soak-24h.json | cut -d' ' -f1)"
  worker="$(docker image inspect --format '{{.Id}}' "$WORKER_IMAGE")" || die "no image ${WORKER_IMAGE}"
  [ -n "$lock" ] && [ -n "$config" ] || die "incomplete provenance"
  jq -n --arg sha "$rc" --arg tools "$head" --rawfile images "$out/images.tsv" --arg lock "$lock" --arg config "$config" \
    --arg worker "$WORKER_IMAGE $worker" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{rc_sha: $sha, tools_sha: $tools, built_at: $at, bun_lock_sha256: $lock, soak_24h_config_sha256: $config,
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

# The soak's own record names the images' lockfile, not this checkout's.
SOAK_PRODUCT_BUN_LOCK="$(jq -r .bun_lock_sha256 "$out/rc.json")" || die "unreadable ${out}/rc.json"
export SOAK_PRODUCT_BUN_LOCK

# mkdir is the lock: one soak per run directory, whichever call gets here first.
mkdir "$out/soak" 2>/dev/null || die "${out}/soak exists: a soak already started there"

stamp "soak 24h"
scripts/soak/stack.sh reset || die "stack reset failed"
source "$state/vars.sh"
bun scripts/soak/soak.ts scripts/soak/config/soak-24h.json "$out/soak"
status=$?
stamp "done (status ${status})"
exit "$status"
