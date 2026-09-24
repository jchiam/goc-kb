import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { ProcessedMeeting, Entity, ConceptNote } from './types.js';
import { allWikiSlugs, findPagePath, isFirstNameOnly, loadCorrections, newEntityPath } from './vault.js';

const VAULT_PATH = process.env.VAULT_PATH ?? process.env.OBSIDIAN_VAULT_PATH ?? '/vault';

export interface IngestResult {
  sourcePath: string;
  pagesCreated: string[];
  pagesUpdated: string[];
  /** People the LLM could only name by first name and no existing page matched; left as plain text */
  unresolved: string[];
  skipped: boolean;
}

interface ManifestEntry {
  hash: string;
  ingested_at: string;
  pages_created: string[];
  pages_updated: string[];
  refreshed_at?: string;
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

let flockAvailable: boolean | undefined;

function hasFlock(): boolean {
  if (flockAvailable === undefined) {
    try {
      execSync('command -v flock', { stdio: 'ignore' });
      flockAvailable = true;
    } catch {
      flockAvailable = false;
    }
  }
  return flockAvailable;
}

function allocateAddress(): string | null {
  if (!hasDragonScale()) return null;
  if (hasFlock()) {
    try {
      return execSync('./scripts/allocate-address.sh', { cwd: VAULT_PATH, encoding: 'utf-8' }).trim();
    } catch {
      return null;
    }
  }
  // macOS ships without flock and the script would time out on every call. This CLI is the
  // only writer while it runs, so bump the counter directly (same format as the script).
  const counterPath = join(VAULT_PATH, '.vault-meta/address-counter.txt');
  if (!existsSync(counterPath)) return null;
  const current = parseInt(readFileSync(counterPath, 'utf-8').trim(), 10);
  if (!Number.isInteger(current)) return null;
  writeFileSync(counterPath, `${current + 1}\n`, 'utf-8');
  return `c-${String(current).padStart(6, '0')}`;
}

/** Turn [[slug]] / [[slug|label]] links to pages that don't exist into plain text. */
function unlinkUnknown(markdown: string, known: Set<string>): string {
  return markdown.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (link, target: string, label?: string) => {
    const slug = target.trim();
    if (known.has(slug) || slug.startsWith('.raw/')) return link;
    return label ?? slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  });
}

