#!/usr/bin/env bash
# Known vulnerabilities in one app image (94S-338):
# `image-scan.sh <app> <image ref> <result dir>`.
#
# Grype over the whole image: Debian packages and the npm packages under
# /app. A release binary pinned by version and checksum rather than a
# third-party action, whose tags can be moved under us. The log gets the
# unfiltered table, unfixed findings included; the bar (high or critical
# with a fix available) goes to the step summary and to <result dir>/<app>.txt
# as `clean` or `found <n>`.
#
# Findings never fail this script: whether they fail anything is the
# caller's policy. A scan that could not run exits non-zero and leaves
# `error` in the result file.
set -euo pipefail

app="$1"
image="$2"
results="$3"

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

fixable='[.matches[] | select(.vulnerability.fix.state == "fixed")
  | select(.vulnerability.severity == "High" or .vulnerability.severity == "Critical")]'
count="$(jq "${fixable} | length" "${work}/scan.json")"
{
  echo "### ${app}: vulnerabilities"
  echo
  echo "${count} high or critical with a fix available. Full table in the step log."
  echo
  echo '```text'
  jq -r "${fixable}"'[] | "\(.artifact.name) \(.artifact.version) → \(.vulnerability.fix.versions | join(",")) \(.vulnerability.id) \(.vulnerability.severity)"' \
    "${work}/scan.json"
  echo '```'
} >>"${GITHUB_STEP_SUMMARY:-/dev/stdout}"

if [ "$count" -gt 0 ]; then
  result="found ${count}"
  echo "::warning::${app}: ${count} high or critical vulnerabilities with a fix available"
else
  result=clean
fi
