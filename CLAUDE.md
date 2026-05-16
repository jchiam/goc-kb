# Granola-Obsidian-Claude Knowledge Base

Automated meeting note pipeline: Granola → Claude (wiki enrichment) → Obsidian vault → Google Drive.

## Stack

- **Runtime**: Node.js 24 + TypeScript (`orchestrator/`)
- **Container**: Docker Compose (single service, `node:24-alpine`)
- **Granola data**: Direct HTTP client (`granola-client.ts`) — calls Granola API with self-managed WorkOS tokens
- **AI enrichment**: Anthropic SDK with prompt caching (`cache_control: ephemeral` on system prompt)
- **Sync**: rclone to Google Drive

## Directory layout

```
goc-kb/
├── orchestrator/
│   ├── src/
│   │   ├── index.ts      # cron entry point; runs pipeline immediately then on schedule
│   │   ├── granola-client.ts  # Granola HTTP API client with token lifecycle
│   │   ├── ingest.ts     # pipeline orchestration, state tracking
│   │   ├── process.ts    # Claude API call; returns meetingNote + conceptNotes JSON
│   │   ├── write.ts      # writes enriched source files to .raw/transcripts/
│   │   ├── sync.ts       # rclone sync vault → RCLONE_DEST
│   │   └── types.ts      # shared interfaces
│   ├── prompts/
│   │   ├── meeting-note.md   # system prompt loaded by process.ts
│   │   └── concept-note.md   # format reference only — not loaded by code
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
├── rclone/rclone.conf    # never committed; copy from ~/.config/rclone/rclone.conf
├── state/state.json      # never committed; auto-created on first run
├── .env                  # never committed
├── .env.example
└── docker-compose.yml
```

## Key commands

```bash
# Docker
docker compose up -d
docker compose logs -f
docker compose down

# Local dev (from orchestrator/)
npm run dev              # run once (--once flag), loads ../.env
npm run dev:watch        # re-run on file changes
npm run ingest           # run as long-lived cron process, loads ../.env
npm run ingest -- --meeting-id <id>   # single meeting (90-day lookback)
npm run ingest -- --dry-run           # no vault writes, no rclone sync
npm run build            # tsc compile to dist/
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `ANTHROPIC_BASE_URL` | No | — | Custom base URL (local Claude / proxy) |
| `CLAUDE_MODEL` | No | `bedrock.claude-sonnet-4-6` | Model ID passed to API |
| `GRANOLA_SUPABASE_PATH` | Yes | `~/Library/Application Support/Granola/supabase.json` | Bootstrap auth file (only needed on first run) |
| `OBSIDIAN_VAULT_PATH` | Yes | — | Absolute path to vault root on host |
| `RCLONE_DEST` | Yes | — | `remote:path` rclone sync target |
| `CRON_SCHEDULE` | No | `0 * * * *` | Cron expression |
| `LOOKBACK_DAYS` | No | `30` | Days of history on first run |
| `VAULT_PATH` | No | `OBSIDIAN_VAULT_PATH` / `/vault` | Resolved vault path (set by Docker) |
| `STATE_FILE` | No | `../state/state.json` | State file path (set by Docker to `/state/state.json`) |

## Architecture notes

**Granola auth**: Direct HTTP client (`granola-client.ts`) calling `https://api.granola.ai`. On first run, bootstraps access/refresh tokens from `GRANOLA_SUPABASE_PATH` (the Granola desktop app's auth file, bind-mounted read-only). Tokens are cached to `state/tokens.json`. On 401, attempts refresh via WorkOS API.

> **Known limitation**: WorkOS token refresh is currently broken — the correct OAuth `client_id` for the refresh endpoint is unknown (neither `client_GranolaMac` nor the JWT `azp` claim work). Access tokens last ~6 hours. After expiry, the pipeline fails until re-bootstrapped.

> No dependency on `granola-cli` npm package. All Granola API calls are direct HTTP.

