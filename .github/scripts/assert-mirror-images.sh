#!/usr/bin/env bash
# Fails when a Docker daemon holds an image that did not come from the CI
# mirror (ci-image-mirror.yml, 94S-308). It looks at what was actually
# pulled, so it catches a Docker Hub pull however it was made — a service,
# a `docker run` in a step, or a suite calling the Engine API with a name
# no test pattern recognizes.
#
# usage: assert-mirror-images.sh <docker command...>
#   e.g. assert-mirror-images.sh docker
#        assert-mirror-images.sh env DOCKER_HOST=unix:///tmp/apq/docker.sock docker
set -euo pipefail

MIRROR="ghcr.io/jeongjaesoon/agent-platform-ci/"

# An assignment, so a daemon that cannot answer fails here rather than
# reading as an empty, clean list.
listing=$("$@" images --format '{{.Repository}}@{{.Digest}}')
echo "images on this daemon:"
echo "${listing:-  (none)}" | sed 's/^/  /'

offenders=$(grep -v "^${MIRROR}" <<<"$listing" || true)
if [ -n "$offenders" ]; then
  while IFS= read -r image; do
    echo "::error::${image%@*} did not come from the CI mirror; add it to ci-image-mirror.yml and pull it from there (README § CI)"
  done <<<"$offenders"
  exit 1
fi
