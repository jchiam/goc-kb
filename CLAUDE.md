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
│   ├── write.ts          # writes verbatim Granola source files to .raw/transcripts/
│   ├── wiki-ingest.ts    # creates wiki pages from processed data
│   ├── vault.ts          # existing-page roster + entity path resolution
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
npm run inbox                            # list new + edited-since-ingest meetings (JSON)
npm run inbox -- --no-update             # same, without advancing lastCheckedAt
npm run ingest -- --meeting-id <id>      # ingest one meeting
npm run ingest -- --meeting-id <id> --refresh  # re-fetch raw source only (no LLM, no wiki writes)
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
| `VAULT_OWNER` | Yes | — | Full name of the vault owner (matches their person page title) |
| `VAULT_OWNER_ALIASES` | No | — | Comma-separated names the transcript may use for the owner |
| `LOOKBACK_DAYS` | No | `30` | Days of history on first run |

## Architecture notes

**Granola API**: Uses the official public API with a static API key. Rate limits: 25 req/5s burst, 5 req/s sustained.

**State tracking**: `$OBSIDIAN_VAULT_PATH/.raw/.ingest-state.json` stores `{ lastCheckedAt }`. Represents when meetings were last listed (not ingested). Delete to re-check from `LOOKBACK_DAYS` horizon.

**Granola fields**: `private_notes_markdown` (user's typed notes), `summary_markdown` (AI summary incl. user edits; authoritative for names/terms), `transcript` (raw speech-to-text, often mishears names). There is no `content_markdown`.

**Raw source** (`write.ts`): Granola content verbatim (private notes, summary, transcript) with `granola_updated_at` in frontmatter. Not LLM output, so `--refresh` can rewrite it without an LLM call.

**Deduplication**: File-based — `inbox.ts` lists notes with `updated_after: lastCheckedAt`. A note whose `.raw/transcripts/<date>-<slug>.md` doesn't exist (and isn't in `.raw/.manifest.json`) is `new`. An ingested note whose Granola `updated_at` is newer than the raw file's `granola_updated_at` is `updated`. `--refresh` rewrites the raw file and re-records its manifest hash so a later ingest still skips it.

**Claude call** (`process.ts`): Single `messages.create` call per meeting. Two cached system blocks: the prompt (`meeting-note.md`) and the existing-page roster. Input carries the vault owner and Granola's attendee list. Response must be JSON `{ meetingNote, conceptNotes[], entities[], inferences[] }`.

**Attribution guardrails**: transcripts have no speaker labels, so the LLM must not attribute statements, reporting lines, or handover direction from the transcript alone; action items without a Notes/Summary owner are written `(owner?)`; anything inferred goes in `inferences`. Attendees are taken from Granola (resolved to page titles via title/alias, deduped), never from the LLM; when Granola only has the owner the page gets `attendees_verified: false`.

**Review list**: `IngestResult.needsReview` collects unverified attendees, invitees the transcript suggests were absent (`absentInvitees`), `(owner?)` actions, named owners whose `ownerCitations` quote is not found in Notes/Summary, up to 5 LLM `inferences` (reporting lines, attendance, owners only), and ambiguous first-name mentions (a `mention` matching 2+ person pages, e.g. "Darren"; that entity update is held unless the chosen person's full name appears in Notes, Summary, or Granola attendees). Also logged to `wiki/log.md`. The Summary is treated as partly AI-written: claims about the vault owner's own reporting line, transfer, or promotion are written neutrally and always go to review.

**Dry runs** skip the manifest check (they write nothing), so already-ingested meetings can be re-run to test prompt changes; the output includes the LLM JSON under `llm`.

**Meeting slugs**: `meetingSlugFor()` rewrites `1-1`/`1on1`/`1-on-1`/`one-on-one` to the vault's `11`. Raw source paths keep the plain slugify form because dedupe derives them from the Granola title.

**Wiki-ingest** (`wiki-ingest.ts`): Creates wiki pages from structured data — meeting page (`wiki/meetings/`), source page (`wiki/sources/`), entity pages (`wiki/entities/{people,orgs,products,repos}/`), concept pages (`wiki/concepts/`). Updates `wiki/index.md`, `wiki/log.md`, `wiki/hot.md`. Idempotent — checks manifest hash.

**Entity/concept resolution**: `process.ts` sends the LLM the vault's existing entity and concept rosters (`vault.ts`), with each page's role or first sentence and aliases, so it reuses canonical slugs (e.g. "Jarrett" → `jarrett-yeap`) and can tell same-named pages apart. `wiki-ingest.ts` then resolves each slug across all entity sub-folders: existing pages get an `## Update (date)` section + Mentioned In link; first-name-only person slugs with no match are never created and are reported in `unresolved`. Links to pages that neither exist nor are being created are rewritten as plain text. Mentioned In links point at the meeting page slug.

**Addresses**: uses the vault's `scripts/allocate-address.sh` when `flock` exists; otherwise (macOS) increments `.vault-meta/address-counter.txt` directly.

**Prompt files**: Edit `orchestrator/prompts/meeting-note.md` to tune output format.

## Operations

### Regenerating Granola API key

If the API returns 401, generate a new key: Granola desktop → Settings → API → Create key. Update `GRANOLA_API_KEY` in `.env`.

## Constraints

- `CLAUDE_MODEL` default is `bedrock.claude-sonnet-4-6` — the API key only allows Bedrock model IDs
- `.env` is never committed
- No hardcoded paths in code — all configurable via env vars
