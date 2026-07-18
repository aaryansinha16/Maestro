# Deployment

Maestro is designed to run as a single long-lived service on a small VPS. The
canonical target is [Railway](https://railway.app) — one Dockerfile, one
volume, one set of environment variables.

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

## Git push credentials

The conductor pushes branches over HTTPS. The Docker image ships a
system-wide git credential helper that feeds `GITHUB_TOKEN` from the
environment at push time, so no extra setup is needed on Railway — just
ensure `GITHUB_TOKEN` is set as a service variable.

Running the conductor **outside Docker** (a bare VPS, `pnpm dev`)? The
host's own git credential setup handles auth — on macOS that's the
keychain; on Linux, configure a helper once:

```bash
git config --global credential.helper \
  '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GITHUB_TOKEN"; }; f'
```

Without a helper (and without a token-embedded remote), the worker's
push fails auth and the session is marked failed before a PR opens.

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
