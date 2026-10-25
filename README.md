# 9Router V3

> A self-hosted AI gateway: one endpoint, many providers, automatic fallback.

**9Router V3** is a downstream fork maintained by **codestorm**, focused on portable deployment, persistent storage, secure configuration, and a reliable dashboard experience.

Project lineage:

1. [decolua/9router](https://github.com/decolua/9router) — original routing engine and provider integrations.
2. [ahwanulm/9router-v2](https://github.com/ahwanulm/9router-v2) — Express backend + Vite/React frontend rewrite.
3. **9Router V3 by codestorm** — portable deployment, persistent storage, dashboard reliability.

## Features

- **OpenAI-compatible REST API** — chat, images, audio (TTS/STT), embeddings, web search: `GET /api/health`, `GET /v1/models`, `POST /v1/chat/completions`, and more.
- **Multi-provider routing** with fallback, key rotation, and per-model cooldowns.
- **Model discovery** — live per-connection model lists (OpenAI/Anthropic-shaped, OAuth, paginated where supported), static catalogs, custom models, and aliases. Sync jobs persist discoveries without truncating lists.
- **Model testing** — single-test buttons (concurrent, per-model state), batched **Test All** with configurable concurrency (1–10) and automatic chunking past 200 models, persisted pass/fail results.
- **Working / Error / Hidden / Disabled filters** — working means *latest test passed, not hidden, not blocked* (shared definition, backend + frontend).
- **Playground** — searchable provider/model pickers, working-models mode across providers, manual model-ID entry, streaming chat with per-message model attribution.
- **Combos** — named multi-model fallback chains; disabled members are skipped explicitly, never silently substituted.
- **SQLite or PostgreSQL** — `DATABASE_URL` selects PostgreSQL; otherwise SQLite. Migrations run automatically on boot, additive only.
- **One-command startup** (`./start.sh`, `start.bat`) with optional public **Cloudflare Quick Tunnel** URL.
- **Production Docker** — multi-stage image, non-root user, healthcheck, Compose file.

## Supported providers and model discovery

Providers are configured in code (`backend/open-sse/config/providers.js`, `frontend/src/shared/config/providerModels.js`) plus dashboard connections (OAuth / API key / cookies, stored in the DB).

| Provider kind | Examples | Model list source |
|---|---|---|
| OAuth coding tools | Gemini CLI, Codex, Kiro, Qoder, Cursor, Copilot | Live upstream `models` endpoints with token refresh |
| API-key gateways | OpenRouter, DeepSeek, Groq, xAI, NVIDIA NIM, OpenCode Zen | Live OpenAI-shaped `/models` (+ static catalog fallback) |
| No-auth free tier | OpenCode Free | Public Zen `/v1/models` (+ curated static list) |
| Custom nodes | OpenAI/Anthropic-compatible base URLs | Live `<baseUrl>/models` |

The Models page merges static catalog + custom models + aliases, dedupes by `alias/model`, and never truncates. The shared working definition lives in `backend/src/lib/models/eligibility.js` (`getWorkingModels`, `GET /api/models/working`) mirrored by `frontend/src/shared/utils/modelEligibility.js`.

## Model testing and working-model filters

- **Single test** (`POST /api/models/test`): one ping per model; the UI runs independent tests concurrently with per-model spinners and duplicate guards.
- **Test All** (`POST /api/models/test-batch`): job-based, SSE + polling progress, concurrency configurable (default 4, max 10), lists over 200 models run as sequential chunks. Tests only the currently filtered, visible, eligible models — the button shows the exact count.
- Results persist (`modelTestResults` KV: `passed|failed|timeout`, latency, error, `testedAt`) and survive reloads. Retries happen only for timeout/network errors; failures never stop unrelated tests.
- **Working** = latest test `passed` AND not hidden AND not blocked. Use the Models-page Working filter, Playground working mode, or `GET /api/models/working`.

## Playground and Combos

- **Playground** (`/dashboard/playground`): pick any configured provider/model (searchable), or enter a raw model ID. Requests go through the normal `/v1/chat/completions` routing with the exact shown `alias/model` string; every assistant reply is stamped `via <model>`.
- **Combos** (`/dashboard/combos`): ordered model lists with fallback or round-robin strategy. Disabled members are excluded before execution; a combo with no eligible models returns a clear error.

## SQLite and PostgreSQL support

- Default: SQLite at `${DATA_DIR}/db/data.sqlite` (dev default `~/.9router-v3`, Docker default `/data`).
- Set `DATABASE_URL=postgresql://USER:PASS@HOST:5432/9router` to use PostgreSQL for **all** application data. If PostgreSQL is unreachable, the server fails fast with an actionable error — it never silently falls back to SQLite.
- Migrations are automatic and additive on every boot (versioned migrations + schema sync). No manual migration command exists or is needed. Back up SQLite via the file, PostgreSQL via provider backups/`pg_dump`.

## Quick start (this installation)

```bash
cd myrouter
./start.sh --public
```

The script installs dependencies if needed, starts the backend and frontend, and prints a temporary public Cloudflare URL. Dashboard login password: `admin123` (configured via `INITIAL_PASSWORD` in `backend/.env`; change it there and restart to update).

## Prerequisites

- Node.js 20+ and npm (no other runtime needed for local use)
- Docker 24+ (only for container deployment)
- A `cloudflared` binary is auto-downloaded by `start.sh --public` when missing

## Environment variable configuration

```bash
cp backend/.env.example backend/.env   # then edit INITIAL_PASSWORD + secrets
```

Key variables (`backend/.env.example` documents all):

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `INITIAL_PASSWORD` | first boot | — | Dashboard password until changed in-app |
| `PORT` | no | `3001` | Backend listen port (PaaS injects it) |
| `DATA_DIR` | no | `~/.9router-v3` (dev) / `/data` (Docker) | SQLite dir, logs, runtime files |
| `JWT_SECRET` / `API_KEY_SECRET` | recommended | auto-generated into `DATA_DIR` | Session/API-key signing |
| `DATABASE_URL` | no | — | Enables PostgreSQL when set |
| `AUTH_COOKIE_SECURE` | no | `false` | `true` only when serving HTTPS directly |
| `REQUIRE_API_KEY` | no | `false` | Require API key for `/v1` traffic |

> Note: plain `npm run dev` does **not** read `backend/.env` (no dotenv loader) and falls back to `~/.9router-v3`. `./start.sh` and Docker export it explicitly so local, container, and production behavior match.

## Running without a startup script

```bash
git clone <repo> 9router-v3 && cd 9router-v3
npm install --no-audit --no-fund
cp backend/.env.example backend/.env   # set INITIAL_PASSWORD

# Backend + frontend together:
npm run dev
# ...or individually:
npm run backend     # http://localhost:3001
npm run frontend    # http://localhost:5177
```

Production-mode local run: `npm run build && npm start` (serves API + built dashboard on `PORT`).

Windows (PowerShell/CMD): same commands work with Node.js installed; or run `start.bat` for the guided version.

## Running with the startup script

```bash
./start.sh            # checks node/npm, installs if missing, guards ports,
                      # exports backend/.env, boots backend+frontend, waits for health
./start.sh --public   # additionally prints a public Cloudflare tunnel URL
./start.sh --no-install  # fail instead of npm-installing
```

Stop with `Ctrl+C` (children are cleaned up). The script refuses to start when ports are busy and never overwrites `.env` files or databases.

## Optional Cloudflare public URL setup

`./start.sh --public` starts a **Cloudflare Quick Tunnel** to the local dashboard and prints the generated `https://<name>.trycloudflare.com` URL **only after the tunnel is actually created**. No account, no port forwarding, local port stays private. The URL is **temporary** (changes every restart), not a production host; the tunnel and app shut down together on `Ctrl+C`. Manual equivalent: `cloudflared tunnel --url http://localhost:5177`.

## Docker build and run instructions

```bash
docker build -t 9router-v3 .
docker run -d --name 9router --env-file .env -p 3001:3001 \
  -v 9router-data:/data --restart unless-stopped 9router-v3
# or: docker compose up -d --build
curl http://localhost:3001/api/health   # {"status":"ok",...}
```

The image is multi-stage (`node:22-alpine`), production-only deps, non-root `appuser`, `HEALTHCHECK` on `/api/health`, binds `0.0.0.0`, respects `PORT`. No secrets are baked in. See `DEPLOYMENT.md` for details.

## Railway deployment

Repo service → Dockerfile detected via `railway.toml`. Set Variables from `.env.example` (`PORT` auto-injected), attach a Volume at `/data` **or** a PostgreSQL plugin with its `DATABASE_URL`, generate a domain under Networking. Healthcheck path `/api/health` is preconfigured. Logs/redeploy under Deployments.

## Render deployment

Docker web service from the repo, env vars from `.env.example` (leave injected `PORT`), health check `/api/health`. Mount a disk at `/data` (paid) or attach Render PostgreSQL + `DATABASE_URL` (recommended). Logs tab for output, Manual Deploy for redeploys, automatic restarts on crash.

## VPS deployment

Install Docker (`curl -fsSL https://get.docker.com | sh`), clone, `cp .env.example .env` (fill secrets), `docker compose up -d --build`, verify `/api/health`. Put Nginx/Caddy in front for HTTPS (proxy `127.0.0.1:3001`, disable buffering for SSE, 300s timeouts), `restart: unless-stopped` is already in compose. Full proxy sample in `DEPLOYMENT.md`.

## Database initialization and migrations

Automatic on boot for both dialects; nothing to run manually. SQLite file appears at `${DATA_DIR}/db/data.sqlite` on first DB touch. PostgreSQL schema syncs inside one transaction at connect. Moving SQLite→PostgreSQL: export from the dashboard first, set `DATABASE_URL`, restart, import — the stores don't auto-sync.

## Updating and upgrading the project

```bash
git pull
npm install --no-audit --no-fund   # local
# docker:
docker compose up -d --build
```

Migrations are additive; downgrades unsupported — restore from backup to roll back.

## Frontend performance notes

A few constraints are load-bearing — changing them reintroduces the slow first
paint and slow tab switching this setup was tuned to avoid.

**Icon font.** `frontend/public/fonts/` holds two *static, subset* instances of
Material Symbols (272 KB outlined + 332 KB filled) instead of one 3.96 MB
variable file. The subset covers exactly the icon names used in `frontend/src`.
If you add an icon name, verify it is present, otherwise it will render as
literal text:

```bash
nix-shell -p python3Packages.fonttools python3Packages.brotli --run \
  "python3 -c \"from fontTools.ttLib import TTFont; f=TTFont('frontend/public/fonts/material-symbols-outlined.woff2'); print(len(f.getGlyphOrder()))\""
```

Both faces use `font-display: swap` deliberately. Do **not** switch to `block`:
`block` holds icons invisible for 3s and then paints the ligature name
("progress_activity") in the fallback face at full text size, which is how icon
names previously appeared as oversized words.

**Request cache.** `frontend/src/shared/utils/cachedJson.js` provides a short-TTL
GET cache with in-flight deduplication. Pages must invalidate on mutation —
`invalidateCache("/api/settings")` after a write, `refresh({ force: true })` to
bypass the cache. Read-modify-write flows must pass `force: true` when reading
so they cannot clobber a concurrent update with a stale snapshot. Plain
`fetch(..., { cache: "no-store" })` on a GET defeats this and is the reason tab
switches used to refire a dozen requests.

**Suspense boundary.** The boundary lives in `DashboardLayout`, around the
`<Outlet>` only. Do not wrap the whole router in `Suspense`, or a lazy chunk
loading will unmount the sidebar and header and flash a full-screen fallback.

**Static asset caching.** `backend/src/server.ts` sets `immutable` +
`max-age=31536000` on content-hashed `/assets/*`, one week on fonts, and
`max-age=0, must-revalidate` on `index.html`. Express defaults to `max-age=0`,
which forces a full re-download of every chunk and the icon font on each load.

**Outbound timeouts.** Provider calls go through
`backend/src/lib/net/fetchWithTimeout.js` (default 15s) so a stalled upstream
degrades to an error instead of holding a dashboard request open forever.

## Backup and restore guidance

SQLite: `docker cp 9router:/data/db/data.sqlite ./backup-$(date +%F).sqlite` (or copy the volume). PostgreSQL: provider snapshots + `pg_dump`. Keep 7+ daily copies; always back up before upgrades; test restores.

## Troubleshooting common errors

| Symptom | Fix |
|---|---|
| Port busy on `./start.sh` | Stop the other instance first (script refuses duplicates by design) |
| Login loops | Set `INITIAL_PASSWORD` in `backend/.env` and restart |
| Data "gone" | Check which `DATA_DIR` is active: `backend/.env` (script/Docker) vs `~/.9router-v3` (bare `npm run dev`) |
| `/api/health` fails | Backend down — read terminal/Docker logs |
| Model 401/403/429 | Provider credential/quota issue — reconnect in dashboard; app is fine |
| PG boot error | Fix `DATABASE_URL` or unset it for SQLite (fail-fast by design) |
| Tunnel URL never prints | `start.sh` only prints after creation; check network egress to Cloudflare |

## Development and contribution instructions

- Backend: `npm run backend` (tsx watch, `backend/src/server.ts`). Frontend: `npm run frontend` (Vite, `frontend/src`).
- Path alias `@/` maps to `src/` in each workspace (backend resolves via `bin/alias-loader.mjs`, cwd must be `backend/`).
- DB access only through `backend/src/lib/db` (`getAdapter()`); never open SQLite directly. KV scopes for simple records; repos for tables.
- Chat routing: `backend/src/sse/handlers/chat.js` → `open-sse/handlers/chatCore.js` → provider executors. Model util rules live in `backend/src/lib/models/eligibility.js` + `frontend/src/shared/utils/modelEligibility.js` — keep them in sync.
- Run `npm run build` (tsc + vite) before submitting; keep UI to existing theme tokens/components.

## Donate

If this fork helps your work: [PayPal — paypal.me/selaris](https://www.paypal.com/paypalme/selaris)

## License and Attribution

MIT — see [`LICENSE`](./LICENSE). Routing engine: [decolua/9router](https://github.com/decolua/9router); V2 rewrite: [ahwanulm/9router-v2](https://github.com/ahwanulm/9router-v2); V3 continuation: **codestorm**.
