#!/usr/bin/env bash
# Smoke for one app image: `image-smoke.sh <api|worker|scheduler> <image ref>`.
# Shared by images.yml's build (loaded image) and publish (the digest that
# was actually pushed) jobs so both check the same things.
set -euo pipefail

app="$1"
image="$2"

case "$app" in
  worker)
    # The ticket's check: the bundled executable resolves and is the version
    # the SDK pin promises. Also non-root, git present, workspace mount point.
    version="$(docker run --rm "$image" claude --version)"
    echo "claude --version: $version"
    echo "$version" | grep -q '^2\.1\.270 ' || { echo "expected 2.1.270"; exit 1; }
    docker run --rm "$image" sh -c 'test "$(id -u)" = 1000 && git --version && test -d /workspace'
    ;;
  api)
    docker run --rm "$image" sh -c 'test "$(id -u)" = 1000 && test ! -e node_modules/@anthropic-ai && bun --version'
    ;;
  scheduler)
    docker run --rm "$image" sh -c 'test ! -e node_modules/@anthropic-ai && bun --version'
    ;;
  *)
    echo "unknown app: $app" >&2
    exit 2
    ;;
esac
