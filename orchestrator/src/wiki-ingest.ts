import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { ProcessedMeeting, Entity, ConceptNote } from './types.js';

const VAULT_PATH = process.env.VAULT_PATH ?? process.env.OBSIDIAN_VAULT_PATH ?? '/vault';

export interface IngestResult {
  sourcePath: string;
  pagesCreated: string[];
  pagesUpdated: string[];
  skipped: boolean;
}

interface ManifestEntry {
  hash: string;
  ingested_at: string;
  pages_created: string[];
  pages_updated: string[];
}

interface Manifest {
  version: number;
  sources: Record<string, ManifestEntry>;
  address_map?: Record<string, string>;
}

function today(): string {
  return new Date().toISOString().split('T')[0];
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

function md5(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

function loadManifest(): Manifest {
  const path = join(VAULT_PATH, '.raw/.manifest.json');
  if (!existsSync(path)) return { version: 1, sources: {} };
  return JSON.parse(readFileSync(path, 'utf-8')) as Manifest;
}

function saveManifest(manifest: Manifest): void {
  const path = join(VAULT_PATH, '.raw/.manifest.json');
  mkdirSync(join(VAULT_PATH, '.raw'), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf-8');
}

function hasDragonScale(): boolean {
  return (
    existsSync(join(VAULT_PATH, 'scripts/allocate-address.sh')) &&
    existsSync(join(VAULT_PATH, '.vault-meta'))
  );
}

function allocateAddress(): string | null {
  if (!hasDragonScale()) return null;
  try {
    return execSync('./scripts/allocate-address.sh', { cwd: VAULT_PATH, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function ensureDirs(): void {
  const dirs = ['wiki/sources', 'wiki/entities', 'wiki/concepts', 'wiki/meetings'];
  for (const dir of dirs) {
    mkdirSync(join(VAULT_PATH, dir), { recursive: true });
  }
}

function writePage(relPath: string, content: string): boolean {
  const absPath = join(VAULT_PATH, relPath);
  if (existsSync(absPath)) return false;
  mkdirSync(join(VAULT_PATH, relPath, '..'), { recursive: true });
  writeFileSync(absPath, content, 'utf-8');
  return true;
}

function parseMeetingNoteFrontmatter(meetingNote: string): { meta: Record<string, unknown>; body: string } {
  const match = meetingNote.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: meetingNote };

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

function buildMeetingPage(processed: ProcessedMeeting, rawRelPath: string): string {
  const { meeting, meetingNote, conceptNotes, entities } = processed;
  const { meta, body } = parseMeetingNoteFrontmatter(meetingNote);
  const date = meeting.createdAt.split('T')[0];
  const address = allocateAddress();

  const attendees = (meta.attendees as string[]) ?? [];
  const tags = (meta.tags as string[]) ?? ['meeting'];

  const fm = [
    '---',
    'type: meeting',
    'status: seed',
    `created: ${today()}`,
    `updated: ${today()}`,
    `date: ${date}`,
  ];
  if (attendees.length > 0) {
    fm.push('attendees:');
    for (const a of attendees) fm.push(`  - ${a}`);
  }
  fm.push('tags:');
  for (const t of tags) fm.push(`  - ${t}`);
  fm.push('source: granola');
  fm.push(`granola_id: ${meeting.id}`);
  if (address) fm.push(`address: ${address}`);
  fm.push('---');

  const related = [
    ...conceptNotes.map((c) => `- [[${c.slug}]]`),
    ...entities.map((e) => `- [[${e.slug}]]`),
  ];

  const parts = [fm.join('\n'), '', body];
  if (related.length > 0) {
    parts.push('', '## Related', '', ...related);
  }
  parts.push('');

  return parts.join('\n');
}

function buildSourcePage(processed: ProcessedMeeting, rawRelPath: string): string {
  const { meeting, conceptNotes, entities } = processed;
  const date = meeting.createdAt.split('T')[0];
  const related = [
    ...conceptNotes.map((c) => `"[[${c.slug}]]"`),
    ...entities.map((e) => `"[[${e.slug}]]"`),
  ];
  const address = allocateAddress();

  const fm = [
    '---',
    'type: source',
    `title: "${meeting.title.replace(/"/g, '\\"')}"`,
    'source_type: transcript',
    `date_published: ${date}`,
    'tags:',
    '  - source',
    '  - meeting',
    'status: seed',
    `created: ${today()}`,
    `updated: ${today()}`,
  ];
  if (address) fm.push(`address: ${address}`);
  if (related.length > 0) {
    fm.push('related:');
    for (const r of related) fm.push(`  - ${r}`);
  }
  fm.push('sources:');
  fm.push(`  - "[[${rawRelPath}]]"`);
  fm.push('---');

  const body = [
    '',
    `## Summary`,
    '',
    `Meeting on ${date}: ${meeting.title}.`,
    '',
    '## Pages Created',
    '',
    ...conceptNotes.map((c) => `- [[${c.slug}]]`),
    ...entities.map((e) => `- [[${e.slug}]]`),
    '',
    '## Source',
    '',
    `- [[${rawRelPath}]]`,
    '',
  ];

  return fm.join('\n') + '\n' + body.join('\n');
}

function buildEntityPage(entity: Entity, rawRelPath: string): string {
  const address = allocateAddress();
  const fm = [
    '---',
    'type: entity',
    `entity_type: ${entity.entity_type}`,
    `title: "${entity.name.replace(/"/g, '\\"')}"`,
  ];
  if (entity.role) fm.push(`role: "${entity.role.replace(/"/g, '\\"')}"`);
  fm.push('tags:');
  fm.push('  - entity');
  fm.push(`  - ${entity.entity_type}`);
  fm.push('status: seed');
  fm.push(`created: ${today()}`);
  fm.push(`updated: ${today()}`);
  if (address) fm.push(`address: ${address}`);
  fm.push('sources:');
  fm.push(`  - "[[${rawRelPath}]]"`);
  fm.push('---');

  const body = [
    '',
    `# ${entity.name}`,
    '',
    entity.description,
    '',
    '## Mentioned In',
    '',
    `- [[${rawRelPath}]]`,
    '',
  ];

  return fm.join('\n') + '\n' + body.join('\n');
}

function buildConceptPage(concept: ConceptNote, rawRelPath: string): string {
  const address = allocateAddress();
  const fm = [
    '---',
    'type: concept',
    `title: "${concept.title.replace(/"/g, '\\"')}"`,
    'tags:',
    '  - concept',
    'status: seed',
    `created: ${today()}`,
    `updated: ${today()}`,
  ];
  if (address) fm.push(`address: ${address}`);
  fm.push('sources:');
  fm.push(`  - "[[${rawRelPath}]]"`);
  fm.push('---');

  const contentBody = concept.content
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/^#\s+.+\n*/, '')
    .trim();

  const body = [
    '',
    `# ${concept.title}`,
    '',
    contentBody,
    '',
    '## Mentioned In',
    '',
    `- [[${rawRelPath}]]`,
    '',
  ];

  return fm.join('\n') + '\n' + body.join('\n');
}

function appendToEntityPage(entityPath: string, rawRelPath: string): boolean {
  const absPath = join(VAULT_PATH, entityPath);
  if (!existsSync(absPath)) return false;
  const content = readFileSync(absPath, 'utf-8');
  const mentionLink = `- [[${rawRelPath}]]`;
  if (content.includes(mentionLink)) return false;

  const updated = content.replace(
    /(\n## Mentioned In\n)/,
    `$1${mentionLink}\n`,
  );
  if (updated === content) {
    writeFileSync(absPath, content + `\n## Mentioned In\n${mentionLink}\n`, 'utf-8');
  } else {
    writeFileSync(absPath, updated, 'utf-8');
  }

  const todayStr = today();
  const withDate = readFileSync(absPath, 'utf-8').replace(
    /updated: \d{4}-\d{2}-\d{2}/,
    `updated: ${todayStr}`,
  );
  writeFileSync(absPath, withDate, 'utf-8');
  return true;
}

function updateIndex(pagesCreated: string[]): void {
  const indexPath = join(VAULT_PATH, 'wiki/index.md');
  if (!existsSync(indexPath)) {
    const seed = '---\ntype: meta\ntitle: Index\n---\n\n# Wiki Index\n\n## Meetings\n\n## Sources\n\n## Entities\n\n## Concepts\n';
    writeFileSync(indexPath, seed, 'utf-8');
  }

  let content = readFileSync(indexPath, 'utf-8');
  for (const page of pagesCreated) {
    const name = page.replace(/\.md$/, '').split('/').pop()!;
    const link = `- [[${name}]]`;
    if (content.includes(link)) continue;

    let section = '## Sources';
    if (page.includes('meetings/')) section = '## Meetings';
    else if (page.includes('entities/')) section = '## Entities';
    else if (page.includes('concepts/')) section = '## Concepts';

    const sectionIdx = content.indexOf(section);
    if (sectionIdx === -1) continue;
    const insertAt = sectionIdx + section.length;
    content = content.slice(0, insertAt) + `\n${link}` + content.slice(insertAt);
  }
  writeFileSync(indexPath, content, 'utf-8');
}

function updateLog(processed: ProcessedMeeting, pagesCreated: string[], rawRelPath: string): void {
  const logPath = join(VAULT_PATH, 'wiki/log.md');
  if (!existsSync(logPath)) {
    writeFileSync(logPath, '---\ntype: meta\ntitle: Log\n---\n\n# Ingest Log\n\n', 'utf-8');
  }

  const content = readFileSync(logPath, 'utf-8');
  const date = today();
  const pages = pagesCreated.map((p) => `[[${p.replace(/\.md$/, '').split('/').pop()}]]`).join(', ');

  const entry = [
    `## [${date}] ingest | ${processed.meeting.title}`,
    `- Source: \`${rawRelPath}\``,
    `- Pages created: ${pages}`,
    `- Entities: ${processed.entities.length}, Concepts: ${processed.conceptNotes.length}`,
    '',
  ].join('\n');

  const fmEnd = content.indexOf('---', content.indexOf('---') + 1);
  if (fmEnd === -1) {
    writeFileSync(logPath, content + '\n' + entry, 'utf-8');
  } else {
    const afterFm = content.indexOf('\n', fmEnd + 3);
    const before = content.slice(0, afterFm + 1);
    const rest = content.slice(afterFm + 1);
    const headerEnd = rest.indexOf('\n\n');
    if (headerEnd === -1) {
      writeFileSync(logPath, before + rest + '\n\n' + entry, 'utf-8');
    } else {
      const header = rest.slice(0, headerEnd + 2);
      const body = rest.slice(headerEnd + 2);
      writeFileSync(logPath, before + header + entry + '\n' + body, 'utf-8');
    }
  }
}

function updateHot(processed: ProcessedMeeting, pagesCreated: string[]): void {
  const hotPath = join(VAULT_PATH, 'wiki/hot.md');
  const date = today();
  const entities = processed.entities.map((e) => `[[${e.slug}]]`).join(', ');
  const concepts = processed.conceptNotes.map((c) => `[[${c.slug}]]`).join(', ');

  const section = [
    `### ${date} — ${processed.meeting.title}`,
    `- ${pagesCreated.length} pages created`,
    entities ? `- Entities: ${entities}` : null,
    concepts ? `- Concepts: ${concepts}` : null,
  ].filter(Boolean).join('\n');

  if (!existsSync(hotPath)) {
    const seed = `---\ntype: meta\ntitle: Hot Cache\n---\n\n# Recent Ingests\n\n${section}\n`;
    writeFileSync(hotPath, seed, 'utf-8');
    return;
  }

  let content = readFileSync(hotPath, 'utf-8');
  const marker = '# Recent Ingests';
  const markerIdx = content.indexOf(marker);
  if (markerIdx === -1) {
    content += `\n${marker}\n\n${section}\n`;
  } else {
    const insertAt = markerIdx + marker.length;
    content = content.slice(0, insertAt) + `\n\n${section}` + content.slice(insertAt);
  }

  // Keep only last ~20 entries (trim if huge)
  const lines = content.split('\n');
  if (lines.length > 200) {
    content = lines.slice(0, 200).join('\n') + '\n';
  }

  writeFileSync(hotPath, content, 'utf-8');
}

export function wikiIngest(
  processed: ProcessedMeeting,
  opts: { dryRun?: boolean } = {},
): IngestResult {
  const { meeting, conceptNotes, entities } = processed;
  const date = meeting.createdAt.split('T')[0];
  const slug = slugify(meeting.title);
  const rawFilename = `${date}-${slug}.md`;
  const rawRelPath = `.raw/transcripts/${rawFilename}`;

  const result: IngestResult = {
    sourcePath: rawRelPath,
    pagesCreated: [],
    pagesUpdated: [],
    skipped: false,
  };

  // Check manifest for already-ingested
  const manifest = loadManifest();
  const rawAbsPath = join(VAULT_PATH, rawRelPath);
  if (existsSync(rawAbsPath)) {
    const hash = md5(readFileSync(rawAbsPath, 'utf-8'));
    if (manifest.sources[rawRelPath]?.hash === hash) {
      result.skipped = true;
      return result;
    }
  }

  if (opts.dryRun) {
    console.log(`[dry-run] Wiki-ingest would create pages for: ${meeting.title}`);
    console.log(`[dry-run]   ${entities.length} entities, ${conceptNotes.length} concepts`);
    result.skipped = true;
    return result;
  }

  ensureDirs();

  // Meeting page
  const meetingSlug = `${date}-${slug}`;
  const meetingPath = `wiki/meetings/${meetingSlug}.md`;
  if (writePage(meetingPath, buildMeetingPage(processed, rawRelPath))) {
    result.pagesCreated.push(meetingPath);
  }

  // Source page
  const sourceSlug = `${date}-${slug}`;
  const sourcePath = `wiki/sources/${sourceSlug}.md`;
  if (writePage(sourcePath, buildSourcePage(processed, rawRelPath))) {
    result.pagesCreated.push(sourcePath);
  }

  // Entity pages
  for (const entity of entities) {
    const entityPath = `wiki/entities/${entity.slug}.md`;
    if (existsSync(join(VAULT_PATH, entityPath))) {
      if (appendToEntityPage(entityPath, rawRelPath)) {
        result.pagesUpdated.push(entityPath);
      }
    } else if (writePage(entityPath, buildEntityPage(entity, rawRelPath))) {
      result.pagesCreated.push(entityPath);
    }
  }

  // Concept pages
  for (const concept of conceptNotes) {
    const conceptPath = `wiki/concepts/${concept.slug}.md`;
    if (writePage(conceptPath, buildConceptPage(concept, rawRelPath))) {
      result.pagesCreated.push(conceptPath);
    }
  }

  // Meta updates
  updateIndex(result.pagesCreated);
  updateLog(processed, result.pagesCreated, rawRelPath);
  updateHot(processed, result.pagesCreated);

  // Update manifest
  const hash = existsSync(rawAbsPath) ? md5(readFileSync(rawAbsPath, 'utf-8')) : '';
  manifest.sources[rawRelPath] = {
    hash,
    ingested_at: today(),
    pages_created: result.pagesCreated,
    pages_updated: result.pagesUpdated,
  };
  saveManifest(manifest);

  result.pagesUpdated.push('wiki/index.md', 'wiki/log.md', 'wiki/hot.md');
  return result;
}
