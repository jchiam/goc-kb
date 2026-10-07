import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MeetingDetail, ProcessedMeeting, ConceptNote, Entity, OwnerCitation } from './types.js';
import { conceptRoster, entityRoster, vaultOwner } from './vault.js';

const client = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL ?? 'bedrock.claude-sonnet-4-6';
const PROMPTS_DIR = join(process.cwd(), 'prompts');

let cachedSystemPrompt: string | null = null;

function getSystemPrompt(): string {
  if (!cachedSystemPrompt) {
    cachedSystemPrompt = readFileSync(join(PROMPTS_DIR, 'meeting-note.md'), 'utf-8');
  }
  return cachedSystemPrompt;
}

/**
 * Existing pages change rarely between meetings, so they go in their own cached system
 * block after the prompt. `gloss` (role or first sentence) is what lets the LLM tell
 * Darren Lee from Darren Yeo, or AOR governance from AO/AOR finance.
 */
function formatRoster(): string {
  const parts: string[] = [];
  const entities = entityRoster();
  if (entities.length > 0) {
    const rows = entities.map((p) =>
      [p.slug, p.title, p.gloss, p.aliases.join('; '), p.path].join(' | '),
    );
    parts.push(`## Existing entity pages (slug | title | role or description | aliases | path)\n${rows.join('\n')}`);
  }
  const concepts = conceptRoster();
  if (concepts.length > 0) {
    parts.push(`## Existing concept pages (slug | title | description)\n${concepts.map((p) => `${p.slug} | ${p.title} | ${p.gloss}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

function formatInput(meeting: MeetingDetail): string {
  const parts = [
    `Meeting ID: ${meeting.id}`,
    `Title: ${meeting.title}`,
    `Date: ${meeting.createdAt.split('T')[0]}`,
  ];

  const owner = vaultOwner();
  if (owner.name) {
    const also = owner.aliases.length > 0 ? ` (also called ${owner.aliases.join(', ')})` : '';
    parts.push(`Vault owner: ${owner.name}${also}`);
  }

  const attendees = [...new Set(meeting.attendees)];
  parts.push(
    attendees.length > 0
      ? `Granola attendees (calendar invite, may include duplicates or omit people): ${attendees.join(', ')}`
      : 'Granola attendees: none recorded',
  );

  if (meeting.notes.trim()) {
    parts.push(`\n## Notes\n${meeting.notes}`);
  }

  if (meeting.summary.trim()) {
    parts.push(`\n## Summary (user-edited)\n${meeting.summary}`);
  }

  if (meeting.transcript.trim()) {
    parts.push(`\n## Transcript\n${meeting.transcript}`);
  }

  return parts.join('\n');
}

interface LLMOutput {
  meetingNote: string;
  conceptNotes: ConceptNote[];
  entities: Entity[];
  inferences?: string[];
  absentInvitees?: string[];
  ownerCitations?: OwnerCitation[];
}

function parseResponse(text: string): LLMOutput {
  const stripped = text
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  // Tolerate prose or a stray fence around the JSON object
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  const cleaned = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;

  let parsed: LLMOutput;
  try {
    parsed = JSON.parse(cleaned) as LLMOutput;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const m = msg.match(/position (\d+)/);
    const pos = m ? Number(m[1]) : -1;
    const snippet = pos >= 0 ? cleaned.slice(Math.max(0, pos - 80), pos + 80) : cleaned.slice(-200);
    throw new Error(`Claude response is not valid JSON (${msg}) near position ${pos}:\n${snippet}\n\nFull response length: ${cleaned.length} chars`);
  }

  if (typeof parsed.meetingNote !== 'string') throw new Error('Response missing meetingNote');
  if (!Array.isArray(parsed.conceptNotes)) throw new Error('Response missing conceptNotes');
  if (!Array.isArray(parsed.entities)) parsed.entities = [];
  if (!Array.isArray(parsed.inferences)) parsed.inferences = [];
  if (!Array.isArray(parsed.absentInvitees)) parsed.absentInvitees = [];
  if (!Array.isArray(parsed.ownerCitations)) parsed.ownerCitations = [];

  return parsed;
}

export async function processMeeting(meeting: MeetingDetail): Promise<ProcessedMeeting> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 12000,
    system: [
      {
        type: 'text',
        text: getSystemPrompt(),
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: formatRoster() || 'No existing pages.',
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: formatInput(meeting),
      },
    ],
  });

  const block = response.content[0];
  if (block.type !== 'text') throw new Error(`Unexpected content type: ${block.type}`);

  const output = parseResponse(block.text);

  return {
    meeting,
    meetingNote: output.meetingNote,
    conceptNotes: output.conceptNotes,
    entities: output.entities,
    inferences: output.inferences ?? [],
    absentInvitees: output.absentInvitees ?? [],
    ownerCitations: output.ownerCitations ?? [],
  };
}
