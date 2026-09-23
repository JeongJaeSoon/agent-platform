#!/usr/bin/env bash
# Fails when a Docker daemon holds an image from Docker Hub: CI pulls those
# from its ghcr.io mirror (ci-image-mirror.yml, 94S-308). It looks at what
# was actually pulled, so it catches a Docker Hub pull however it was made —
# a service, a `docker run` in a step, or a suite calling the Engine API with
# a name no static check recognizes.
#
# The rule is "not Docker Hub", not "only the mirror": the runner image ships
# images of its own (ghcr.io/github/..., ghcr.io/dependabot/...) that no step
# pulled.
#
# usage: assert-no-docker-hub-images.sh <docker command...>
#   e.g. assert-no-docker-hub-images.sh docker
#        assert-no-docker-hub-images.sh env DOCKER_HOST=unix:///tmp/apq/docker.sock docker
set -euo pipefail

# An assignment, so a daemon that cannot answer fails here rather than
# reading as an empty, clean list.
listing=$("$@" images --format '{{.Repository}}')
echo "images on this daemon:"
echo "${listing:-(none)}" | sed 's/^/  /'

failed=0
while IFS= read -r repository; do
  # Dangling: no name left to judge by.
  [ -z "$repository" ] || [ "$repository" = "<none>" ] && continue
  first=${repository%%/*}
  # Docker's own rule: a first component is a registry host only when it has
  # a dot or a port, or is localhost; otherwise the name is on Docker Hub.
  if [ "$first" != "$repository" ] && { [[ "$first" == *[.:]* ]] || [ "$first" = localhost ]; }; then
    case "$first" in
    docker.io | index.docker.io | registry-1.docker.io) ;;
    *) continue ;;
    esac
  fi
  echo "::error::${repository} came from Docker Hub; mirror it in ci-image-mirror.yml and pull it from there (README § CI)"
  failed=1
done <<<"$listing"
exit "$failed"
