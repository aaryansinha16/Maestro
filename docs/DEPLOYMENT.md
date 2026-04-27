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
   - `MAESTRO_DATA_DIR=/data`
   - `MAESTRO_PORT=3000`
5. **Public domain**: enable a domain for the service (Railway → Settings →
   Public Networking). The Hono server listens on `MAESTRO_PORT`.
6. **Verify**: hit `https://<your-domain>/api/health` and confirm a 200.

## Authenticating the Claude Code CLI

ADR-001 commits Maestro to using the local `claude` CLI rather than the
Anthropic API. Railway's Docker image deliberately does **not** install
Claude Code — the OAuth flow needs an interactive shell. Two options:

- **Production**: SSH (or use Railway's "Deploy → Shell") into the running
  container with the volume mounted, install Claude Code, run `claude
  /login`, and finish the OAuth flow. Repeat after token expiry.
- **Self-hosted on a VPS** (recommended for the developer's own use): run
  `pnpm install && pnpm build` on the VPS directly, install Claude Code,
  authenticate once, then run the conductor under a process supervisor
  (systemd, pm2, etc.). The Dockerfile is for parity testing and future
  multi-tenant deploys.

## Verifying a deploy

```bash
curl https://maestro.<your-domain>/api/health
# → { "status": "ok", "version": "0.0.0", "uptimeSeconds": 8, ... }
```

The dashboard is served as a static build alongside the conductor in
production. In Phase 0 the static assets are built but not yet wired into
the Hono app (Phase 3 mounts them); for now, run the dashboard locally
against the deployed conductor by exporting `VITE_API_BASE_URL`.

## Updating

```bash
git push origin main
# Railway redeploys automatically.
```

Volume contents (the SQLite DB and any working clones under `/data`) are
preserved across deploys.
