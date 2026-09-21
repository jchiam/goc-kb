import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listMeetings } from './granola-client.js';
import { loadState, saveState } from './state.js';
import { rawRelPath, readRawUpdatedAt } from './write.js';
import type { GranolaMeeting } from './types.js';

const VAULT_PATH = process.env.VAULT_PATH ?? process.env.OBSIDIAN_VAULT_PATH ?? '/vault';

interface ManifestData {
  sources: Record<string, unknown>;
}

interface InboxItem extends GranolaMeeting {
  /** new: never ingested. updated: ingested, but edited in Granola since. */
  status: 'new' | 'updated';
  /** Granola updated_at captured in the raw source (null for legacy raw files) */
  ingested_updated_at?: string | null;
}

function loadManifest(): ManifestData {
  const path = join(VAULT_PATH, '.raw/.manifest.json');
  if (!existsSync(path)) return { sources: {} };
  return JSON.parse(readFileSync(path, 'utf-8')) as ManifestData;
}

function isIngested(rawPath: string, manifest: ManifestData): boolean {
  if (manifest.sources[rawPath]) return true;
  if (existsSync(join(VAULT_PATH, rawPath))) return true;

  return false;
}

function classify(meeting: GranolaMeeting, manifest: ManifestData): InboxItem | null {
  const rawPath = rawRelPath(meeting.title, meeting.created_at);
  if (!isIngested(rawPath, manifest)) return { ...meeting, status: 'new' };

  // Legacy raw files have no granola_updated_at; any edit since the last check counts as updated
  const ingestedUpdatedAt = readRawUpdatedAt(rawPath);
  const editedSince =
    !ingestedUpdatedAt || (meeting.updated_at && Date.parse(meeting.updated_at) > Date.parse(ingestedUpdatedAt));
  return editedSince ? { ...meeting, status: 'updated', ingested_updated_at: ingestedUpdatedAt } : null;
}

async function main() {
  const noUpdate = process.argv.includes('--no-update');

  const state = loadState();
  // updated_after covers both newly created notes and edits to older ones
  const meetings = await listMeetings(state.lastCheckedAt, 100, 'updated_after');
  const manifest = loadManifest();

  const pending = meetings.map((m) => classify(m, manifest)).filter((m): m is InboxItem => m !== null);

  console.log(JSON.stringify(pending, null, 2));

  if (!noUpdate) {
    saveState({ lastCheckedAt: new Date().toISOString() });
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
