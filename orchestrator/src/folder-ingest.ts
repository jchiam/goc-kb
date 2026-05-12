import { readdirSync, readFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { MeetingDetail } from './types.js';

const SETTLE_MS = 30_000;

export function scanFolder(folderPath: string): MeetingDetail[] {
  const now = Date.now();
  const files = readdirSync(folderPath).filter((f) => {
    if (!f.endsWith('.md')) return false;
    const mtime = statSync(join(folderPath, f)).mtimeMs;
    return now - mtime > SETTLE_MS;
  });

  const results: MeetingDetail[] = [];
  for (const file of files) {
    const content = readFileSync(join(folderPath, file), 'utf-8');
    const detail = parseMarkdownToDetail(file, content);
    if (detail) results.push(detail);
  }
  return results;
}

function parseMarkdownToDetail(filename: string, content: string): MeetingDetail | null {
  const slug = basename(filename, '.md');
  const id = `file-${slug}`;
  let title = slug.replace(/-/g, ' ');
  let createdAt = new Date().toISOString();
  let notes = content;

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const titleMatch = fm.match(/^title:\s*(.+)$/m);
    const dateMatch = fm.match(/^date:\s*(.+)$/m);
    if (titleMatch) title = titleMatch[1].replace(/^["']|["']$/g, '');
    if (dateMatch) createdAt = new Date(dateMatch[1]).toISOString();
    notes = fmMatch[2];
  } else {
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) title = h1Match[1];
  }

  if (!notes.trim()) return null;

  return { id, title, createdAt, notes: notes.trim(), transcript: '' };
}

export function markProcessed(folderPath: string, filename: string): void {
  const processedDir = join(folderPath, 'processed');
  mkdirSync(processedDir, { recursive: true });
  renameSync(join(folderPath, filename), join(processedDir, filename));
}
