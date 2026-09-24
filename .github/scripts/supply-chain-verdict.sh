#!/usr/bin/env bash
# The release policy over the scans' result files (94S-363):
# `supply-chain-verdict.sh <result dir> <no-verdict: warn|fail>`.
#
# Reads control-host, worker, egress-proxy (image-scan.sh) and npm
# (npm-audit.ts) from <result dir>/<name>.txt. `found <n>`, a high or
# critical finding with a fix available, always fails, and so does a missing
# file: the image was never built or never reached its scan. `error` means
# the scan ran and got no answer (release download, advisory database or
# service): a warning where an outage must not block every merge (pull
# requests, main pushes), a failure where a verdict is required (tags, the
# daily run). Findings without a fix never fail; they stay in the summary and
# the result artifact.
set -euo pipefail

results="$1"
no_verdict="$2"
case "$no_verdict" in warn | fail) ;; *)
  echo "usage: $0 <result dir> <warn|fail>" >&2
  exit 2
  ;;
esac

# An exception without its reason or expiry must not quietly clear a
# finding, whatever the mode: image-scan.sh applies the file without
# checking it, and npm-audit.ts's refusal alone would only be an `error`.
exceptions="$(dirname "$0")/../vulnerability-exceptions.json"
if ! jq -e 'type == "array" and all(.[];
    type == "object"
    and all(.id, .package, .reason; type == "string" and length > 0)
    and (.expires | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")))' \
  "$exceptions" >/dev/null; then
  echo "::error::${exceptions#*/.github/}: every entry needs id, package, reason and expires (YYYY-MM-DD)"
  exit 1
fi

found=0
missing=0
{
  echo "### supply-chain verdict"
  echo
  echo "| scan | result |"
  echo "| --- | --- |"
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
for scan in control-host worker egress-proxy npm; do
  result="$(cat "${results}/${scan}.txt" 2>/dev/null || echo "no result")"
  echo "${scan}: ${result}"
  echo "| ${scan} | ${result} |" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
  case "$result" in
    clean) ;;
    "found "*)
      found=1
      echo "::error::${scan}: ${result#found } high or critical with a fix available"
      ;;
    error)
      missing=1
      if [ "$no_verdict" = fail ]; then
        echo "::error::${scan}: no verdict (${result})"
      else
        echo "::warning::${scan}: no verdict (${result}); the daily run and the release check again"
      fi
      ;;
    *)
      found=1
      echo "::error::${scan}: ${result}"
      ;;
  esac
done

[ "$found" -eq 0 ] || exit 1
[ "$missing" -eq 0 ] || [ "$no_verdict" = warn ] || exit 1
