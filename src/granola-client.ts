import type { GranolaMeeting, MeetingDetail } from './types.js';

const GRANOLA_API = 'https://public-api.granola.ai';
const API_KEY = process.env.GRANOLA_API_KEY;

if (!API_KEY) {
  throw new Error('GRANOLA_API_KEY is required. Generate one in Granola desktop: Settings → API.');
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function apiFetch(path: string, attempt = 0): Promise<unknown> {
  const res = await fetch(`${GRANOLA_API}${path}`, { headers: headers() });

  if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 3) {
    const delay = 250 * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, delay));
    return apiFetch(path, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Granola API GET ${path} failed (${res.status}): ${text}`);
  }

  return res.json();
}

interface ApiNote {
  id: string;
  title: string;
  created_at: string;
  updated_at?: string;
  content_markdown?: string;
  transcript?: Array<{ source: string; diarization_label?: string; text: string; start_timestamp?: string }>;
  attendees?: Array<{ name?: string; email?: string }>;
}

interface ListNotesResponse {
  notes: ApiNote[];
  has_more: boolean;
  next_cursor?: string;
}

export async function listMeetings(since: string, limit = 100): Promise<GranolaMeeting[]> {
  const meetings: GranolaMeeting[] = [];
  let cursor: string | undefined;

  while (meetings.length < limit) {
    const params = new URLSearchParams({
      created_after: since,
      page_size: '30',
    });
    if (cursor) params.set('cursor', cursor);

    const data = (await apiFetch(`/v1/notes?${params}`)) as ListNotesResponse;

    for (const note of data.notes) {
      meetings.push({
        id: note.id,
        title: note.title,
        created_at: note.created_at,
        updated_at: note.updated_at,
      });
    }

    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return meetings.slice(0, limit);
}

export async function getMeetingDetail(meeting: GranolaMeeting): Promise<MeetingDetail> {
  const note = (await apiFetch(`/v1/notes/${meeting.id}?include=transcript`)) as ApiNote;

  const transcript = Array.isArray(note.transcript)
    ? note.transcript
        .map((entry) => {
          const speaker = entry.diarization_label ?? (entry.source === 'microphone' ? 'You' : 'Participant');
          return `${speaker}: ${entry.text}`;
        })
        .join('\n')
    : '';

  return {
    id: note.id,
    title: note.title,
    createdAt: note.created_at,
    notes: (note.content_markdown ?? '').trim(),
    transcript: transcript.trim(),
  };
}
