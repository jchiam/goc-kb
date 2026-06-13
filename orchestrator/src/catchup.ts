import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ProcessedMeeting, ConceptNote, Entity, MeetingDetail } from './types.js';
import { wikiIngest } from './wiki-ingest.js';

const VAULT_PATH = process.env.VAULT_PATH ?? process.env.OBSIDIAN_VAULT_PATH ?? '/vault';

interface Manifest {
  version: number;
  sources: Record<string, { hash: string }>;
}

function loadManifest(): Manifest {
  const path = join(VAULT_PATH, '.raw/.manifest.json');
  if (!existsSync(path)) return { version: 1, sources: {} };
  return JSON.parse(readFileSync(path, 'utf-8')) as Manifest;
}

function md5(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

function parseFrontmatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };

  const meta: Record<string, string | string[]> = {};
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

function parseConceptsFromBody(body: string): ConceptNote[] {
  const marker = '## Extracted Concepts';
  const idx = body.indexOf(marker);
  if (idx === -1) return [];

  const conceptSection = body.slice(idx + marker.length).trim();
  const concepts: ConceptNote[] = [];
  const parts = conceptSection.split(/\n###\s+/).filter(Boolean);

  for (const part of parts) {
    const newlineIdx = part.indexOf('\n');
    if (newlineIdx === -1) continue;
    const title = part.slice(0, newlineIdx).trim();
    const content = part.slice(newlineIdx).trim();
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60);
    concepts.push({ slug, title, content });
  }

  return concepts;
}

function parseEntitiesFromBody(body: string): Entity[] {
  // Entities aren't stored in the raw transcript body — they're in wiki pages.
  // For catch-up we can only extract from Related section wikilinks, but
  // we'll return empty and let wiki-ingest create the meeting/source pages.
  return [];
}

function getMeetingNoteBody(body: string): string {
  const marker = '---\n\n## Extracted Concepts';
  const idx = body.indexOf(marker);
  if (idx === -1) return body;
  return body.slice(0, idx).trim();
}

function reconstructProcessedMeeting(filename: string, content: string): ProcessedMeeting {
  const { meta, body } = parseFrontmatter(content);

  const date = (meta.date as string) ?? filename.slice(0, 10);
  const title = ((meta.title as string) ?? filename.replace(/\.md$/, '').slice(11)).replace(/^"|"$/g, '');
  const id = ((meta.granola_id as string) ?? `file-${filename}`).replace(/^"|"$/g, '');

  const meeting: MeetingDetail = {
    id,
    title,
    createdAt: `${date}T00:00:00.000Z`,
    notes: '',
    transcript: '',
  };

  const meetingNoteBody = getMeetingNoteBody(body);
  const attendees = Array.isArray(meta.attendees) ? meta.attendees : [];
  const tags = Array.isArray(meta.tags) ? meta.tags : ['meeting'];

  const meetingNote = [
    '---',
    `date: ${date}`,
    'attendees:',
    ...attendees.map((a) => `  - ${a}`),
    'tags:',
    ...tags.map((t) => `  - ${t}`),
    `source: ${(meta.source as string) ?? 'granola'}`,
    `granola_id: ${id}`,
    '---',
    '',
    meetingNoteBody,
  ].join('\n');

  const conceptNotes = parseConceptsFromBody(body);
  const entities = parseEntitiesFromBody(body);

  return { meeting, meetingNote, conceptNotes, entities };
}

export function runCatchup(dryRun = false): void {
  const transcriptsDir = join(VAULT_PATH, '.raw/transcripts');
  if (!existsSync(transcriptsDir)) return;

  const manifest = loadManifest();
  const files = readdirSync(transcriptsDir).filter((f) => f.endsWith('.md'));

  const missing: string[] = [];
  for (const file of files) {
    const relPath = `.raw/transcripts/${file}`;
    const absPath = join(transcriptsDir, file);
    const content = readFileSync(absPath, 'utf-8');
    const hash = md5(content);

    if (manifest.sources[relPath]?.hash === hash) continue;
    missing.push(file);
  }

  if (missing.length === 0) return;

  console.log(`\nCatch-up: ${missing.length} transcript(s) need wiki-ingest`);

  for (const file of missing) {
    const absPath = join(transcriptsDir, file);
    const content = readFileSync(absPath, 'utf-8');

    try {
      const processed = reconstructProcessedMeeting(file, content);

      if (dryRun) {
        console.log(`  [dry-run] Would wiki-ingest: ${file} (${processed.conceptNotes.length} concepts)`);
        continue;
      }

      const result = wikiIngest(processed, { dryRun });
      if (!result.skipped) {
        console.log(`  ${file}: ${result.pagesCreated.length} created, ${result.pagesUpdated.length} updated`);
      } else {
        console.log(`  ${file}: skipped (already current)`);
      }
    } catch (err) {
      console.error(`  ${file}: catch-up failed:`, err);
    }
  }
}
