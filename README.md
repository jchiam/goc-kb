# Granola-Obsidian-Claude Knowledge Base

Automated pipeline that pulls new meeting notes from [Granola](https://granola.ai), enriches them with Claude into structured wiki-style notes, writes them to an Obsidian vault, and syncs the vault to Google Drive via rclone — all running inside a single Docker Compose stack.

Your native Obsidian app reads the same vault directory the whole time. The container is invisible to it.

---

## How it works

```
Granola API (direct HTTP via granola-client.ts)
    │
    ▼
Orchestrator (TypeScript)
    ├── Checks state.json — skips already-processed meetings
    ├── Sends transcript + vault context to Claude
    │       (claude-obsidian wiki pattern)
    └── Writes enriched markdown notes to Obsidian vault
            │
            ▼
        rclone sync → Google Drive
```

For each new meeting, Claude produces:
- A structured meeting note (date, attendees, decisions, action items)
- Backlinks to related concepts already in the vault
- New concept pages for topics that don't yet exist

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Docker Desktop | [Install](https://docs.docker.com/desktop/mac/) |
| Granola (macOS app) | Must be installed and signed in |
| Obsidian vault | Existing vault with [claude-obsidian](https://github.com/AgriciDaniel/claude-obsidian) default structure |
| Anthropic API key | [console.anthropic.com](https://console.anthropic.com) |
| rclone | `brew install rclone` |

---

## Setup

### 1. Clone and configure

```bash
git clone <repo-url> goc-kb
cd goc-kb
cp .env.example .env
```

Edit `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
# Optional: custom base URL for local Claude or custom endpoint
ANTHROPIC_BASE_URL=

# Claude model (defaults to bedrock.claude-sonnet-4-6 if not set)
CLAUDE_MODEL=bedrock.claude-sonnet-4-6

# Granola's Supabase auth file (from Granola desktop app)
GRANOLA_SUPABASE_PATH=~/Library/Application Support/Granola/supabase.json

# Absolute path to your Obsidian vault root
OBSIDIAN_VAULT_PATH=~/Obsidian Vault

# rclone destination in remote:path format
RCLONE_DEST=gdrive:Granola Notes

# Pipeline schedule (cron format, defaults to hourly)
CRON_SCHEDULE=0 * * * *

# Lookback window for new meetings (days)
LOOKBACK_DAYS=30
```

See `.env.example` for all available options.

### 2. Configure rclone

Run the interactive setup once on the host:

```bash
rclone config
```

Create a remote named `gdrive` pointing at your Google Drive. When prompted, complete the OAuth flow in the browser. Then copy the generated config into the project:

```bash
cp ~/.config/rclone/rclone.conf rclone/rclone.conf
```

Set the Google Drive destination folder in `.env`:

```env
# Path inside your Google Drive to sync the vault to
RCLONE_DEST=gdrive:Obsidian/MyVault
```

### 3. Run

```bash
docker compose up -d
```

Check logs:

```bash
docker compose logs -f orchestrator
```

The first run processes all meetings from the lookback window (default 30 days). Subsequent runs only process new meetings since the last run (tracked in `state/state.json`).

---

## Configuration reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic API key |
| `ANTHROPIC_BASE_URL` | No | — | Custom base URL for local Claude or proxy |
| `CLAUDE_MODEL` | No | `bedrock.claude-sonnet-4-6` | Claude model ID |
| `GRANOLA_SUPABASE_PATH` | No | `~/Library/Application Support/Granola/supabase.json` | Path to Granola's Supabase auth file |
| `OBSIDIAN_VAULT_PATH` | Yes | — | Absolute path to vault root on host |
| `RCLONE_DEST` | Yes | — | `remote:path` for rclone sync target |
| `CRON_SCHEDULE` | No | `0 * * * *` | Cron expression for pipeline frequency |
| `LOOKBACK_DAYS` | No | `30` | Days of history to process on first run |

---

## Vault output structure

Meeting notes land in `$MEETINGS_FOLDER` following the claude-obsidian convention:

```
wiki/
├── index.md                          # auto-updated index
├── log.md                            # chronological log
├── meetings/
│   ├── 2026-05-04-design-review.md   # one file per meeting
│   └── 2026-05-03-standup.md
├── entities/
│   └── jane-doe.md                   # people mentioned across meetings
└── concepts/
    └── project-alpha.md              # topics that recur
```

Each meeting note includes:

```markdown
---
date: 2026-05-04
attendees: [Jane Doe, John Smith]
tags: [meeting, project-alpha]
---

## Decisions
- ...

## Action Items
- [ ] ...

## Summary
...

## Related
- [[project-alpha]]
- [[jane-doe]]
```

---

## Development

Run the orchestrator directly (without Docker) for faster iteration:

```bash
cd orchestrator
npm install
npm run dev        # runs once immediately
npm run dev:watch  # re-runs on file changes
```

Run against a specific meeting:

```bash
npm run ingest -- --meeting-id <id>
```

Dry-run (no writes to vault):

```bash
npm run ingest -- --dry-run
```

---

## Portability

All state lives in mounted volumes or `.env`:

| What | Where |
|---|---|
| Processed meeting IDs | `state/state.json` |
| rclone credentials | `rclone/rclone.conf` |
| Granola auth tokens | `~/Library/Application Support/Granola/supabase.json` (host, read-only mount) |
| Pipeline config | `.env` |

Moving to a new machine: clone the repo, copy `.env` and `rclone/rclone.conf`, install Granola and sign in (creates `supabase.json`), `docker compose up -d`.

---

## Cross-device setup

`state/state.json` is device-local and not synced to Google Drive. On a new machine the orchestrator starts from scratch and would re-fetch all meetings in the lookback window. Meeting notes are skipped if the file already exists in the vault, so the safety net is having the vault present before first run.

To set up on a second machine without reprocessing already-written meetings:

1. Clone the repo and copy `.env` and `rclone/rclone.conf` from the first machine.
2. Install Granola and sign in (creates `supabase.json`).
3. Pull the vault from Google Drive before first run:

```bash
rclone copy gdrive:"Granola Notes" "$OBSIDIAN_VAULT_PATH"
```

Replace `gdrive:"Granola Notes"` with your `RCLONE_DEST` value from `.env`.

4. Run the pipeline — existing meeting note files are detected and skipped automatically.

---

## Troubleshooting

**No meetings appearing**
Check that Granola desktop is signed in (creates `supabase.json`). Check `state/state.json` — delete it to reprocess from scratch.

**Auth token expired (401 or "Token refresh failed")**
Open Granola desktop app (refreshes `supabase.json`). The pipeline auto-detects the fresher token on next run.

**rclone sync failing**
Run `rclone lsd gdrive:` on the host to confirm the remote is reachable. Re-copy `rclone.conf` if it's stale.

**Claude rate limit errors**
Lower the cron frequency or add `ANTHROPIC_RATE_LIMIT_RPM=10` to `.env`.
