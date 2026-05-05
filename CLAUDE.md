# Granola-Obsidian-Claude Knowledge Base

Automated meeting note pipeline: Granola → Claude (wiki enrichment) → Obsidian vault → Google Drive.

## Stack

- **Runtime**: Node.js 24 + TypeScript (`orchestrator/`)
- **Container**: Docker Compose (single service, `node:24-alpine`)
- **Granola data**: `granola-cli` npm package — reads via Granola's API
- **AI enrichment**: Anthropic SDK with prompt caching (`cache_control: ephemeral` on system prompt)
- **Sync**: rclone to Google Drive

## Directory layout

```
goc-kb/
├── orchestrator/
│   ├── src/
│   │   ├── index.ts      # cron entry point; runs pipeline immediately then on schedule
│   │   ├── ingest.ts     # granola-cli wrapper, state tracking, pipeline orchestration
│   │   ├── process.ts    # Claude API call; returns meetingNote + conceptNotes JSON
│   │   ├── write.ts      # writes meeting notes + concept pages to vault
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
| `GRANOLA_SUPABASE_PATH` | Yes | `~/Library/Application Support/Granola/supabase.json` | Granola auth file |
| `OBSIDIAN_VAULT_PATH` | Yes | — | Absolute path to vault root on host |
| `RCLONE_DEST` | Yes | — | `remote:path` rclone sync target |
| `CRON_SCHEDULE` | No | `0 * * * *` | Cron expression |
| `LOOKBACK_DAYS` | No | `30` | Days of history on first run |
| `MEETINGS_FOLDER` | No | `wiki/meetings` | Vault subfolder for meeting notes |
| `VAULT_PATH` | No | `OBSIDIAN_VAULT_PATH` / `/vault` | Resolved vault path (set by Docker) |
| `STATE_FILE` | No | `../state/state.json` | State file path (set by Docker to `/state/state.json`) |

## Architecture notes

**Granola auth**: `granola-cli` reads credentials from `GRANOLA_SUPABASE_PATH` — the Granola desktop app's Supabase auth file. In Docker, this is mounted to `/root/.config/granola/supabase.json:ro`. `runPipeline` checks the file exists at startup and throws a clear error if missing. No separate auth step needed — the live mount picks up token refreshes automatically.

> Do not reintroduce a SQLite/file-reading path — granola-cli uses Granola's API.

**State tracking**: `state/state.json` stores `{ lastProcessedAt, processedIds[] }`. Written atomically (temp file + rename) after each successful meeting. `processedIds` capped at 500. Delete to reprocess from `LOOKBACK_DAYS` horizon.

**Deduplication**: Two layers — state-based (skip IDs in `processedIds`) and file-based (`existsSync` on meeting note and concept paths). File-based dedup is what prevents re-processing across devices when vault is synced from Google Drive first.

**Claude call** (`process.ts`): Single `messages.create` call per meeting. System prompt (`meeting-note.md`) is cached via `cache_control: ephemeral`. Response must be JSON `{ meetingNote: string, conceptNotes: ConceptNote[] }` — strip optional markdown fences before parsing.

**Vault writes** (`write.ts`): Meeting notes → `$VAULT_PATH/$MEETINGS_FOLDER/<date>-<slug>.md`. Concept pages → `$VAULT_PATH/wiki/concepts/<slug>.md`. Both skip if file already exists. `VAULT_PATH` resolves: `VAULT_PATH` env → `OBSIDIAN_VAULT_PATH` env → `/vault`.

**rclone sync** (`sync.ts`): Runs after all meetings in a batch are written. Skipped if `RCLONE_DEST` unset or dry-run. Syncs `VAULT_PATH` only — `state.json` is not synced.

**Prompt files**: Edit `orchestrator/prompts/meeting-note.md` to tune output format. `concept-note.md` is a format reference only — not loaded by the orchestrator.

## Constraints

- `CLAUDE_MODEL` default is `bedrock.claude-sonnet-4-6` — the API key only allows Bedrock model IDs
- `rclone/rclone.conf`, `.env`, `state/state.json` are never committed
- No hardcoded paths in code — all configurable via env vars
- Vault folder structure follows claude-obsidian conventions: `wiki/meetings/`, `wiki/concepts/` — do not invent new folders
