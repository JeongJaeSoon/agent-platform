# syntax=docker/dockerfile:1.7
# Scheduler image: one scheduling pass per process (`apps/scheduler`). It
# talks to the Docker Engine API over the mounted socket directly, so no
# docker CLI is installed. Built from the repository root
# (`docker build -f apps/scheduler/Dockerfile .`).
#
# Base pinned by the multi-arch index digest of oven/bun:1.3.10; see
# apps/worker/Dockerfile for why and tests/images.test.ts for the check.
ARG BUN_IMAGE=oven/bun:1.3.10@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile --production --filter ./apps/scheduler \
  && test ! -e node_modules/@anthropic-ai

FROM ${BUN_IMAGE} AS runtime
WORKDIR /app
COPY --from=deps /app /app
ENV NODE_ENV=production
# Runs as root on purpose: the process owns the Docker socket, and whoever
# holds that socket is root on the daemon host anyway. The socket's group id
# differs per daemon (Desktop, colima, Linux), so a fixed non-root uid would
# only work on some of them while buying no isolation on any.
USER 0:0
CMD ["bun", "run", "apps/scheduler/src/main.ts"]
