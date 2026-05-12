import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessedMeeting } from './types.js';

const VAULT_PATH = process.env.VAULT_PATH ?? process.env.OBSIDIAN_VAULT_PATH ?? '/vault';
const MEETINGS_FOLDER = process.env.MEETINGS_FOLDER ?? 'wiki/meetings';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
}

function logDiff(path: string, existing: string, updated: string): void {
  const oldLines = existing.split('\n').length;
  const newLines = updated.split('\n').length;
  console.log(`Updating: ${path} (${oldLines} → ${newLines} lines)`);
  const oldHeaders: string[] = existing.match(/^## .+$/gm) ?? [];
  const newHeaders: string[] = updated.match(/^## .+$/gm) ?? [];
  const added = newHeaders.filter((h) => !oldHeaders.includes(h));
  const removed = oldHeaders.filter((h) => !newHeaders.includes(h));
  if (added.length) console.log(`  + sections: ${added.join(', ')}`);
  if (removed.length) console.log(`  - sections: ${removed.join(', ')}`);
}

export function writeMeetingNote(processed: ProcessedMeeting, dryRun = false): void {
  const { meeting, meetingNote, conceptNotes } = processed;
  const date = meeting.createdAt.split('T')[0];
  const slug = slugify(meeting.title);
  const filename = `${date}-${slug}.md`;
  const meetingsDir = join(VAULT_PATH, MEETINGS_FOLDER);
  const filePath = join(meetingsDir, filename);

  if (dryRun) {
    console.log(`[dry-run] Would write: ${filePath}`);
    for (const c of conceptNotes) {
      console.log(`[dry-run] Would write concept: wiki/concepts/${c.slug}.md`);
    }
    return;
  }

  mkdirSync(meetingsDir, { recursive: true });

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    if (existing === meetingNote) {
      console.log(`Unchanged: ${filePath}`);
      return;
    }
    logDiff(filePath, existing, meetingNote);
  }

  writeFileSync(filePath, meetingNote, 'utf-8');
  console.log(`Written: ${filePath}`);

  const conceptsDir = join(VAULT_PATH, 'wiki', 'concepts');
  mkdirSync(conceptsDir, { recursive: true });

  for (const concept of conceptNotes) {
    const conceptPath = join(conceptsDir, `${concept.slug}.md`);
    if (existsSync(conceptPath)) {
      const existing = readFileSync(conceptPath, 'utf-8');
      if (existing === concept.content) continue;
      logDiff(conceptPath, existing, concept.content);
    }
    writeFileSync(conceptPath, concept.content, 'utf-8');
    console.log(`Written concept: ${concept.slug}`);
  }
}
