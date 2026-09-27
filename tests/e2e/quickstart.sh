#!/usr/bin/env bash
# Runs an executable guide as written: every ```bash block
# in order, in one bash, from the repository root. Each block is printed before it runs,
# so the log reads as the terminal record of following the page. The bash
# runs with -euo pipefail, which the page leaves out because a reader's
# interactive shell would close on the first failure; here it turns each
# `jq -e` line into an assertion.
#
# Meant for a fresh machine (the CI `quickstart` job): it starts the stack
# the page starts, `agent-platform` on 127.0.0.1:3000 and friends, and the
# page's last block (`scripts/local.sh down`) deletes it with its data —
# including a stack a reader already had running there. QUICKSTART_OUT (default: a fresh
# temp dir) receives the generated script and the compose logs.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
document="${1:-docs/quickstart.md}"
case "$document" in
  docs/quickstart.md | docs/api-guide.md) ;;
  *) echo "unsupported executable guide: $document" >&2; exit 1 ;;
esac
out="${QUICKSTART_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/quickstart.XXXXXX")}"
mkdir -p "$out"
script="$out/$(basename "$document" .md).sh"

# Each block becomes: print it, then run it. The quoted heredoc prints the
# block byte for byte; its tag cannot occur in the page.
awk -v document="$document" '
  /^```bash[[:space:]]*$/ { inside = 1; n++; body = ""; next }
  inside && /^```[[:space:]]*$/ {
    inside = 0
    printf "printf \"\\n### %s block %d\\n\"\n", document, n
    printf "cat <<\047QUICKSTART_BLOCK\047\n%sQUICKSTART_BLOCK\n%s", body, body
    next
  }
  inside { body = body $0 "\n" }
' "$document" >"$script"
grep -q QUICKSTART_BLOCK "$script" || { echo "no bash blocks in $document" >&2; exit 1; }

trap 'docker compose --profile apps logs --no-color --timestamps >"$out/compose.log" 2>&1 || true; echo "quickstart record: $out" >&2' EXIT
echo "== $document: $(grep -c '^```bash' "$document") bash blocks" >&2
bash -euo pipefail "$script"
echo "== $document: every block ran" >&2
