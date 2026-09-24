# syntax=docker/dockerfile:1.7
# Worker image: Bun runtime + the workspace's production closure + the Claude
# Code executable bundled with @anthropic-ai/claude-agent-sdk 0.3.270. Built
# from the repository root (`docker build -f apps/worker/Dockerfile .`).
#
# Base pinned by the multi-arch index digest of oven/bun:1.3.10 so amd64 CI
# and arm64 laptops build from one file. tests/images.test.ts keeps the three
# app Dockerfiles on the same digest; bump them together.
#
# The pin fixes Bun, not Debian: oven/bun does not rebuild a released tag, so
# the base's packages age with it (94S-363). Every shipped stage therefore
# runs `apt-get upgrade`, keyed by APT_UPGRADE_KEY: images.yml passes the UTC
# date, so its layer cache takes each day's security fixes once; a local
# build keeps its cached layer. Two builds of one commit on different days
# can differ in Debian package versions; a release pins what it shipped by
# image digest. `--error-on=any`: a source that failed to fetch would
# otherwise leave its fixes out of a build that still passes. A fix that
# would remove a package stays held back (no full-upgrade in an image) and
# surfaces in images.yml's scan instead.
ARG BUN_IMAGE=oven/bun:1.3.10@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
# THIRD_PARTY_NOTICES.md: the licenses of what this image ships (94S-338).
COPY package.json bun.lock bunfig.toml tsconfig.base.json THIRD_PARTY_NOTICES.md ./
COPY apps ./apps
COPY packages ./packages
# The lockfile carries every SDK platform package; --production keeps the
# linux ones that match this build's arch and drops testkit, drizzle-kit and
# the other devDependencies. Of the two linux builds, the resolver only falls
# back to musl when the glibc one is missing, so once the glibc build is
# proven present the ~200 MB musl twin is dropped here, before its layer is
# copied into the runtime stage.
RUN bun install --frozen-lockfile --production \
  && test -x "$(bun -e 'import { resolvePinnedClaudeExecutable } from "./packages/adapters/runtimes/claude/src/runtime.ts"; console.log(resolvePinnedClaudeExecutable())')" \
  && rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-*-musl

FROM ${BUN_IMAGE} AS runtime
# git: workspace checkout, bundles and the tools Claude Code shells out to.
# ca-certificates: the egress proxy tunnels TLS, the worker still verifies it.
# tini: see ENTRYPOINT.
# xfsprogs: not for the worker. The scheduler runs this image once more per
# launch, as a short-lived helper that puts the inode ceiling on the session
# volume (xfs_io, xfs_quota; packages/adapters/execution/local-docker
# workspace-inodes.ts), so the daemon needs no second image for it.
# The upgrade: see ARG APT_UPGRADE_KEY.
ARG APT_UPGRADE_KEY=
RUN apt-get update --error-on=any \
  && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --with-new-pkgs \
  && apt-get install -y --no-install-recommends ca-certificates git tini xfsprogs \
  && rm -rf /var/lib/apt/lists/*
# uid/gid 1000 is what LocalDockerBackend runs the container as
# (DEFAULT_WORKER_USER); the base image already owns it as user `bun`, so
# the build asserts that instead of adding a second account. /workspace is
# the mount point of the per-session volume; Docker seeds a fresh volume from
# the image path, so the directory must already exist with the worker's
# ownership (image contract, README).
RUN test "$(id -u bun)" = 1000 && test "$(id -g bun)" = 1000 \
  && mkdir -p /workspace && chown 1000:1000 /workspace
WORKDIR /app
COPY --from=deps --chown=1000:1000 /app /app
# Resolve the executable exactly the way the runtime does at run time
# (resolvePinnedClaudeExecutable) and put it on PATH as `claude`, so
# `docker run --rm <image> claude --version` reports the bundled build and the
# build fails if the SDK ever stops shipping it for this arch.
RUN target="$(bun -e 'import { resolvePinnedClaudeExecutable } from "./packages/adapters/runtimes/claude/src/runtime.ts"; console.log(resolvePinnedClaudeExecutable())')" \
  && test -x "$target" \
  && ln -s "$target" /usr/local/bin/claude \
  && claude --version
# DEBIAN_SOURCES.md: the source package and version of every Debian package
# in this image, with its snapshot.debian.org address, which is how the
# notices meet the GPL's source obligation (94S-375). Written from this
# image's own dpkg database after the last apt-get, because the upgrade makes
# the versions a property of the build, not of the commit. images.yml fails
# the build when a later step changes the installed packages.
RUN --mount=type=bind,source=scripts/third-party-notices.ts,target=/tmp/third-party-notices.ts \
  bun /tmp/third-party-notices.ts --debian-sources >DEBIAN_SOURCES.md
USER 1000:1000
ENV NODE_ENV=production
VOLUME ["/workspace"]
# An init as PID 1, as in apps/control-host/Dockerfile: a git the workspace code
# kills at its deadline and the tool processes Claude Code leaves behind are
# reparented to PID 1, and bun never reaps children it did not spawn, so
# under bun each stays a zombie for the session's life. tini reaps them and
# forwards the SIGTERM that starts the drain. `-s` keeps it the subreaper
# when something else (`docker run --init`) holds PID 1.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/docker-entrypoint.sh"]
# The scheduler passes bootstrap identity through env (WORKER_EXECUTION_ID,
# WORKER_BOOTSTRAP_NONCE, WORKER_GATEWAY_URL, ...) and may override Cmd.
CMD ["bun", "run", "apps/worker/src/main.ts"]
