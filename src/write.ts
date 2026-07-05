import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProcessedMeeting } from './types.js';

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

interface Frontmatter {
  meta: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(markdown: string): Frontmatter {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: markdown };

  const meta: Record<string, unknown> = {};
  const lines = match[1].split('\n');
  let currentKey = '';

  for (const line of lines) {
    const scalarMatch = line.match(/^(\w[\w_]*):\s*(.+)$/);
    if (scalarMatch) {
      currentKey = scalarMatch[1];
      meta[currentKey] = scalarMatch[2].replace(/^["']|["']$/g, '');
      continue;
    }
    const arrayKeyMatch = line.match(/^(\w[\w_]*):\s*$/);
    if (arrayKeyMatch) {
      currentKey = arrayKeyMatch[1];
      meta[currentKey] = [];
      continue;
    }
    const itemMatch = line.match(/^\s+-\s+(.+)$/);
    if (itemMatch && currentKey && Array.isArray(meta[currentKey])) {
      (meta[currentKey] as string[]).push(itemMatch[1]);
    }
  }

  return { meta, body: match[2].trim() };
}

function serializeFrontmatter(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${item}`);
      }
    } else if (typeof value === 'string' && (value.includes(':') || value.includes('"') || value.includes("'"))) {
      lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

export function writeRawSource(processed: ProcessedMeeting, dryRun = false): string | null {
  const { meeting, meetingNote, conceptNotes } = processed;
  const date = meeting.createdAt.split('T')[0];
  const slug = slugify(meeting.title);
  const filename = `${date}-${slug}.md`;
  const dir = join(VAULT_PATH, RAW_TRANSCRIPTS_DIR);
  const filePath = join(dir, filename);

  if (dryRun) {
    console.log(`[dry-run] Would write raw source: ${filePath}`);
    if (conceptNotes.length > 0) {
      console.log(`[dry-run]   with ${conceptNotes.length} extracted concept(s)`);
    }
    return null;
  }

  if (existsSync(filePath)) {
    console.log(`Already exists: ${filePath}`);
    return null;
  }

  const { meta, body } = parseFrontmatter(meetingNote);

  const sourceMeta: Record<string, unknown> = {
    title: `"${String(meeting.title).replace(/"/g, '\\"')}"`,
    date: (meta.date as string) ?? date,
    source: 'granola',
    granola_id: `"${meeting.id}"`,
    attendees: (meta.attendees as string[]) ?? [],
    tags: (meta.tags as string[]) ?? ['meeting'],
    type: 'meeting-transcript',
  };

  const parts: string[] = [
    `---\n${serializeFrontmatter(sourceMeta)}\n---\n`,
    body,
  ];

  if (conceptNotes.length > 0) {
    const conceptSections = conceptNotes.map((c) => {
      const { body: conceptBody } = parseFrontmatter(c.content);
      const stripped = conceptBody.replace(/^#\s+.+\n*/, '');
      return `### ${c.title}\n\n${stripped.trim()}`;
    });
    parts.push('---\n\n## Extracted Concepts\n');
    parts.push(conceptSections.join('\n\n'));
  }

  const content = parts.join('\n\n') + '\n';

  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  console.log(`Written raw source: ${filePath}`);
  return filePath;
}
