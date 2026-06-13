# Multi-stage Dockerfile for the Maestro conductor.
#
# Stage 1: install all workspace deps and build every package (typescript +
# vite). Stage 2: copy the built artifacts and only the production deps the
# conductor needs at runtime. The image runs the conductor + serves the static
# dashboard from the Hono app's working tree.
#
# git is installed because the conductor runs `simple-git` against managed
# project repos. The Claude Code CLI IS baked into the runtime image
# (ADR-025): OAuth credentials persist on the /data volume via
# CLAUDE_CONFIG_DIR, so a one-time `railway shell` → `claude /login`
# bootstrap survives redeploys. ADR-001 (subscription via CLI, not API)
# still holds — only the install location moved.

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
    MAESTRO_DATA_DIR=/data \
    CLAUDE_CONFIG_DIR=/data/claude

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 maestro \
  && useradd  --system --uid 1001 --gid maestro --create-home maestro

# Claude Code CLI (ADR-025). Version-pinned implicitly by image build
# date; `claude --version` is surfaced at /api/health/claude.
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Conductor runtime artefact (production deps + compiled JS + migrations).
COPY --from=builder --chown=maestro:maestro /prod/conductor /app/conductor

# Dashboard static build, served from inside the conductor process tree.
COPY --from=builder --chown=maestro:maestro /app/packages/dashboard/dist /app/dashboard

RUN mkdir -p /data && chown maestro:maestro /data
USER maestro

EXPOSE 3000

# NB: no Docker `VOLUME` instruction — Railway rejects it ("use Railway
# Volumes"). Persistence at /data is configured via a Railway Volume
# mounted at that path (see docs/DEPLOYMENT.md), which is what actually
# survives redeploys. The VOLUME hint would only matter for a plain
# `docker run` without -v, and there we pass -v explicitly anyway.

ENTRYPOINT ["/usr/bin/tini", "--"]
# mkdir at start, not build: the /data volume mount shadows image-time dirs.
CMD ["/bin/sh", "-c", "mkdir -p \"$CLAUDE_CONFIG_DIR\" && exec node /app/conductor/dist/index.js"]
