import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MeetingDetail, ProcessedMeeting, ConceptNote, Entity } from './types.js';

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

function formatInput(meeting: MeetingDetail): string {
  const parts = [
    `Meeting ID: ${meeting.id}`,
    `Title: ${meeting.title}`,
    `Date: ${meeting.createdAt.split('T')[0]}`,
  ];

  if (meeting.notes.trim()) {
    parts.push(`\n## Notes\n${meeting.notes}`);
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
}

function parseResponse(text: string): LLMOutput {
  const cleaned = text
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();

  let parsed: LLMOutput;
  try {
    parsed = JSON.parse(cleaned) as LLMOutput;
  } catch (err) {
    const pos = (err instanceof SyntaxError && 'position' in err) ? (err as SyntaxError & { position?: number }).position ?? -1 : -1;
    const snippet = pos >= 0 ? cleaned.slice(Math.max(0, pos - 80), pos + 80) : cleaned.slice(0, 200);
    throw new Error(`Claude response is not valid JSON near position ${pos}:\n${snippet}\n\nFull response length: ${cleaned.length} chars`);
  }

  if (typeof parsed.meetingNote !== 'string') throw new Error('Response missing meetingNote');
  if (!Array.isArray(parsed.conceptNotes)) throw new Error('Response missing conceptNotes');
  if (!Array.isArray(parsed.entities)) parsed.entities = [];

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
  };
}
