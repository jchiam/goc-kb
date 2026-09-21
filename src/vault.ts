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
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) return walk(abs);
    return name.endsWith('.md') && !name.startsWith('_') ? [abs] : [];
  });
}

function readTitle(absPath: string, slug: string): string {
  const head = readFileSync(absPath, 'utf-8').slice(0, 2000);
  const fmTitle = head.match(/^title:\s*"?(.+?)"?\s*$/m);
  if (fmTitle) return fmTitle[1];
  const h1 = head.match(/^# (.+)$/m);
  return h1 ? h1[1].trim() : slug;
}

function roster(subdir: string): RosterPage[] {
  return walk(join(VAULT_PATH, subdir)).map((abs) => {
    const slug = abs.split('/').pop()!.replace(/\.md$/, '');
    return { slug, title: readTitle(abs, slug), path: relative(VAULT_PATH, abs) };
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

export function newEntityPath(entity: Entity): string {
  return `wiki/entities/${ENTITY_DIRS[entity.entity_type] ?? 'orgs'}/${entity.slug}.md`;
}

/** People must be linked by full-name slug; a bare first name is ambiguous. */
export function isFirstNameOnly(entity: Entity): boolean {
  return entity.entity_type === 'person' && !entity.slug.includes('-');
}
