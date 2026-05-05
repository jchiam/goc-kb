import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
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
    console.log(`Skipped (already exists): ${filePath}`);
    return;
  }
  writeFileSync(filePath, meetingNote, 'utf-8');
  console.log(`Written: ${filePath}`);

  const conceptsDir = join(VAULT_PATH, 'wiki', 'concepts');
  mkdirSync(conceptsDir, { recursive: true });

  for (const concept of conceptNotes) {
    const conceptPath = join(conceptsDir, `${concept.slug}.md`);
    if (!existsSync(conceptPath)) {
      writeFileSync(conceptPath, concept.content, 'utf-8');
      console.log(`Created concept: ${concept.slug}`);
    }
  }
}