/** Remove a `## Heading` section (heading through the line before the next `## `). */
function stripSection(markdown: string, heading: string): string {
  return markdown.replace(new RegExp(`^## ${heading}\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, 'gm'), '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fix known speech-to-text errors in everything the LLM produced, before any page or slug
 * is derived from it. Slugs get the kebab-case form of each correction.
 */
export function applyCorrections(processed: ProcessedMeeting): ProcessedMeeting {
  const pairs = Object.entries(loadCorrections());
  if (pairs.length === 0) return processed;
  const fixText = (text: string) =>
    pairs.reduce((t, [from, to]) => t.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, 'g'), to), text);
  const fixSlug = (slug: string) =>
    pairs.reduce(
      (s, [from, to]) => s.replace(new RegExp(`(^|-)${escapeRegExp(slugify(from))}(?=-|$)`, 'g'), `$1${slugify(to)}`),
      slug,
    );
  // Prose and wikilink targets both carry the error
  const fixMarkdown = (text: string) =>
    fixText(text).replace(/\[\[([^\]|#]+)/g, (_m, target: string) => `[[${fixSlug(target.trim())}`);
  return {
    ...processed,
    meetingNote: fixMarkdown(processed.meetingNote),
    conceptNotes: processed.conceptNotes.map((c) => ({
      slug: fixSlug(c.slug),
      title: fixText(c.title),
      content: fixMarkdown(c.content),
    })),
    entities: processed.entities.map((e) => ({
      ...e,
      slug: fixSlug(e.slug),
      name: fixText(e.name),
      role: e.role ? fixText(e.role) : e.role,
      description: fixMarkdown(e.description),
    })),
  };
}

/** First paragraph of the LLM meeting note's `## Summary` section, for hot.md. */
function meetingSummary(meetingNote: string): string {
  const section = meetingNote.match(/^## Summary\n+([\s\S]*?)(?=\n## |\n*$)/m)?.[1] ?? '';
  return section.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
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

function buildMeetingPage(processed: ProcessedMeeting, known: Set<string>, sourceSlug: string): string {
  const { meeting, meetingNote, conceptNotes, entities } = processed;
  const parsed = parseMeetingNoteFrontmatter(meetingNote);
  const meta = parsed.meta;
  // The LLM writes its own Related section; fold its links into the single one built below
  const llmRelated = [...(parsed.body.match(/^## Related\n[\s\S]*?(?=^## |(?![\s\S]))/m)?.[0] ?? '').matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1]);
  const body = unlinkUnknown(stripSection(parsed.body, 'Related'), known).trim();
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
  fm.push(`source_page: "[[${sourceSlug}]]"`);
  fm.push('---');

  const relatedSlugs = [
    ...new Set([...conceptNotes.map((c) => c.slug), ...entities.map((e) => e.slug), ...llmRelated]),
  ].filter((s) => known.has(s));
  const related = relatedSlugs.map((s) => `- [[${s}]]`);

  const parts = [fm.join('\n'), '', body];
  if (related.length > 0) {
    parts.push('', '## Related', '', ...related);
  }
  parts.push('');

  return parts.join('\n');
}

function buildSourcePage(processed: ProcessedMeeting, rawRelPath: string, meetingSlug: string): string {
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
    `Meeting on ${date}: [[${meetingSlug}|${meeting.title.replace(/[|[\]]/g, '')}]].`,
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

function buildEntityPage(entity: Entity, meetingSlug: string): string {
  const address = allocateAddress();
  const fm = [
    '---',
    // Vault convention: people are `type: person`; orgs/products/repos are `type: entity`
    `type: ${entity.entity_type === 'person' ? 'person' : 'entity'}`,
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
  fm.push(`  - "[[${meetingSlug}]]"`);
  fm.push('---');

  const body = [
    '',
    `# ${entity.name}`,
    '',
    entity.description,
    '',
    '## Mentioned In',
    '',
    `- [[${meetingSlug}]]`,
    '',
  ];

  return fm.join('\n') + '\n' + body.join('\n');
}

/** LLM concept content minus frontmatter, any leading H1s, and any Mentioned In section. */
function conceptBody(concept: ConceptNote): string {
  return stripSection(concept.content.replace(/^---\n[\s\S]*?\n---\n?/, ''), 'Mentioned In')
    .replace(/^(\s*#\s+.+\n+)+/, '')
    .trim();
}

function buildConceptPage(concept: ConceptNote, meetingSlug: string): string {
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
  fm.push(`  - "[[${meetingSlug}]]"`);
  fm.push('---');

  const body = [
    '',
    `# ${concept.title}`,
    '',
    conceptBody(concept),
    '',
    '## Mentioned In',
    '',
    `- [[${meetingSlug}]]`,
    '',
  ];

  return fm.join('\n') + '\n' + body.join('\n');
}

/**
 * Add what this meeting says to an existing entity/concept page: an `## Update (date)`
 * section before Mentioned In, plus a Mentioned In link to the meeting.
 */
function updateExistingPage(relPath: string, meetingSlug: string, update: string): boolean {
  const absPath = join(VAULT_PATH, relPath);
  if (!existsSync(absPath)) return false;
  const content = readFileSync(absPath, 'utf-8');
  const mentionLink = `- [[${meetingSlug}]]`;
  if (content.includes(mentionLink)) return false;

  // The update is body text only: a leading H1 would read as a second page title
  const text = update.replace(/^(\s*#\s+.+\n+)+/, '').trim();
  const updateSection = text ? `## Update (${today()})\n\n${text}\n\n` : '';
  const mentionIdx = content.search(/^## Mentioned In\n/m);
  let updated: string;
  if (mentionIdx === -1) {
    updated = `${content.trimEnd()}\n\n${updateSection}## Mentioned In\n\n${mentionLink}\n`;
  } else {
    const before = content.slice(0, mentionIdx);
    const mentions = content.slice(mentionIdx).trimEnd();
    updated = `${before}${updateSection}${mentions}\n${mentionLink}\n`;
  }

  updated = updated.replace(/^updated: .*$/m, `updated: ${today()}`);
  writeFileSync(absPath, updated, 'utf-8');
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

function updateLog(processed: ProcessedMeeting, result: IngestResult, rawRelPath: string): void {
  const { pagesCreated, pagesUpdated, unresolved } = result;
  const logPath = join(VAULT_PATH, 'wiki/log.md');
  if (!existsSync(logPath)) {
    writeFileSync(logPath, '---\ntype: meta\ntitle: Log\n---\n\n# Ingest Log\n\n', 'utf-8');
  }

  const content = readFileSync(logPath, 'utf-8');
  const date = today();
  // List each link once
  const links = (paths: string[]) =>
    [...new Set(paths.map((p) => `[[${p.replace(/\.md$/, '').split('/').pop()}]]`))].join(', ');

  const entry = [
    `## [${date}] ingest | ${processed.meeting.title}`,
    `- Source: \`${rawRelPath}\``,
    `- Pages created: ${links(pagesCreated)}`,
    pagesUpdated.length > 0 ? `- Pages updated: ${links(pagesUpdated)}` : null,
    unresolved.length > 0 ? `- Unresolved (plain text, no page): ${unresolved.join(', ')}` : null,
    '',
  ].filter((l) => l !== null).join('\n');

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
  const meetingPage = pagesCreated.find((p) => p.startsWith('wiki/meetings/'));
  const summary = meetingSummary(processed.meetingNote);

  const section = [
    `## Last Ingest: ${date} (Granola: ${processed.meeting.title})`,
    '',
    summary ? `${meetingPage ? `[[${meetingPage.split('/').pop()!.replace(/\.md$/, '')}]]: ` : ''}${summary}` : null,
    summary ? '' : null,
    `- ${pagesCreated.length} pages created`,
    entities ? `- Entities: ${entities}` : null,
    concepts ? `- Concepts: ${concepts}` : null,
    '',
    '---',
    '',
    '',
  ].filter((l) => l !== null).join('\n');

  if (!existsSync(hotPath)) {
    const seed = `---\ntype: meta\ntitle: Hot Cache\n---\n\n# Recent Context\n\n${section}`;
    writeFileSync(hotPath, seed, 'utf-8');
    return;
  }

  // hot.md is hand-curated: insert newest-first under its first H1 (whatever it is
  // called) and never truncate. Its size is managed by hand, not by line count.
  const content = readFileSync(hotPath, 'utf-8');
  const fm = content.match(/^---\n[\s\S]*?\n---\n/);
  const bodyStart = fm ? fm[0].length : 0;
  const h1 = /^# .*\n+/m.exec(content.slice(bodyStart));
  const insertAt = h1 ? bodyStart + h1.index + h1[0].length : content.length;
  const prefix = h1 ? '' : '\n';
  // Demote the previous newest entry, matching the vault's hand-written convention
  const rest = content.slice(insertAt).replace(/^## Last Ingest:/m, '## Previous Ingest:');

  writeFileSync(hotPath, content.slice(0, insertAt) + prefix + section + rest, 'utf-8');
}

export function wikiIngest(
  llmOutput: ProcessedMeeting,
  opts: { dryRun?: boolean } = {},
): IngestResult {
  const processed = applyCorrections(llmOutput);
  const { meeting, conceptNotes, entities } = processed;
  const date = meeting.createdAt.split('T')[0];
  const slug = slugify(meeting.title);
  const rawFilename = `${date}-${slug}.md`;
  const rawRelPath = `.raw/transcripts/${rawFilename}`;

  const result: IngestResult = {
    sourcePath: rawRelPath,
    pagesCreated: [],
    pagesUpdated: [],
    unresolved: [],
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

  const meetingSlug = `${date}-${slug}`;
  // Distinct basename so [[meetingSlug]] always resolves to the meeting page
  const sourceSlug = `${meetingSlug}-source`;

  // Resolve entities against existing entity or concept pages before writing anything,
  // so no first-name, flat, or cross-folder duplicates get created
  const entityPlan: Array<{ entity: Entity; path: string; exists: boolean }> = [];
  for (const entity of entities) {
    const existing = findPagePath(entity.slug);
    if (existing) entityPlan.push({ entity, path: existing, exists: true });
    else if (isFirstNameOnly(entity)) result.unresolved.push(entity.name);
    else entityPlan.push({ entity, path: newEntityPath(entity), exists: false });
  }
  const resolved: ProcessedMeeting = { ...processed, entities: entityPlan.map((p) => p.entity) };

  // Links may only point at pages that exist or are being created now
  const known = allWikiSlugs();
  known.add(meetingSlug);
  known.add(sourceSlug);
  for (const e of resolved.entities) known.add(e.slug);
  for (const c of conceptNotes) known.add(c.slug);

  // Meeting page
  const meetingPath = `wiki/meetings/${meetingSlug}.md`;
  if (writePage(meetingPath, buildMeetingPage(resolved, known, sourceSlug))) {
    result.pagesCreated.push(meetingPath);
  }

  // Source page
  const sourcePath = `wiki/sources/${sourceSlug}.md`;
  if (writePage(sourcePath, buildSourcePage(resolved, rawRelPath, meetingSlug))) {
    result.pagesCreated.push(sourcePath);
  }

  // Entity pages
  for (const { entity, path, exists } of entityPlan) {
    const clean = { ...entity, description: unlinkUnknown(entity.description, known) };
    if (exists) {
      if (updateExistingPage(path, meetingSlug, clean.description)) result.pagesUpdated.push(path);
    } else if (writePage(path, buildEntityPage(clean, meetingSlug))) {
      result.pagesCreated.push(path);
    }
  }

  // Concept pages
  for (const concept of conceptNotes) {
    const clean = { ...concept, content: unlinkUnknown(concept.content, known) };
    const existing = findPagePath(concept.slug);
    if (existing) {
      if (updateExistingPage(existing, meetingSlug, conceptBody(clean))) result.pagesUpdated.push(existing);
    } else {
      const conceptPath = `wiki/concepts/${concept.slug}.md`;
      if (writePage(conceptPath, buildConceptPage(clean, meetingSlug))) result.pagesCreated.push(conceptPath);
    }
  }

  // Meta updates
  updateIndex(result.pagesCreated);
  updateLog(resolved, result, rawRelPath);
  updateHot(resolved, result.pagesCreated);

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

/**
 * After a raw source is refreshed from Granola, re-record its hash so the
 * next ingest still treats it as done instead of regenerating wiki pages.
 */
export function recordRawRefresh(rawRelPath: string): boolean {
  const manifest = loadManifest();
  const entry = manifest.sources[rawRelPath];
  const rawAbsPath = join(VAULT_PATH, rawRelPath);
  if (!entry || !existsSync(rawAbsPath)) return false;
  entry.hash = md5(readFileSync(rawAbsPath, 'utf-8'));
  entry.refreshed_at = today();
  saveManifest(manifest);
  return true;
}
