#!/usr/bin/env bash
# Known vulnerabilities in one app image (94S-338):
# `image-scan.sh <app> <image ref> <result dir>`.
#
# Grype over the whole image: Debian packages and the npm packages under
# /app. A release binary pinned by version and checksum rather than a
# third-party action, whose tags can be moved under us. The log gets the
# unfiltered table. High and critical findings go to the step summary and to
# <result dir>/<app>.json, split by whether a fix is available; only the
# fixable ones that .github/vulnerability-exceptions.json does not cover
# count, and <result dir>/<app>.txt says `clean` or `found <n>`.
#
# Findings never fail this script: whether they fail anything is the
# caller's policy (the `supply-chain` job and `publish` in images.yml). A
# scan that could not run exits non-zero and leaves `error` in the result
# file.
set -euo pipefail

app="$1"
image="$2"
results="$3"
exceptions="$(dirname "$0")/../vulnerability-exceptions.json"

GRYPE_VERSION=0.119.0
GRYPE_SHA256=3fa2dc4b924621ab65404cf08d0b8438d896d80ab949c9d5a4ca283c36004c9b

mkdir -p "$results"
result=error
work="$(mktemp -d)"
trap 'echo "$result" >"${results}/${app}.txt"; rm -rf "$work"' EXIT

curl -fsSL --retry 3 -o "${work}/grype.tar.gz" \
  "https://github.com/anchore/grype/releases/download/v${GRYPE_VERSION}/grype_${GRYPE_VERSION}_linux_amd64.tar.gz"
(cd "$work" && echo "${GRYPE_SHA256}  grype.tar.gz" | sha256sum -c - && tar -xzf grype.tar.gz grype)

# Grype refuses a database older than five days on its own, so a stale one
# is an error here, not a quiet pass.
"${work}/grype" db update
"${work}/grype" "docker:${image}" -o table -o "json=${work}/scan.json"

# Same shape as npm-audit.ts's findings. `fix` is null for `not-fixed`,
# `wont-fix` and `unknown` alike: none of them has a version to move to.
jq --slurpfile exceptions "$exceptions" --arg today "$(date -u +%F)" '
  [.matches[]
    | select(.vulnerability.severity == "High" or .vulnerability.severity == "Critical")
    | {package: .artifact.name, version: .artifact.version,
       id: .vulnerability.id, severity: (.vulnerability.severity | ascii_downcase),
       fix: (if .vulnerability.fix.state == "fixed"
             then (.vulnerability.fix.versions | join(",")) else null end)}
    | . as $f
    | ($exceptions[0] | map(select(.id == $f.id and .package == $f.package
        and .expires >= $today)) | first) as $e
    | if $e then . + {excepted: $e.reason} else . end]
  | unique' "${work}/scan.json" >"${results}/${app}.json"

count="$(jq '[.[] | select(.fix != null and .excepted == null)] | length' "${results}/${app}.json")"
unfixed="$(jq '[.[] | select(.fix == null)] | length' "${results}/${app}.json")"
line='"\(.severity) \(.package) \(.version) → \(.fix // "no fix") \(.id)\(if .excepted then " (excepted: \(.excepted))" else "" end)"'
{
  echo "### ${app}: vulnerabilities"
  echo
  echo "${count} high or critical with a fix available, ${unfixed} without one (reported, not blocking). Full table in the step log."
  echo
  echo '```text'
  jq -r ".[] | select(.fix != null) | ${line}" "${results}/${app}.json"
  echo '```'
  echo
  echo "<details><summary>${unfixed} without a fix</summary>"
  echo
  echo '```text'
  jq -r ".[] | select(.fix == null) | ${line}" "${results}/${app}.json"
  echo '```'
  echo
  echo "</details>"
  echo
} >>"${GITHUB_STEP_SUMMARY:-/dev/stdout}"

if [ "$count" -gt 0 ]; then
  result="found ${count}"
  echo "::warning::${app}: ${count} high or critical vulnerabilities with a fix available"
else
  result=clean
fi
