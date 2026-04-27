# Multi-stage Dockerfile for the Maestro conductor.
#
# Stage 1: install all workspace deps and build every package (typescript +
# vite). Stage 2: copy the built artifacts and only the production deps the
# conductor needs at runtime. The image runs the conductor + serves the static
# dashboard from the Hono app's working tree.
#
# git is installed because future phases run `simple-git` against managed
# project repos. The Claude Code CLI is intentionally NOT baked into this
# image — it must be installed and OAuth'd interactively on the host, per
# ADR-001.

# ─── builder ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.8.1 --activate

WORKDIR /app

# Copy lockfile and manifests first for better layer caching.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY tsconfig.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/conductor/package.json packages/conductor/
COPY packages/dashboard/package.json packages/dashboard/

RUN pnpm install --frozen-lockfile=false

# Now copy the rest of the source and build.
COPY . .
RUN pnpm build

# Prune to production deps for the conductor only. --legacy keeps the v9
# behaviour of producing a self-contained, non-injected deploy directory.
RUN pnpm --filter @maestro/conductor deploy --legacy --prod /prod/conductor

# ─── runtime ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    MAESTRO_PORT=3000 \
    MAESTRO_DATA_DIR=/data

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 maestro \
  && useradd  --system --uid 1001 --gid maestro --create-home maestro

WORKDIR /app

# Conductor runtime artefact (production deps + compiled JS + migrations).
COPY --from=builder --chown=maestro:maestro /prod/conductor /app/conductor

# Dashboard static build, served from inside the conductor process tree.
COPY --from=builder --chown=maestro:maestro /app/packages/dashboard/dist /app/dashboard

RUN mkdir -p /data && chown maestro:maestro /data
USER maestro

EXPOSE 3000
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/conductor/dist/index.js"]
