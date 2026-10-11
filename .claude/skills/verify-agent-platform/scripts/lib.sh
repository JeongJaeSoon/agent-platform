# Source this in every Bash call that drives the stack:
#   . .claude/skills/verify-agent-platform/scripts/lib.sh [run dir]
# It loads the run's state (project, ports, bootstrap token) and defines the
# drive helpers. Each Bash call is a fresh shell, so source it every time.

_verify_root=${VERIFY_AP_ROOT:-$(t=${TMPDIR:-/tmp}; echo "${t%/}")/verify-agent-platform}
_verify_run=${1:-$(cat "$_verify_root/latest" 2>/dev/null)}
# Without a loaded run every helper would fall through to the default
# project, so refuse to define them at all.
unset VERIFY_RUN VERIFY_REPO VERIFY_API COMPOSE_PROJECT_NAME
if [ -z "$_verify_run" ] || ! . "$_verify_run/state.env" ||
  [ -z "${VERIFY_REPO:-}" ] || [ -z "${VERIFY_API:-}" ] ||
  case "${COMPOSE_PROJECT_NAME:-}" in verify-ap-*) false ;; *) true ;; esac; then
  echo "lib.sh: no verification run state at '${_verify_run}'; run up.sh first" >&2
  return 1
fi
EVIDENCE=$VERIFY_RUN/evidence
API=$VERIFY_API

# Compose against this run's project only.
ap_compose() { (cd "$VERIFY_REPO" && docker compose --profile apps --profile fake-model "$@"); }

# Issue an API key; prints it (stdout) once. key id goes to stderr.
ap_key() { (cd "$VERIFY_REPO" && scripts/local.sh key "$@"); }
ap_revoke() { ap_compose exec -T api bun run apps/control-host/src/api/keys.ts revoke "$1"; }

# API-key calls. Session POSTs need an Idempotency-Key; ap_post adds one.
ap_get() { curl -sS -w '\n%{http_code}\n' "$API$1" -H "Authorization: Bearer $KEY"; }
ap_post() {
  curl -sS -w '\n%{http_code}\n' "$API$1" -H "Authorization: Bearer $KEY" \
    -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" -d "$2"
}

# Browser-style calls: the CSRF header the web client sends, and the session
# cookie kept in $VERIFY_RUN/cookie (curl will not store a __Host- cookie
# over http, so it is carried by hand).
# Works under bash and zsh (the Bash tool's shell), hence no variable named
# `path` (zsh ties it to PATH) and no unquoted ${x:+…} word splitting.
ap_web() {
  local method=$1 route=$2 extra=() headers
  [ -n "${3:-}" ] && extra+=(-d "$3")
  [ -s "$VERIFY_RUN/cookie" ] && extra+=(-H "Cookie: $(cat "$VERIFY_RUN/cookie")")
  headers=$(mktemp)
  curl -sS -w '\n%{http_code}\n' -X "$method" "$API$route" -D "$headers" \
    -H 'x-requested-with: agent-platform-web' -H 'Content-Type: application/json' \
    "${extra[@]}"
  local status=$?
  sed -n 's/^[Ss]et-[Cc]ookie: \(__Host-ap_session=[^;]*\).*/\1/p' "$headers" |
    tr -d '\r' | while read -r c; do printf '%s' "$c" >"$VERIFY_RUN/cookie"; done
  rm -f "$headers"
  return "$status"
}