**State tracking**: `state/state.json` stores `{ lastProcessedAt, processedIds[] }`. Written atomically (temp file + rename) after each successful meeting. `processedIds` capped at 500. Delete to reprocess from `LOOKBACK_DAYS` horizon.

**Deduplication**: Two layers — state-based (skip IDs in `processedIds`) and file-based (`existsSync` on `.raw/transcripts/` source path). File-based dedup prevents re-processing across devices when vault is synced from Google Drive first.

**Claude call** (`process.ts`): Single `messages.create` call per meeting. System prompt (`meeting-note.md`) is cached via `cache_control: ephemeral`. Response must be JSON `{ meetingNote: string, conceptNotes: ConceptNote[] }` — strip optional markdown fences before parsing.

**Raw source writes** (`write.ts`): Enriched meeting notes → `$VAULT_PATH/.raw/transcripts/<date>-<slug>.md`. Each file contains merged frontmatter (title, date, granola_id, attendees, tags, type: meeting-transcript), the enriched meeting body, and extracted concepts as appendix sections. Skipped if file already exists. `VAULT_PATH` resolves: `VAULT_PATH` env → `OBSIDIAN_VAULT_PATH` env → `/vault`.

**Wiki-ingest integration**: The orchestrator writes to `.raw/transcripts/` only. The `claude-obsidian:wiki-ingest` skill processes these source files into full wiki pages (`wiki/sources/`, `wiki/entities/`, `wiki/concepts/`), updates `index.md`, `log.md`, `hot.md`, and handles cross-referencing. Trigger wiki-ingest manually after orchestrator runs, or set up a durable Claude Code cron (7-day auto-expiry).

**rclone sync** (`sync.ts`): Runs after all meetings in a batch are written. Skipped if `RCLONE_DEST` unset or dry-run. Syncs `VAULT_PATH` only — `state.json` is not synced.

**Prompt files**: Edit `orchestrator/prompts/meeting-note.md` to tune output format. `concept-note.md` is a format reference only — not loaded by the orchestrator.

## Operations

### Re-bootstrapping Granola auth (when pipeline fails with "Token refresh failed" or 401)

1. Open Granola desktop app (refreshes `supabase.json` with a fresh access token)
2. Wait for next cron tick (or restart container: `docker compose restart orchestrator`)

That's it — `rebootstrapIfFresher()` in `granola-client.ts` automatically detects the fresher token in `supabase.json` and replaces the cached one. No need to manually delete `state/tokens.json`.

The fresh token lasts ~6 hours. With `CRON_SCHEDULE=0 * * * *` (hourly), this covers ~6 pipeline runs per bootstrap.

### Wiki-ingest cron (re-setup every 7 days)

A durable Claude Code cron checks `.raw/transcripts/` hourly at :17 for new files and runs `claude-obsidian:wiki-ingest` on them. The cron is self-renewing — it reads `.claude/scheduled_tasks.json` each firing and re-creates itself before the 7-day auto-expiry. If it somehow lapses, ask Claude Code: "Set up the wiki-ingest cron again."

### Extending token lifetime (future fix)

The blocker is finding the correct WorkOS OAuth `client_id` for the refresh endpoint. Candidates tried and rejected:
- `client_GranolaMac` (granola-cli default) → "Invalid client id"
- `client_01JZJ0XBDAT8PHJWQY09Y0VD61` (JWT `azp` claim) → "Invalid client id"

To investigate: check the Granola desktop app bundle (`/Applications/Granola.app/Contents/Resources/`) for a hardcoded WorkOS client_id, or intercept the desktop app's refresh calls via a proxy.

## Constraints

- `CLAUDE_MODEL` default is `bedrock.claude-sonnet-4-6` — the API key only allows Bedrock model IDs
- `rclone/rclone.conf`, `.env`, `state/state.json`, `state/tokens.json` are never committed
- No hardcoded paths in code — all configurable via env vars
- Orchestrator outputs to `.raw/transcripts/` only — wiki pages are created by `claude-obsidian:wiki-ingest`, not the orchestrator
