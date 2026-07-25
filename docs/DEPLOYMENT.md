# Deployment

Maestro is designed to run as a single long-lived service on a small VPS. The
canonical target is [Railway](https://railway.app) — one Dockerfile, one
volume, one set of environment variables.

## Self-host with Docker Compose (simplest)

The repo ships a `docker-compose.yml` for running your own instance anywhere
Docker runs:

```bash
cp .env.example .env     # fill DEVELOPER_*, GITHUB_TOKEN, MAESTRO_AUTH_*
# Recommended for a headless box — your own subscription token:
#   claude setup-token   (run locally) → paste into .env as CLAUDE_CODE_OAUTH_TOKEN
docker compose up -d --build
curl http://localhost:3000/api/health     # → {"status":"ok",...}
```

The `maestro-data` volume persists `/data` (SQLite, working clones, Claude
creds) across restarts. `MAESTRO_DATA_DIR` and `CLAUDE_CONFIG_DIR` are pinned to
`/data` by the compose file regardless of `.env`; set `MAESTRO_HOST_PORT` to map
a different host port. The production image sets `NODE_ENV=production`, so auth
must be configured (see below) or the conductor refuses to boot.

The Railway path below remains the canonical hosted target.

## Prerequisites

- A Railway project with a paid plan (the conductor needs to stay up).
- A volume (recommend 5GB) mounted at `/data` for the SQLite database and
  per-project working clones.
- A fine-grained GitHub PAT with read/write on the repos Maestro will manage.
- A Telegram bot token (Phase 4+) and the chat id from `@userinfobot`.
- The Anthropic API key is optional — Maestro spawns the local `claude` CLI
  authenticated to your Pro/Max subscription (see ADR-001 in `DECISIONS.md`).

## First-time setup on Railway

1. **Create a new project** in Railway and point it at this repository.
2. Railway detects the `Dockerfile` automatically. Build and deploy once to
   verify the image builds and the conductor reaches `/api/health`.
3. **Add a volume** with mount path `/data`.
4. **Set environment variables** (copy from `.env.example`):
   - `GITHUB_TOKEN`
   - `TELEGRAM_BOT_TOKEN` (optional in Phase 0)
   - `TELEGRAM_CHAT_ID` (optional in Phase 0)
   - `DEVELOPER_NAME=Aaryan Sinha`
   - `DEVELOPER_EMAIL=<your GitHub email>`
   - `DEVELOPER_GITHUB_USERNAME=aaryansinha16`
   - `MAESTRO_AUTH_USER` + `MAESTRO_AUTH_PASSWORD` (Basic Auth for the
     dashboard — set both before exposing a public domain)
   - Do **not** set `MAESTRO_PORT` — Railway assigns `$PORT` and routes its
     healthcheck to it; the conductor reads `$PORT` when `MAESTRO_PORT` is
     unset. Hardcoding `MAESTRO_PORT` shadows `$PORT` and the healthcheck
     fails. `MAESTRO_DATA_DIR=/data` and `CLAUDE_CONFIG_DIR=/data/claude`
     are already baked into the image.
5. **Public domain**: enable a domain for the service (Railway → Settings →
   Public Networking) with target port `3000`.
6. **Verify**: hit `https://<your-domain>/api/health` and confirm a 200.

## Verifying a deploy

```bash
curl https://maestro.<your-domain>/api/health
# → { "status": "ok", "version": "0.0.0", "uptimeSeconds": 8, ... }
```

The dashboard is served by the conductor itself (Phase 5): every
non-`/api` GET serves the vite build with an index.html SPA fallback.
The Docker image bakes the build at `/app/dashboard`; outside Docker the
conductor looks for `MAESTRO_DASHBOARD_DIR`, then the repo-relative
`packages/dashboard/dist`. Opening `https://maestro.<your-domain>/`
should render the Overview page with no separate dashboard process.

## Git credentials

The conductor authenticates git clone/fetch/push to GitHub **per operation**
with a token URL (`https://x-access-token:$GITHUB_TOKEN@github.com/...`), the
same way GitHub Actions does. So the only requirement — in Docker, on a bare
VPS, or in local dev — is that **`GITHUB_TOKEN` is set** (a fine-grained PAT
with `contents: write` + `pull requests: write`). No git credential helper is
needed or configured, which also sidesteps the Git 2.50 restriction that
blocks the old `!shell` helper.

The token is used only for the individual git command and is never written to
a clone's `.git/config`, so the sandboxed agent running inside a working clone
cannot read it. Without `GITHUB_TOKEN` the worker still commits locally, but
the push fails and the session is marked failed before a PR opens.

## Claude Code bootstrap (one-time per deploy host)

The image ships the Claude Code CLI with `CLAUDE_CONFIG_DIR=/data/claude`,
so OAuth credentials persist on the volume across redeploys (ADR-025).
After the **first** deploy (and again only if the token ever expires):

```bash
railway shell           # opens a shell inside the running service
claude /login           # follow the OAuth URL, paste the code back
claude --version        # sanity check
exit
```

Verify from outside:

```bash
curl https://maestro.<your-domain>/api/health/claude
# → { "installed": true, "version": "…", "authenticated": true, … }
```

The dashboard shows a yellow banner whenever this endpoint reports the
CLI missing or unauthenticated — if you see it, re-run the bootstrap.

**Headless alternative — no interactive shell (SH-02).** Instead of
`claude /login` on the box, run `claude setup-token` on your own machine
and set the resulting ~1-year token as the `CLAUDE_CODE_OAUTH_TOKEN`
service variable. The conductor forwards it to every agent session, so a
headless deploy authenticates with your own subscription without
`railway shell`. This is the recommended path when deploying your own
instance — your token, your box.

**Fallback — plain VPS.** If interactive shell access on Railway breaks,
the same image runs anywhere Docker does (DigitalOcean, Hetzner, a home
server): `docker run -v maestro-data:/data -p 3000:3000 <image>`, then
`docker exec -it <container> claude /login`.

## Updating

```bash
git push origin main
# Railway redeploys automatically.
```

Volume contents (the SQLite DB and any working clones under `/data`) are
preserved across deploys.
