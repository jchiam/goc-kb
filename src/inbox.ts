import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listMeetings } from './granola-client.js';
import { loadState, saveState } from './state.js';
import type { GranolaMeeting } from './types.js';

const VAULT_PATH = process.env.VAULT_PATH ?? process.env.OBSIDIAN_VAULT_PATH ?? '/vault';

interface ManifestData {
  sources: Record<string, unknown>;
}

function loadManifest(): ManifestData {
  const path = join(VAULT_PATH, '.raw/.manifest.json');
  if (!existsSync(path)) return { sources: {} };
  return JSON.parse(readFileSync(path, 'utf-8')) as ManifestData;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function isIngested(meeting: GranolaMeeting, manifest: ManifestData): boolean {
  const date = meeting.created_at.split('T')[0];
  const slug = slugify(meeting.title);
  const rawPath = `.raw/transcripts/${date}-${slug}.md`;

  if (manifest.sources[rawPath]) return true;
  if (existsSync(join(VAULT_PATH, rawPath))) return true;

  return false;
}

async function main() {
  const noUpdate = process.argv.includes('--no-update');

  const state = loadState();
  const meetings = await listMeetings(state.lastCheckedAt);
  const manifest = loadManifest();

  const pending = meetings.filter((m) => !isIngested(m, manifest));

  console.log(JSON.stringify(pending, null, 2));

  if (!noUpdate && pending.length >= 0) {
    saveState({ lastCheckedAt: new Date().toISOString() });
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
