#!/usr/bin/env bash
# Runs 94S-135 fault/contention campaigns, each on a freshly reset soak
# stack (scripts/soak/stack.sh reset: empty database, bucket and Gitea, same
# images), so one campaign's damage never becomes the next one's input.
#
#   scripts/soak/campaign.sh [campaign-id ...]    default: every campaign
#
# Needs a stack from `scripts/soak/stack.sh up` (for the images). Results go
# to $SOAK_STATE/campaigns-<stamp>/<campaign-id>/ and a combined
# summary.md; the exit code is non-zero when any campaign failed a row.
# An own-stack campaign (bun scripts/soak/campaigns.ts list) takes the soak
# stack down instead and brings projects of its own.
set -uo pipefail
umask 077

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
state="${SOAK_STATE:-${TMPDIR:-/tmp}/soak135-state}"
out="${SOAK_CAMPAIGNS_OUT:-$state/campaigns-$(date -u +%Y%m%dT%H%M%S)}"
mkdir -p "$out"

# Read up front: a listing that failed inside the loop's input would look
# like no campaigns at all and exit 0.
listing="$(bun scripts/soak/campaigns.ts list)" && [ -n "$listing" ] ||
  { echo "could not list the campaigns" >&2; exit 1; }
if [ "$#" -gt 0 ]; then
  campaigns=("$@")
else
  campaigns=()
  while IFS= read -r id; do campaigns+=("$id"); done < <(printf '%s\n' "$listing" | cut -f1)
fi

status=0
for id in "${campaigns[@]}"; do
  echo "== campaign ${id}" >&2
  if printf '%s\n' "$listing" | grep -q "^${id}	[a-z]*	own-stack	"; then
    # It brings projects of its own; the host holds two stacks at most.
    scripts/soak/stack.sh down >"$out/$id.down.log" 2>&1
    bun scripts/soak/campaigns.ts "$id" "$out/$id" 2>&1 | tee "$out/$id.log"
    [ "${PIPESTATUS[0]}" -eq 0 ] || status=1
    continue
  fi
  if ! scripts/soak/stack.sh reset >"$out/$id.reset.log" 2>&1; then
    echo "stack reset failed before ${id}; see $out/$id.reset.log" >&2
    status=1
    continue
  fi
  # shellcheck disable=SC1091
  source "$state/vars.sh"
  bun scripts/soak/campaigns.ts "$id" "$out/$id" 2>&1 | tee "$out/$id.log"
  [ "${PIPESTATUS[0]}" -eq 0 ] || status=1
done

{
  echo "# 94S-135 campaigns (images ${SOAK_PRODUCT_SHA:-$(git rev-parse HEAD)}, tools $(git rev-parse HEAD))"
  echo
  for id in "${campaigns[@]}"; do
    [ -f "$out/$id/report.md" ] || { echo "## ${id}: no report"; continue; }
    echo "## ${id}"
    sed -n '/^| id |/,$p' "$out/$id/report.md"
    echo
  done
} >"$out/summary.md"
echo "campaigns: $out/summary.md" >&2
exit "$status"
