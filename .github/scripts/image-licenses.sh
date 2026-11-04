#!/usr/bin/env bash
# What one app image ships, against THIRD_PARTY_NOTICES.md
# `image-licenses.sh <control-host|worker|egress-proxy> <image ref> [build|publish|publish-main|skip-snapshot]`.
#
# The notices are computed from bun.lock; this is where that model meets a
# built image. Every npm package under /app must be listed for this app, the
# Bun builds and license texts the notices name must be the ones inside, and
# /app/DEBIAN_SOURCES.md must match the installed packages (the script runs
# on the image's own Bun, with the checkout mounted read-only). Every Debian
# package must carry the copyright file the notices point to. Shared by images.yml's build and publish jobs, like image-smoke.sh.
set -euo pipefail

app="$1"
image="$2"
mode="${3:-build}"
case "$mode" in
  build | publish | publish-main | skip-snapshot) ;;
  *)
    echo "::error::image-licenses.sh: unknown mode ${mode}"
    exit 2
    ;;
esac

docker run --rm --entrypoint bun -v "$PWD:/repo:ro" "$image" \
  /repo/scripts/third-party-notices.ts --verify "$app" /app

# The corresponding-source list this build shipped, for the log.
echo "::group::${app}: /app/DEBIAN_SOURCES.md"
docker run --rm --entrypoint cat "$image" /app/DEBIAN_SOURCES.md
echo "::endgroup::"

# Whether snapshot.debian.org really holds every listed source. It imports
# the archive every few hours, so a build right after a Debian security
# release can list a version it does not hold yet, and it is a volunteer
# service that can be down: both only warn while building. A release
# (`publish`) goes out only with every source on record. A main build
# (`publish-main`) fails on a source the service denies and goes out with the
# ones it did not answer for, listed in unverified-sources/<app>.txt: the file
# exists after every publish check, so its absence never reads as "none".
# The budget keeps an outage inside the step's timeout.
if [ "$mode" != skip-snapshot ]; then
  check=(docker run --rm --entrypoint bun -v "$PWD:/repo:ro" "$image"
    /repo/scripts/third-party-notices.ts --snapshot-check /app/DEBIAN_SOURCES.md)
  if [ "$mode" = publish-main ]; then
    check+=(240)
  fi
  answers="$(mktemp)"
  # tee, so a cancelled step still logs what it heard. pipefail carries the
  # check's exit code through.
  if { "${check[@]}" 2>&1 >&3 | tee "$answers" >&2; } 3>&1; then
    status=0
  else
    status=$?
  fi

  unverified="unverified-sources/${app}.txt"
  if [ "$mode" != build ]; then
    mkdir -p unverified-sources
    : >"$unverified"
  fi
  case "${mode}:${status}" in
    *:0) ;;
    publish-main:3)
      sed -n 's/^unreachable: //p' "$answers" >"$unverified"
      if [ ! -s "$unverified" ]; then
        echo "::error::${app}: the check found unreachable sources but listed none"
        exit 1
      fi
      count="$(wc -l <"$unverified" | tr -d ' ')"
      echo "::warning::${app}: snapshot.debian.org did not answer for ${count} sources; this main build goes out with them unverified"
      {
        echo "### ${app}: ${count} sources unverified on snapshot.debian.org"
        sed 's/^/- /' "$unverified"
      } >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
      ;;
    publish:* | publish-main:*)
      echo "::error::${app}: snapshot.debian.org does not hold every source /app/DEBIAN_SOURCES.md names (exit ${status})"
      exit 1
      ;;
    *) echo "::warning::${app}: snapshot.debian.org does not hold every source /app/DEBIAN_SOURCES.md names (fails on publish)" ;;
  esac
fi

# \${Package} reaches the image's sh as ${Package} inside double quotes, which
# dpkg-query, not the shell, expands. Installed packages only: one removed
# with its configuration kept is still listed, without its docs.
missing="$(docker run --rm --entrypoint sh "$image" -c \
  'dpkg-query -W -f "\${db:Status-Status} \${Package}\n" | while read -r s p; do [ "$s" = installed ] || continue; [ -e "/usr/share/doc/$p/copyright" ] || echo "$p"; done')"
if [ -n "$missing" ]; then
  echo "::error::${app}: Debian packages without /usr/share/doc/<package>/copyright: ${missing//$'\n'/ }"
  exit 1
fi
echo "${app}: every Debian package carries its copyright file"
