#!/usr/bin/env bash
# Runs docs/quickstart.md as written (94S-134): every ```bash block, in
# order, in one bash, from the repository root — the page's own commands, on
# its own default ports and project. Each block is printed before it runs,
# so the log reads as the terminal record of following the page.
#
# Meant for a fresh machine (the CI `quickstart` job): it starts the stack
# the page starts, `agent-platform` on 127.0.0.1:3000 and friends, and
# collides with one already running there. QUICKSTART_OUT (default: a fresh
# temp dir) receives the generated script and the compose logs.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
out="${QUICKSTART_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/quickstart.XXXXXX")}"
mkdir -p "$out"
script="$out/quickstart.sh"

# Each block becomes: print it, then run it. The quoted heredoc prints the
# block byte for byte; its tag cannot occur in the page.
awk '
  /^```bash[[:space:]]*$/ { inside = 1; n++; body = ""; next }
  inside && /^```[[:space:]]*$/ {
    inside = 0
    printf "printf \"\\n### docs/quickstart.md block %d\\n\"\n", n
    printf "cat <<\047QUICKSTART_BLOCK\047\n%sQUICKSTART_BLOCK\n%s", body, body
    next
  }
  inside { body = body $0 "\n" }
' docs/quickstart.md >"$script"
grep -q QUICKSTART_BLOCK "$script" || { echo "no bash blocks in docs/quickstart.md" >&2; exit 1; }

trap 'docker compose --profile apps logs --no-color --timestamps >"$out/compose.log" 2>&1 || true; echo "quickstart record: $out" >&2' EXIT
echo "== docs/quickstart.md: $(grep -c '^```bash' docs/quickstart.md) bash blocks" >&2
bash "$script"
echo "== quickstart: every block ran" >&2
