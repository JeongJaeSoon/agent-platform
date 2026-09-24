# syntax=docker/dockerfile:1.7
# Egress proxy image: the only route off every worker network (94S-216), so
# it ships as a released, digest-pinned image like the other apps instead of
# a source tree mounted into a stock Bun image (94S-323). Built from the
# repository root (`docker build -f apps/egress-proxy/Dockerfile .`).
#
# Base pinned by the multi-arch index digest of oven/bun:1.3.10; see
# apps/worker/Dockerfile for why and tests/images.test.ts for the check.
ARG BUN_IMAGE=oven/bun:1.3.10@sha256:b86c67b531d87b4db11470d9b2bd0c519b1976eee6fcd71634e73abfa6230d2e

# One stage and no `bun install`: the proxy imports nothing but Bun and its
# own files. tests/images.test.ts fails once apps/egress-proxy/package.json
# gains a dependency; that is when this grows the deps stage the other apps
# have.
FROM ${BUN_IMAGE}
WORKDIR /app
# Owned by root and only readable by the proxy's user, so a compromised
# proxy cannot rewrite the code the next start runs.
COPY apps/egress-proxy/package.json ./
# The licenses of what this image ships: the Bun base (94S-338).
COPY THIRD_PARTY_NOTICES.md ./
COPY apps/egress-proxy/src ./src
USER 1000:1000
ENV NODE_ENV=production
EXPOSE 3128
CMD ["bun", "run", "src/main.ts"]
