import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MeetingDetail } from './types.js';

const VAULT_PATH = process.env.VAULT_PATH ?? process.env.OBSIDIAN_VAULT_PATH ?? '/vault';
const RAW_TRANSCRIPTS_DIR = '.raw/transcripts';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

/** Vault-relative path of a meeting's raw source file. */
export function rawRelPath(title: string, createdAt: string): string {
  return `${RAW_TRANSCRIPTS_DIR}/${createdAt.split('T')[0]}-${slugify(title)}.md`;
}

/** Granola `updated_at` recorded in a raw source file, or null if absent (legacy files). */
export function readRawUpdatedAt(relPath: string): string | null {
  const absPath = join(VAULT_PATH, relPath);
  if (!existsSync(absPath)) return null;
  const match = readFileSync(absPath, 'utf-8').match(/^granola_updated_at:\s*"?([^"\n]+)"?\s*$/m);
  return match ? match[1] : null;
}

/** Raw source = Granola content verbatim, so it can be refreshed without an LLM call. */
function renderRawSource(meeting: MeetingDetail): string {
  const fm = [
    `title: ${JSON.stringify(meeting.title)}`,
    `date: ${meeting.createdAt.split('T')[0]}`,
    'source: granola',
    `granola_id: ${JSON.stringify(meeting.id)}`,
  ];
  if (meeting.webUrl) fm.push(`granola_url: ${JSON.stringify(meeting.webUrl)}`);
  if (meeting.updatedAt) fm.push(`granola_updated_at: ${JSON.stringify(meeting.updatedAt)}`);
  fm.push('attendees:', ...meeting.attendees.map((a) => `  - ${JSON.stringify(a)}`));
  fm.push('tags:', '  - meeting', 'type: meeting-transcript');

  const parts = [`---\n${fm.join('\n')}\n---`];
  if (meeting.notes) parts.push(`## Private Notes\n\n${meeting.notes}`);
  if (meeting.summary) parts.push(`## Granola Summary\n\n${meeting.summary}`);
  if (meeting.transcript) parts.push(`## Transcript\n\n${meeting.transcript.split('\n').join('\n\n')}`);

  return parts.join('\n\n') + '\n';
}

export function writeRawSource(
  meeting: MeetingDetail,
  opts: { dryRun?: boolean; overwrite?: boolean } = {},
): string | null {
  const filePath = join(VAULT_PATH, rawRelPath(meeting.title, meeting.createdAt));

  if (opts.dryRun) {
    console.error(`[dry-run] Would write raw source: ${filePath}`);
    return null;
  }

  if (existsSync(filePath) && !opts.overwrite) {
    console.error(`Already exists: ${filePath}`);
    return null;
  }

  mkdirSync(join(VAULT_PATH, RAW_TRANSCRIPTS_DIR), { recursive: true });
  writeFileSync(filePath, renderRawSource(meeting), 'utf-8');
  console.error(`Written raw source: ${filePath}`);
  return filePath;
}
