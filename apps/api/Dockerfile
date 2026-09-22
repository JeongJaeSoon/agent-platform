# syntax=docker/dockerfile:1.7
# API image: the sessions API (`apps/api`) and the reconciler one-shot
# (`apps/reconciler`) share it, both without the Agent SDK or the Claude Code
# executable (docs/DESIGN.md §9.2–9.3). Built from the repository root
# (`docker build -f apps/api/Dockerfile .`). Becomes the control-host image
# with 94S-117 by changing the paths below.
#
# Base pinned by the multi-arch index digest of oven/bun:1.3.10; see
# apps/worker/Dockerfile for why and tests/images.test.ts for the check.
ARG BUN_IMAGE=oven/bun:1.3.10@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
# --filter limits the install to the two apps this image runs, which is what
# keeps @anthropic-ai/* out of it; the lockfile stays frozen either way.
RUN bun install --frozen-lockfile --production \
    --filter ./apps/api --filter ./apps/reconciler \
  && test ! -e node_modules/@anthropic-ai

FROM ${BUN_IMAGE} AS runtime
# The base image ships a non-root `bun` user as 1000:1000; the API runs as it.
RUN test "$(id -u bun)" = 1000
WORKDIR /app
COPY --from=deps --chown=1000:1000 /app /app
USER 1000:1000
ENV NODE_ENV=production
EXPOSE 3000
# Reconciler: `docker run <image> bun run apps/reconciler/src/main.ts`.
CMD ["bun", "run", "apps/api/src/server.ts"]
