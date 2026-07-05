# Granola-Obsidian-Claude Knowledge Base

Manual meeting note pipeline: Granola → (user edits) → Claude (wiki enrichment) → Obsidian vault.

## Stack

- **Runtime**: Node.js 24 + TypeScript
- **Granola data**: Official Granola API (`granola-client.ts`) — `https://public-api.granola.ai` with API key auth
- **AI enrichment**: Anthropic SDK with prompt caching (`cache_control: ephemeral` on system prompt)

## Directory layout

```
goc-kb/
├── src/
│   ├── inbox.ts          # CLI: list un-ingested meetings (JSON stdout)
│   ├── ingest-single.ts  # CLI: ingest one meeting by ID
│   ├── granola-client.ts # Granola public API client
│   ├── process.ts        # Claude API call; extracts entities + concepts
│   ├── write.ts          # writes enriched source files to .raw/transcripts/
│   ├── wiki-ingest.ts    # creates wiki pages from processed data
│   ├── state.ts          # state load/save (stored in vault)
│   └── types.ts          # shared interfaces
├── prompts/
│   ├── meeting-note.md   # system prompt loaded by process.ts
│   └── concept-note.md   # format reference only
├── .claude/skills/
│   └── wiki-inbox/SKILL.md   # /wiki-inbox skill definition
├── package.json
├── tsconfig.json
├── .env                  # never committed
└── .env.example
```

## Workflow

1. Edit meetings in Granola (fix transcription errors, add notes)
2. When ready, start a Claude session in this repo
3. Run `/wiki-inbox` — lists meetings not yet ingested
4. Pick which meetings to ingest
5. Each selected meeting: fetch from Granola → Claude enrichment → write raw source + wiki pages

## Key commands

```bash
npm run inbox                            # list un-ingested meetings (JSON)
npm run inbox -- --no-update             # same, without advancing lastCheckedAt
npm run ingest -- --meeting-id <id>      # ingest one meeting
npm run ingest -- --meeting-id <id> --dry-run  # preview without writes
npm run build                            # tsc compile to dist/
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `ANTHROPIC_BASE_URL` | No | — | Custom base URL (proxy) |
| `CLAUDE_MODEL` | No | `bedrock.claude-sonnet-4-6` | Model ID passed to API |
| `GRANOLA_API_KEY` | Yes | — | Granola API key (`grn_...`), generated in Granola desktop Settings → API |
| `OBSIDIAN_VAULT_PATH` | Yes | — | Absolute path to vault root |
| `LOOKBACK_DAYS` | No | `30` | Days of history on first run |

## Architecture notes

**Granola API**: Uses the official public API with a static API key. Rate limits: 25 req/5s burst, 5 req/s sustained.

**State tracking**: `$OBSIDIAN_VAULT_PATH/.raw/.ingest-state.json` stores `{ lastCheckedAt }`. Represents when meetings were last listed (not ingested). Delete to re-check from `LOOKBACK_DAYS` horizon.

**Deduplication**: File-based — `inbox.ts` checks if `.raw/transcripts/<date>-<slug>.md` exists or is tracked in `.raw/.manifest.json`. Already-ingested meetings are filtered out of the inbox listing.

**Claude call** (`process.ts`): Single `messages.create` call per meeting. System prompt (`meeting-note.md`) is cached via `cache_control: ephemeral`. Response must be JSON `{ meetingNote, conceptNotes[], entities[] }`.

**Wiki-ingest** (`wiki-ingest.ts`): Creates wiki pages from structured data — meeting page (`wiki/meetings/`), source page (`wiki/sources/`), entity pages (`wiki/entities/`), concept pages (`wiki/concepts/`). Updates `wiki/index.md`, `wiki/log.md`, `wiki/hot.md`. Idempotent — skips existing pages, checks manifest hash.

**Prompt files**: Edit `orchestrator/prompts/meeting-note.md` to tune output format.

## Operations

### Regenerating Granola API key

If the API returns 401, generate a new key: Granola desktop → Settings → API → Create key. Update `GRANOLA_API_KEY` in `.env`.

## Constraints

- `CLAUDE_MODEL` default is `bedrock.claude-sonnet-4-6` — the API key only allows Bedrock model IDs
- `.env` is never committed
- No hardcoded paths in code — all configurable via env vars
