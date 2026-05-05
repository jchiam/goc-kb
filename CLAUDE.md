# Granola-Obsidian-Claude Knowledge Base

Automated meeting note pipeline: Granola → Claude (wiki enrichment) → Obsidian vault → Google Drive.

## Stack

- **Runtime**: Node.js 24 + TypeScript (orchestrator)
- **Container**: Docker Compose (single service)
- **Granola data**: `granola-cli` npm package — reads via Granola's API, not SQLite
- **AI enrichment**: Anthropic SDK + claude-obsidian wiki pattern
- **Sync**: rclone to Google Drive

## Directory layout

```
goc-kb/
├── orchestrator/
│   ├── src/
│   │   ├── index.ts          # cron entry point
│   │   ├── ingest.ts         # granola-cli wrapper + state tracking
│   │   ├── process.ts        # Claude API calls
│   │   └── write.ts          # markdown formatter + vault writer
│   └── prompts/
│       ├── meeting-note.md   # system prompt: transcript → meeting wiki note
│       └── concept-note.md   # system prompt: extract → new concept page
├── rclone/
│   └── rclone.conf           # generated once via `rclone config` on host
├── state/
│   └── state.json            # tracks last processed meeting ID + timestamp
├── .env                      # secrets + paths (never commit)
├── .env.example              # committed template
└── docker-compose.yml
```

## Key commands

```bash
docker compose up -d          # start pipeline
docker compose logs -f        # watch logs
docker compose down           # stop

cd orchestrator && npm run dev         # run once, no Docker
cd orchestrator && npm run dev:watch   # watch mode
cd orchestrator && npm run ingest -- --meeting-id <id>   # single meeting
cd orchestrator && npm run ingest -- --dry-run           # no vault writes
```

## Architecture notes

**granola-cli authentication**: The CLI reads credentials from `~/Library/Application Support/Granola/supabase.json` on macOS — this is the Granola desktop app's Supabase auth file. The Docker container mounts this file to `/root/.config/granola/supabase.json:ro` (the Linux XDG path the CLI checks when no system keychain is present). No separate `granola-cli auth login` step is required inside the container. The path is user-configurable via `GRANOLA_SUPABASE_PATH` in `.env`.

> Note: The original architecture proposal claimed granola-cli reads from a local SQLite DB. This is incorrect — it uses Granola's API. Do not reintroduce the SQLite mounting approach.

**State tracking**: `state/state.json` records the last processed meeting ID and timestamp. Delete this file to reprocess from the `LOOKBACK_DAYS` horizon. The orchestrator reads state at startup and writes it atomically after each successful batch.

**rclone sync**: Runs as a post-step after vault writes complete. Config in `rclone/rclone.conf` — mounted read-only. Remote must be named `gdrive` (or match `RCLONE_DEST` env var prefix). User is on streaming Google Drive (not mirrored), so rclone is the only reliable sync path.

**claude-obsidian vault structure**: User has an existing vault with the default claude-obsidian layout. Meeting notes go in `wiki/meetings/`. Entity and concept pages follow existing vault conventions — do not invent new folder structures.

**Prompt files**: `orchestrator/prompts/` contains the system prompts. Edit these to tune output format without touching orchestration code.

## Constraints

- Do not add a `granola-cli` SQLite/file-reading path — the API approach is correct
- `rclone/rclone.conf` and `.env` are never committed (in `.gitignore`)
- `state/state.json` is volume-mounted, not baked into the image
- Vault path on host is user-configurable via `OBSIDIAN_VAULT_PATH` — no hardcoded paths in code
- Claude model: default to `claude-sonnet-4-6` unless the user specifies otherwise
