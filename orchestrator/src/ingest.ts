import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import type { State, GranolaMeeting, MeetingDetail, PipelineOptions } from './types.js';
import { processMeeting } from './process.js';
import { writeMeetingNote } from './write.js';
import { syncVault } from './sync.js';

const STATE_FILE = process.env.STATE_FILE ?? '../state/state.json';
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS ?? '30', 10);
const GRANOLA_AUTH_FILE =
  process.env.GRANOLA_SUPABASE_PATH ??
  `${process.env.HOME}/Library/Application Support/Granola/supabase.json`;

function loadState(): State {
  if (!existsSync(STATE_FILE)) {
    const since = new Date();
    since.setDate(since.getDate() - LOOKBACK_DAYS);
    return { lastProcessedAt: since.toISOString(), processedIds: [] };
  }
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as State;
}

function saveState(state: State): void {
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmp, STATE_FILE);
}

function granolaJson(args: string): unknown {
  return JSON.parse(execSync(`granola ${args} -o json`, { encoding: 'utf-8' }));
}

function toDateString(iso: string): string {
  return iso.split('T')[0];
}

function fetchMeetings(since: string): GranolaMeeting[] {
  const result = granolaJson(`meeting list --since "${toDateString(since)}" -l 100`);
  if (!Array.isArray(result)) return [];
  return result as GranolaMeeting[];
}

function fetchMeetingDetail(meeting: GranolaMeeting): MeetingDetail {
  const notes = execSync(`granola meeting notes ${meeting.id} -o markdown`, {
    encoding: 'utf-8',
  });
  const transcript = execSync(`granola meeting transcript ${meeting.id} -o text`, {
    encoding: 'utf-8',
  });
  return {
    id: meeting.id,
    title: meeting.title,
    createdAt: meeting.created_at,
    notes: notes.trim(),
    transcript: transcript.trim(),
  };
}

export async function runPipeline(opts: PipelineOptions = {}): Promise<void> {
  if (!existsSync(GRANOLA_AUTH_FILE)) {
    throw new Error(
      `Granola auth file not found at ${GRANOLA_AUTH_FILE}. ` +
        'Check GRANOLA_SUPABASE_PATH in .env and ensure Granola desktop app is installed and signed in.',
    );
  }

  const { meetingId, dryRun = false } = opts;
  const state = loadState();

  let meetings: GranolaMeeting[];

  if (meetingId) {
    const lookbackMs = 90 * 24 * 60 * 60 * 1000;
    const all = fetchMeetings(new Date(Date.now() - lookbackMs).toISOString().split('T')[0]);
    const target = all.find((m) => m.id === meetingId);
    if (!target) throw new Error(`Meeting ${meetingId} not found in last 90 days`);
    meetings = [target];
  } else {
    meetings = fetchMeetings(state.lastProcessedAt).filter(
      (m) => !state.processedIds.includes(m.id),
    );
  }

  if (meetings.length === 0) {
    console.log('No new meetings to process');
    return;
  }

  console.log(`Processing ${meetings.length} meeting(s)`);
  const runAt = new Date().toISOString();

  for (const meeting of meetings) {
    console.log(`→ ${meeting.title} (${meeting.id})`);
    try {
      const detail = fetchMeetingDetail(meeting);
      const processed = await processMeeting(detail);
      writeMeetingNote(processed, dryRun);

      if (!dryRun) {
        state.processedIds.push(meeting.id);
        if (state.processedIds.length > 500) {
          state.processedIds = state.processedIds.slice(-500);
        }
        state.lastProcessedAt = runAt;
        saveState(state);
      }
    } catch (err) {
      console.error(`Failed: ${meeting.id}`, err);
    }
  }

  syncVault(dryRun);
}
