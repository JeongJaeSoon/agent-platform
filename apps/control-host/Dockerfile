# syntax=docker/dockerfile:1.7
# Control-host image (94S-117): one executable, three roles —
# `apps/control-host/src/main.ts api|scheduler|reconciler` — none of them
# with the Agent SDK or the Claude Code executable.
# Only the scheduler role is given the Docker socket, and it runs as root
# for that (compose `user:`); the image default stays uid 1000. Built from
# the repository root (`docker build -f apps/control-host/Dockerfile .`).
#
# Base pinned by the multi-arch index digest of oven/bun:1.3.10; see
# apps/worker/Dockerfile for why and tests/images.test.ts for the check.
ARG BUN_IMAGE=oven/bun:1.3.10@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
# THIRD_PARTY_NOTICES.md: the licenses of what this image ships (94S-338).
COPY package.json bun.lock bunfig.toml tsconfig.base.json THIRD_PARTY_NOTICES.md ./
COPY apps ./apps
COPY packages ./packages
# --filter limits the install to the one app this image runs, which is what
# keeps @anthropic-ai/* out of it; the lockfile stays frozen either way.
RUN bun install --frozen-lockfile --production \
    --filter ./apps/control-host \
  && test ! -e node_modules/@anthropic-ai

FROM ${BUN_IMAGE} AS runtime
# git: the checkpoint verifier fetches each workspace bundle into a scratch
# repository (94S-228); without the executable every checkpoint finalize
# fails with ENOENT and no pointer ever advances. The smoke test checks it.
# tini: see ENTRYPOINT.
# The upgrade: see APT_UPGRADE_KEY in apps/worker/Dockerfile.
ARG APT_UPGRADE_KEY=
RUN apt-get update --error-on=any \
  && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --with-new-pkgs \
  && apt-get install -y --no-install-recommends git tini \
  && rm -rf /var/lib/apt/lists/*
# The base image ships a non-root `bun` user as 1000:1000; the API runs as it.
RUN test "$(id -u bun)" = 1000
WORKDIR /app
COPY --from=deps --chown=1000:1000 /app /app
# The corresponding source of every Debian package in this image (94S-375);
# see apps/worker/Dockerfile.
RUN --mount=type=bind,source=scripts/third-party-notices.ts,target=/tmp/third-party-notices.ts \
  bun /tmp/third-party-notices.ts --debian-sources >DEBIAN_SOURCES.md
USER 1000:1000
ENV NODE_ENV=production
EXPOSE 3000
# An init as PID 1 wherever the image runs, not only under compose's
# `init: true`: the checkpoint verifier kills a git that outlives its timeout
# by process group, and the helpers that orphans are reparented to PID 1. bun
# never waits for children it did not spawn, so under bun each would stay a
# zombie for the container's life. `-s` makes tini the subreaper too when
# something else (`docker run --init`) already holds PID 1. It also forwards
# SIGTERM, which bun as PID 1 ignored until the stop timeout killed it. The
# base image's entrypoint stays in the chain so `docker run <image> <file>`
# still means `bun <file>`.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/docker-entrypoint.sh"]
# Other roles: `bun run apps/control-host/src/main.ts <scheduler|reconciler>`
# runs that role's pass loop (compose's services); add `--once` for one pass.
CMD ["bun", "run", "apps/control-host/src/main.ts", "api"]
