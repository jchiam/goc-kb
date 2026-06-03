# Granola-Obsidian-Claude Knowledge Base

Automated meeting note pipeline: Granola → Claude (wiki enrichment) → Obsidian vault → Google Drive.

## Stack

- **Runtime**: Node.js 24 + TypeScript (`orchestrator/`)
- **Container**: Docker Compose (single service, `node:24-alpine`)
- **Granola data**: Official Granola API (`granola-client.ts`) — `https://public-api.granola.ai` with API key auth
- **AI enrichment**: Anthropic SDK with prompt caching (`cache_control: ephemeral` on system prompt)
- **Sync**: rclone to Google Drive

## Directory layout

```
goc-kb/
├── orchestrator/
│   ├── src/
│   │   ├── index.ts      # cron entry point; runs pipeline immediately then on schedule
│   │   ├── granola-client.ts  # Granola public API client (API key auth)
│   │   ├── ingest.ts     # pipeline orchestration, state tracking
│   │   ├── process.ts    # Claude API call; returns meetingNote + conceptNotes + entities JSON
│   │   ├── write.ts      # writes enriched source files to .raw/transcripts/
│   │   ├── wiki-ingest.ts # creates wiki pages inline from processed data
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
| `GRANOLA_API_KEY` | Yes | — | Granola API key (`grn_...`), generated in Granola desktop Settings → API |
| `OBSIDIAN_VAULT_PATH` | Yes | — | Absolute path to vault root on host |
| `RCLONE_DEST` | Yes | — | `remote:path` rclone sync target |
| `CRON_SCHEDULE` | No | `0 * * * *` | Cron expression |
| `LOOKBACK_DAYS` | No | `30` | Days of history on first run |
| `VAULT_PATH` | No | `OBSIDIAN_VAULT_PATH` / `/vault` | Resolved vault path (set by Docker) |
| `STATE_FILE` | No | `../state/state.json` | State file path (set by Docker to `/state/state.json`) |

## Architecture notes

**Granola API**: Uses the official public API at `https://public-api.granola.ai` with a static API key (`GRANOLA_API_KEY`). No token lifecycle, no refresh, no expiry concerns. Key is generated in Granola desktop Settings → API and does not expire (revocable anytime). Rate limits: 25 req/5s burst, 5 req/s sustained.

**State tracking**: `state/state.json` stores `{ lastProcessedAt, processedIds[] }`. Written atomically (temp file + rename) after each successful meeting. `processedIds` capped at 500. Delete to reprocess from `LOOKBACK_DAYS` horizon.

**Deduplication**: Two layers — state-based (skip IDs in `processedIds`) and file-based (`existsSync` on `.raw/transcripts/` source path). File-based dedup prevents re-processing across devices when vault is synced from Google Drive first.

**Claude call** (`process.ts`): Single `messages.create` call per meeting. System prompt (`meeting-note.md`) is cached via `cache_control: ephemeral`. Response must be JSON `{ meetingNote: string, conceptNotes: ConceptNote[] }` — strip optional markdown fences before parsing.

**Raw source writes** (`write.ts`): Enriched meeting notes → `$VAULT_PATH/.raw/transcripts/<date>-<slug>.md`. Each file contains merged frontmatter (title, date, granola_id, attendees, tags, type: meeting-transcript), the enriched meeting body, and extracted concepts as appendix sections. Skipped if file already exists. `VAULT_PATH` resolves: `VAULT_PATH` env → `OBSIDIAN_VAULT_PATH` env → `/vault`.

**Wiki-ingest** (`wiki-ingest.ts`): Runs inline after `write.ts`. Creates wiki pages from the structured data already extracted by `process.ts` — source summary (`wiki/sources/`), entity pages (`wiki/entities/`), concept pages (`wiki/concepts/`). Updates `wiki/index.md`, `wiki/log.md`, `wiki/hot.md`, and `.raw/.manifest.json`. Non-blocking — failures don't stop the pipeline. Idempotent — skips pages that already exist, checks manifest hash to avoid re-ingesting unchanged sources. If DragonScale is active (`.vault-meta/` + `scripts/allocate-address.sh` exist), assigns stable addresses to new pages.

**rclone sync** (`sync.ts`): Runs after all meetings in a batch are written. Skipped if `RCLONE_DEST` unset or dry-run. Syncs `VAULT_PATH` only — `state.json` is not synced.

**Prompt files**: Edit `orchestrator/prompts/meeting-note.md` to tune output format. `concept-note.md` is a format reference only — not loaded by the orchestrator.

## Operations

### Regenerating Granola API key

If the API returns 401, the key was likely revoked. Generate a new one: Granola desktop → Settings → API → Create key. Update `GRANOLA_API_KEY` in `.env` and restart container.


## Constraints

- `CLAUDE_MODEL` default is `bedrock.claude-sonnet-4-6` — the API key only allows Bedrock model IDs
- `rclone/rclone.conf`, `.env`, `state/state.json` are never committed
- No hardcoded paths in code — all configurable via env vars
- Orchestrator creates wiki pages inline via `wiki-ingest.ts` — no external Claude Code session needed
