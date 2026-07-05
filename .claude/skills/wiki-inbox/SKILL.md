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

Surface Granola meetings that haven't been ingested into the knowledge base yet.

## Steps

1. Run from the `goc-kb` repo:
   ```bash
   cd ~/Development/goc-kb && npm run inbox
   ```
2. Parse the JSON output — an array of `{ id, title, created_at, updated_at }`.
3. If empty, tell the user the vault is up to date.
4. Present as a numbered list: **title** — date.
5. Ask the user which meetings to ingest (by number, range, or "all"). They may also choose to skip.
6. For each selected meeting, run:
   ```bash
   cd ~/Development/goc-kb && npm run ingest -- --meeting-id <id>
   ```
7. Report results: pages created, pages updated, any errors.

## Notes

- Requires `GRANOLA_API_KEY` and `OBSIDIAN_VAULT_PATH` set in `~/Development/goc-kb/.env`
- The ingest step calls the Claude API (costs tokens) — confirm before processing many meetings at once
- Use `npm run inbox -- --no-update` to preview without advancing the "last checked" timestamp
- State is stored in the vault at `.raw/.ingest-state.json`
