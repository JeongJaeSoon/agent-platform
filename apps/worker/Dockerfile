# syntax=docker/dockerfile:1.7
# Worker image: Bun runtime + the worker's production closure + the engine
# executables its installed runtimes bundle (@werft-ai/runtime-registry). Built
# from the repository root (`docker build -f apps/worker/Dockerfile .`).
#
# Base pinned by the multi-arch index digest of oven/bun:1.3.14 so amd64 CI
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
ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
# THIRD_PARTY_NOTICES.md: the licenses of what this image ships (94S-338).
COPY package.json bun.lock bunfig.toml tsconfig.base.json THIRD_PARTY_NOTICES.md ./
COPY apps ./apps
COPY packages ./packages
# --filter limits the install to apps/worker and the workspaces it depends on,
# which keeps the database driver, ORM and the web console's packages out. The lockfile
# carries every SDK platform package; --production keeps the linux ones that
# match this build's arch and drops testkit and the other devDependencies. The
# installed runtimes' image:verify checks each engine executable and drops the
# platform builds the engine will not run (for Claude, the ~200 MB musl twin),
# before this layer is copied into the runtime stage.
RUN bun install --frozen-lockfile --production \
    --filter ./apps/worker \
  && bun run --filter @werft-ai/runtime-registry image:verify

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
# The author and committer of Claude's commits when neither the repository nor
# the session sets one; without it git refuses to commit and Claude asks the
# user who they are (94S-423). System scope, so a `git config` the session
# runs still wins; the worker's own git reads no system config.
RUN git config --system user.name Werft \
  && git config --system user.email noreply@werft.invalid
# The session's commit trailers (Co-authored-by, Agent-Session): every client
# hook is one dispatcher that runs the repository's own hook of that name
# too, since core.hooksPath stops git looking in .git/hooks. System scope
# again, so the worker's own git (GIT_CONFIG_NOSYSTEM) runs none of them.
COPY --chmod=0755 apps/worker/git-hooks/werft-hook /usr/local/share/werft/git-hooks/werft-hook
RUN cd /usr/local/share/werft/git-hooks \
  && for hook in applypatch-msg pre-applypatch post-applypatch pre-commit \
    pre-merge-commit prepare-commit-msg commit-msg post-commit pre-rebase \
    post-checkout post-merge pre-push pre-auto-gc post-rewrite \
    sendemail-validate post-index-change; do ln -s werft-hook "$hook"; done \
  && git config --system core.hooksPath /usr/local/share/werft/git-hooks
# uid/gid 1000 is what LocalDockerBackend runs the container as
# (DEFAULT_WORKER_USER); the base image already owns it as user `bun`, so
# the build asserts that instead of adding a second account. /workspace is
# the mount point of the per-session volume; Docker seeds a fresh volume from
# the image path, so the directory must already exist with the worker's
# ownership (image contract).
RUN test "$(id -u bun)" = 1000 && test "$(id -g bun)" = 1000 \
  && mkdir -p /workspace && chown 1000:1000 /workspace
WORKDIR /app
COPY --from=deps --chown=1000:1000 /app /app
# Each installed runtime checks its engine and puts it on PATH (for Claude,
# `claude`, resolved the way the runtime does at run time), so the build fails
# if an engine stops shipping for this arch.
RUN bun run --filter @werft-ai/runtime-registry image:verify
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
