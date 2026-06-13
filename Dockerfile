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

# NB: no MAESTRO_PORT here. Hardcoding it would shadow the platform's
# $PORT (Railway assigns one and routes the healthcheck + public traffic
# to it). config.ts reads MAESTRO_PORT ?? PORT ?? default, so leaving it
# unset lets $PORT win on the host and falls back to 3000 otherwise.
ENV NODE_ENV=production \
    MAESTRO_DATA_DIR=/data \
    CLAUDE_CONFIG_DIR=/data/claude

# gosu lets the entrypoint drop from root → maestro after fixing volume
# ownership at runtime (see docker-entrypoint.sh).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git tini gosu \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 maestro \
  && useradd  --system --uid 1001 --gid maestro --create-home maestro

# Claude Code CLI (ADR-025). Version-pinned implicitly by image build
# date; `claude --version` is surfaced at /api/health/claude.
RUN npm install -g @anthropic-ai/claude-code

# System-wide git credential helper so the worker can push over HTTPS on a
# headless host. It feeds GITHUB_TOKEN from the environment at push time —
# the token is never written to disk, baked into the image, or placed in a
# remote URL. Only processes whose env carries GITHUB_TOKEN (the conductor)
# get a usable credential; a process without it (a sandboxed agent) gets an
# empty password and cannot push. Responds only to `get` so store/erase are
# no-ops.
RUN git config --system credential.helper \
  '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GITHUB_TOKEN"; }; f'

WORKDIR /app

# Conductor runtime artefact (production deps + compiled JS + migrations).
COPY --from=builder --chown=maestro:maestro /prod/conductor /app/conductor

# Dashboard static build, served from inside the conductor process tree.
COPY --from=builder --chown=maestro:maestro /app/packages/dashboard/dist /app/dashboard

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data

EXPOSE 3000

# NB: no Docker `VOLUME` instruction — Railway rejects it ("use Railway
# Volumes"). Persistence at /data comes from a Railway Volume mounted
# there (docs/DEPLOYMENT.md), or `docker run -v` locally.
#
# We deliberately do NOT set `USER maestro`: the entrypoint starts as
# root to chown the runtime-mounted /data volume, then drops to maestro
# via gosu before exec'ing node. Net effect — the conductor process runs
# unprivileged (CLAUDE.md security boundary) while still being able to
# write the volume Railway hands us root-owned.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "/app/conductor/dist/index.js"]
