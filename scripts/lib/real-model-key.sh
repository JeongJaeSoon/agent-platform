#!/usr/bin/env bash
# Shared by scripts/local.sh (up) and tests/e2e/run.sh (--real-model) for the key.
# The shell's export wins; else the ANTHROPIC_API_KEY line of the
# repository's .env (git- and docker-ignored), parsed as compose would
# (CRLF, `export `, matching quotes). Only that line is read: the rest of
# .env holds compose defaults these scripts must not take. xtrace is off
# while the value is in play. AGENT_PLATFORM_DOTENV names another file.
# Returns 0 with the key exported, 1 when there is none, 2 on bad quoting.

real_model_key_from_dotenv() {
  local file="${AGENT_PLATFORM_DOTENV:-.env}" value="" found="" line first last
  local restore_xtrace="" status=1
  case $- in *x*) restore_xtrace=1; set +x ;; esac

  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    status=0
  elif [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      case "$line" in
        "export ANTHROPIC_API_KEY="*) value="${line#export ANTHROPIC_API_KEY=}" ;;
        "ANTHROPIC_API_KEY="*) value="${line#ANTHROPIC_API_KEY=}" ;;
        *) continue ;;
      esac
      found=1
      first="${value:0:1}"
      last="${value: -1}"
      if [ "$first" = "'" ] || [ "$first" = '"' ] ||
        [ "$last" = "'" ] || [ "$last" = '"' ]; then
        if [ "${#value}" -lt 2 ] || [ "$first" != "$last" ]; then
          status=2
          break
        fi
        value="${value:1:${#value}-2}"
      fi
    done <"$file"
    if [ "$status" != 2 ] && [ -n "$found" ] && [ -n "$value" ]; then
      export ANTHROPIC_API_KEY="$value"
      status=0
    fi
  fi

  [ -z "$restore_xtrace" ] || set -x
  return "$status"
}
