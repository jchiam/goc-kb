import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const VAULT_PATH = process.env.VAULT_PATH ?? process.env.OBSIDIAN_VAULT_PATH ?? '/vault';
const STATE_FILE = join(VAULT_PATH, '.raw', '.ingest-state.json');
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS ?? '30', 10);

export interface IngestState {
  lastCheckedAt: string;
}

export function loadState(): IngestState {
  if (existsSync(STATE_FILE)) {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    if (raw.lastCheckedAt) return { lastCheckedAt: raw.lastCheckedAt };
    if (raw.lastProcessedAt) return { lastCheckedAt: raw.lastProcessedAt };
  }

  // Also check legacy state file location
  const legacyPath = process.env.STATE_FILE ?? './state/state.json';
  if (existsSync(legacyPath)) {
    const raw = JSON.parse(readFileSync(legacyPath, 'utf-8'));
    if (raw.lastProcessedAt) return { lastCheckedAt: raw.lastProcessedAt };
  }

  const since = new Date();
  since.setDate(since.getDate() - LOOKBACK_DAYS);
  return { lastCheckedAt: since.toISOString() };
}

export function saveState(state: IngestState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmp, STATE_FILE);
}
