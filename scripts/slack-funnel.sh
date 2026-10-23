#!/usr/bin/env bash
# Opens only Slack's events path of a local API to the internet through
# Tailscale Funnel, so Slack can reach POST /v1/slack/events/<agent_id>.
# Funnel is switched on per port, not per path: anything else served on
# that port (e.g. a `tailscale serve` of the console) goes public too, so
# give the console another port.
#
#   on      https://<host>.ts.net[:<https>]/v1/slack/events → http://127.0.0.1:$PORT/v1/slack/events
#   off     removes that mapping (the same --https and --set-path as on)
#   status  tailscale funnel status
#
# Set SLACK_EVENTS_PUBLIC_URL=https://<host>.ts.net[:<https>] on the API
# afterwards, then run Finalize (an install, or `slack-app finalize`).
#
# Usage: PORT=<api port> scripts/slack-funnel.sh on
#        scripts/slack-funnel.sh off|status
# SLACK_FUNNEL_HTTPS_PORT picks the public port: 443 (default), 8443 or 10000,
# the ports Funnel serves.
set -euo pipefail

EVENTS_PATH=/v1/slack/events
HTTPS_PORT="${SLACK_FUNNEL_HTTPS_PORT:-443}"

usage() {
  sed -n '/^# Usage:/,/^# the ports/p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

[[ $# -eq 1 ]] || usage
case "$HTTPS_PORT" in
  443 | 8443 | 10000) ;;
  *)
    echo "slack-funnel: SLACK_FUNNEL_HTTPS_PORT must be 443, 8443 or 10000" >&2
    exit 2
    ;;
esac
command -v tailscale >/dev/null || {
  echo "slack-funnel: tailscale is not on PATH" >&2
  exit 1
}

case "$1" in
  on)
    if [[ ! "${PORT:-}" =~ ^[0-9]{1,5}$ ]] || ((PORT < 1 || PORT > 65535)); then
      echo "slack-funnel: set PORT to the API's local port" >&2
      exit 2
    fi
    tailscale funnel --bg "--https=$HTTPS_PORT" "--set-path=$EVENTS_PATH" \
      "http://127.0.0.1:$PORT$EVENTS_PATH"
    tailscale funnel status
    ;;
  off)
    tailscale funnel "--https=$HTTPS_PORT" "--set-path=$EVENTS_PATH" off
    tailscale funnel status
    ;;
  status)
    tailscale funnel status
    ;;
  *) usage ;;
esac
