# Granola-Obsidian-Claude Knowledge Base

Manual pipeline that takes meeting notes from [Granola](https://granola.ai), enriches them with Claude into structured wiki-style notes, and writes them to an Obsidian vault.

You edit transcripts in Granola first, then trigger ingestion when you're ready — no automation, no surprises.

---

## How it works

```
Granola (you edit transcripts)
    │
    ▼
/wiki-inbox (Claude Code skill in your vault)
    ├── Lists meetings not yet ingested
    ├── You pick which to process
    └── For each selected meeting:
            ├── Fetches content from Granola API
            ├── Sends to Claude for entity/concept extraction
            └── Writes wiki pages to Obsidian vault
```

For each meeting, Claude produces:
- A structured meeting note (date, attendees, decisions, action items)
- Entity pages (people, orgs, products)
- Concept pages for recurring topics
- Cross-references and backlinks

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 24+ | Runtime for the CLI tools |
| Granola (macOS app) | Must be installed and signed in; generate API key in Settings → API |
| Obsidian vault | Existing vault directory |
| Anthropic API key | [console.anthropic.com](https://console.anthropic.com) |
| Claude Code | CLI or IDE extension — used to invoke `/wiki-inbox` in the vault |

---

## Setup

### 1. Clone and configure

```bash
git clone <repo-url> goc-kb
cd goc-kb
npm install
cp .env.example .env
```

Edit `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=bedrock.claude-sonnet-4-6
GRANOLA_API_KEY=grn_...
OBSIDIAN_VAULT_PATH=/path/to/your/vault
```

### 2. Link the skill into your vault

The `/wiki-inbox` skill needs to be available when you open a Claude session in your vault:

```bash
mkdir -p /path/to/your/vault/.claude/skills
ln -s "$(pwd)/.claude/skills/wiki-inbox" /path/to/your/vault/.claude/skills/wiki-inbox
```

### 3. Use it

Open a Claude Code session in your vault and say "what's new" or run `/wiki-inbox`.

---

## Configuration reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `ANTHROPIC_BASE_URL` | No | — | Custom base URL for proxy |
| `CLAUDE_MODEL` | No | `bedrock.claude-sonnet-4-6` | Claude model ID |
| `GRANOLA_API_KEY` | Yes | — | Granola API key (`grn_...`), generated in Settings → API |
| `OBSIDIAN_VAULT_PATH` | Yes | — | Absolute path to vault root |
| `LOOKBACK_DAYS` | No | `30` | Days of history on first run |

---

## Vault output structure

```
wiki/
├── index.md                          # auto-updated index
├── log.md                            # chronological log
├── hot.md                            # recent ingests
├── meetings/
│   ├── 2026-05-04-design-review.md
│   └── 2026-05-03-standup.md
├── sources/
│   └── 2026-05-04-design-review.md   # source summary
├── entities/
│   └── jane-doe.md                   # people, orgs, products
└── concepts/
    └── project-alpha.md              # recurring topics
```

---

## CLI commands

Run from the project root:

```bash
npm run inbox                            # list un-ingested meetings (JSON)
npm run inbox -- --no-update             # peek without advancing timestamp
npm run ingest -- --meeting-id <id>      # ingest one meeting
npm run ingest -- --meeting-id <id> --dry-run  # preview without writes
npm run build                            # typecheck
```

---

## Troubleshooting

**No meetings appearing in inbox**
Check that `GRANOLA_API_KEY` is valid: `curl -H "Authorization: Bearer $GRANOLA_API_KEY" https://public-api.granola.ai/v1/notes?page_size=1`. Delete `.raw/.ingest-state.json` in your vault to reset the lookback window.

**Auth error (401)**
API key was revoked. Generate a new one in Granola desktop: Settings → API. Update `.env`.

**"Meeting not found in last 90 days"**
The ingest command looks back 90 days to find a meeting by ID. If the meeting is older, it won't be found via the API.
