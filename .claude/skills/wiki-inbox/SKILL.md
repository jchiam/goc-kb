---
name: wiki-inbox
description: Show un-ingested Granola meetings available for wiki processing
triggers:
  - wiki-inbox
  - inbox
  - check meetings
  - new meetings
  - what's new
---

# Wiki Inbox

Surface Granola meetings that haven't been ingested into the knowledge base yet, and ingested meetings that were edited in Granola afterwards.

## Steps

1. Run from the `goc-kb` repo:
   ```bash
   cd ~/Development/goc-kb && npm run inbox
   ```
2. Parse the JSON output — an array of `{ id, title, created_at, updated_at, status, ingested_updated_at? }`. `status` is `new` (never ingested) or `updated` (ingested, edited in Granola since; `ingested_updated_at` is the version captured, null for legacy raw files).
3. If empty, tell the user the vault is up to date.
4. Present as a numbered list: **title** — date — new/updated.
5. Ask the user which meetings to process (by number, range, or "all"). They may also choose to skip.
6. For each selected `new` meeting, run:
   ```bash
   cd ~/Development/goc-kb && npm run ingest -- --meeting-id <id>
   ```
7. For each selected `updated` meeting, refresh the raw source only (no LLM call, no wiki writes):
   ```bash
   cd ~/Development/goc-kb && npm run ingest -- --meeting-id <id> --refresh
   ```
   Then diff the refreshed `.raw/transcripts/` file against git, and hand-apply corrections (names, terms, facts) to the meeting, source, entity, and concept pages that came from that meeting.
8. Report results: pages created, pages updated, any errors.

## Notes

- Requires `GRANOLA_API_KEY` and `OBSIDIAN_VAULT_PATH` set in `~/Development/goc-kb/.env`
- The ingest step calls the Claude API (costs tokens) — confirm before processing many meetings at once
- Use `npm run inbox -- --no-update` to preview without advancing the "last checked" timestamp
- State is stored in the vault at `.raw/.ingest-state.json`
