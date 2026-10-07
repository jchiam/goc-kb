import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Entity } from './types.js';

const VAULT_PATH = process.env.VAULT_PATH ?? process.env.OBSIDIAN_VAULT_PATH ?? '/vault';

/** Vault convention: entities live in typed sub-folders under wiki/entities/. */
const ENTITY_DIRS: Record<Entity['entity_type'], string> = {
  person: 'people',
  organization: 'orgs',
  product: 'products',
  repository: 'repos',
};

export interface RosterPage {
  slug: string;
  title: string;
  /** vault-relative path */
  path: string;
  /** frontmatter `role:`, else the first body sentence; lets the LLM tell same-named pages apart */
  gloss: string;
  aliases: string[];
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) return walk(abs);
    return name.endsWith('.md') && !name.startsWith('_') ? [abs] : [];
  });
}

const GLOSS_MAX = 120;

function readPageMeta(absPath: string, slug: string): Pick<RosterPage, 'title' | 'gloss' | 'aliases'> {
  const head = readFileSync(absPath, 'utf-8').slice(0, 4000);
  const fm = head.match(/^---\n([\s\S]*?)\n---\n?/);
  const fmText = fm?.[1] ?? '';
  const body = fm ? head.slice(fm[0].length) : head;

  const fmTitle = fmText.match(/^title:\s*"?(.+?)"?\s*$/m);
  const h1 = body.match(/^# (.+)$/m);
  const title = fmTitle ? fmTitle[1] : h1 ? h1[1].trim() : slug;

  const aliasBlock = fmText.match(/^aliases:\n((?:[ \t]+- .+\n?)+)/m)?.[1] ?? '';
  const aliases = [...aliasBlock.matchAll(/^[ \t]+- "?(.+?)"?\s*$/gm)].map((m) => m[1]);

  // First prose paragraph after the H1, skipping headings, callouts and lists
  const firstPara = body
    .replace(/^# .+$/m, '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !/^[#>-]/.test(p));
  const flat = firstPara?.replace(/\s+/g, ' ') ?? '';
  const firstSentence = flat.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? flat;
  const role = fmText.match(/^role:\s*"?(.+?)"?\s*$/m)?.[1];
  const gloss = (role ?? firstSentence)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => label ?? target)
    .slice(0, GLOSS_MAX);

  return { title, gloss, aliases };
}

function roster(subdir: string): RosterPage[] {
  return walk(join(VAULT_PATH, subdir)).map((abs) => {
    const slug = abs.split('/').pop()!.replace(/\.md$/, '');
    return { slug, ...readPageMeta(abs, slug), path: relative(VAULT_PATH, abs) };
  });
}

export function entityRoster(): RosterPage[] {
  return roster('wiki/entities');
}

export function conceptRoster(): RosterPage[] {
  return roster('wiki/concepts');
}

/** Slugs of every wiki page, for deciding whether a [[wikilink]] resolves. */
export function allWikiSlugs(): Set<string> {
  return new Set(walk(join(VAULT_PATH, 'wiki')).map((abs) => abs.split('/').pop()!.replace(/\.md$/, '')));
}

/** Existing entity page for a slug in any entities sub-folder (or legacy flat path). */
export function findEntityPath(slug: string): string | null {
  return entityRoster().find((p) => p.slug === slug)?.path ?? null;
}

/**
 * Existing entity or concept page for a slug. Slugs must be unique across the vault, so a
 * concept must not be created where an entity already exists (and vice versa).
 */
export function findPagePath(slug: string): string | null {
  return [...entityRoster(), ...conceptRoster()].find((p) => p.slug === slug)?.path ?? null;
}

/**
 * Known speech-to-text errors, e.g. { "Ufin": "Ufinity" }, kept in the vault so they can be
 * edited without a code change. Keys match whole words, case-sensitively.
 */
export function loadCorrections(): Record<string, string> {
  const path = join(VAULT_PATH, '.vault-meta/transcription-corrections.json');
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>;
}

export function newEntityPath(entity: Entity): string {
  return `wiki/entities/${ENTITY_DIRS[entity.entity_type] ?? 'orgs'}/${entity.slug}.md`;
}

/** People must be linked by full-name slug; a bare first name is ambiguous. */
export function isFirstNameOnly(entity: Entity): boolean {
  return entity.entity_type === 'person' && !entity.slug.includes('-');
}

/** The person whose vault this is; meetings are recorded from their side. */
export function vaultOwner(): { name: string; aliases: string[] } {
  const name = process.env.VAULT_OWNER ?? '';
  const aliases = (process.env.VAULT_OWNER_ALIASES ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  return { name, aliases };
}

/** Lowercase, drop "(MOE)"-style suffixes, treat `_` and `.` as spaces: "Keng Wee LEE (MOE)" → "keng wee lee". */
export function normName(name: string): string {
  return name
    .replace(/\(.*?\)/g, '')
    .replace(/[_.]/g, ' ')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function personNames(page: RosterPage): string[] {
  return [page.title, ...page.aliases].map(normName);
}

function personRoster(): RosterPage[] {
  return entityRoster().filter((p) => p.path.startsWith('wiki/entities/people/'));
}

/** Person page whose title or alias exactly matches a Granola attendee name, else null. */
export function resolvePersonName(name: string): RosterPage | null {
  const target = normName(name);
  if (!target) return null;
  return personRoster().find((p) => personNames(p).includes(target)) ?? null;
}

/** Person pages whose title or alias starts with this first name, e.g. "Darren" → darren-lee, darren-yeo. */
export function peopleWithFirstName(firstName: string): RosterPage[] {
  const target = normName(firstName);
  if (!target || target.includes(' ')) return [];
  return personRoster().filter((p) => personNames(p).some((n) => n.split(' ')[0] === target));
}
