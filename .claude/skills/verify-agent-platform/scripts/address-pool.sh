#!/usr/bin/env bash
# Check, read-only, that Docker's default address pools still fit <needed>
# more networks. Each network the daemon allocates takes one pool entry
# (2^(Size - base prefix) entries per pool), whether compose or the scheduler
# made it, so a full pool lets a stack come up and then fail at its first
# worker launch. Exit 1 with the counts, and the networks holding the pool
# by compose project or installation, when it is short.
#
#   address-pool.sh <needed>
set -euo pipefail

needed=${1:?usage: address-pool.sh <needed>}
command -v jq >/dev/null || { echo "address-pool.sh: jq is not installed" >&2; exit 1; }

pools=$(docker info --format '{{json .DefaultAddressPools}}')
ids=$(docker network ls -q)
# shellcheck disable=SC2086 # one argument per network id
networks=$(if [ -n "$ids" ]; then docker network inspect $ids; else echo '[]'; fi)

report=$(jq -n -r --argjson pools "${pools:-null}" --argjson needed "$needed" --argjson networks "$networks" '
  def ip: split(".") | map(tonumber) | .[0] * 16777216 + .[1] * 65536 + .[2] * 256 + .[3];
  def cidr: split("/") | {start: (.[0] | ip), len: (.[1] | tonumber)};
  def ipv4: test("^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+/[0-9]+$");
  [($pools // [])[] | select(.Base | ipv4) | (.Base | cidr) + {size: .Size}] as $p
  | ([$p[] | pow(2; .size - .len)] | add // 0) as $capacity
  | [$networks[]
      | (.Labels // {}) as $l
      | ($l["com.docker.compose.project"] // $l["agent-platform.installation"] // .Name) as $owner
      | (.IPAM.Config // [])[] | .Subnet // "" | select(ipv4) | cidr as $s
      | $p[] | select($s.start >= .start and $s.start < .start + pow(2; 32 - .len) and $s.len >= .len)
      | {owner: $owner, used: (if $s.len >= .size then 1 else pow(2; .size - $s.len) end)}
    ] as $used
  | ([$used[].used] | add // 0) as $taken
  | if $capacity == 0 then "unknown"
    elif $capacity - $taken >= $needed then "ok \($capacity - $taken) free of \($capacity), \($needed) needed"
    else
      "short \($capacity - $taken) free of \($capacity), \($needed) needed",
      ($used | group_by(.owner) | map({owner: .[0].owner, n: (map(.used) | add)}) | sort_by(-.n, .owner)[]
        | "  \(.n)\t\(.owner)")
    end
')

case "$report" in
  unknown)
    echo "address-pool.sh: Docker reports no IPv4 default address pool; not checked" >&2 ;;
  ok*)
    echo "address-pool.sh: ${report#ok }" >&2 ;;
  *)
    {
      head=${report%%$'\n'*}
      echo "address-pool.sh: Docker's address pools are short: ${head#short }"
      echo "address-pool.sh: networks holding the pool, by compose project or installation:"
      echo "$report" | tail -n +2
    } >&2
    exit 1 ;;
esac
