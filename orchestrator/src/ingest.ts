import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import type { State, GranolaMeeting, PipelineOptions } from './types.js';
import { listMeetings, getMeetingDetail } from './granola-client.js';
import { processMeeting } from './process.js';
import { writeRawSource } from './write.js';
import { wikiIngest } from './wiki-ingest.js';
import { runCatchup } from './catchup.js';
import { syncVault } from './sync.js';
import { scanFolder, markProcessed } from './folder-ingest.js';

const STATE_FILE = process.env.STATE_FILE ?? '../state/state.json';
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS ?? '30', 10);
const UPDATE_LOOKBACK_DAYS = parseInt(process.env.UPDATE_LOOKBACK_DAYS ?? '7', 10);

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

const WATCH_FOLDER = process.env.WATCH_FOLDER;

export async function runPipeline(opts: PipelineOptions = {}): Promise<void> {
  const { meetingId, dryRun = false } = opts;

  if (WATCH_FOLDER && !meetingId) {
    await runFolderMode(dryRun);
    return;
  }

  const state = loadState();

  let meetings: GranolaMeeting[];

  if (meetingId) {
    const lookbackMs = 90 * 24 * 60 * 60 * 1000;
    const since = new Date(Date.now() - lookbackMs).toISOString();
    const all = await listMeetings(since);
    const target = all.find((m) => m.id === meetingId);
    if (!target) throw new Error(`Meeting ${meetingId} not found in last 90 days`);
    meetings = [target];
  } else {
    const updateHorizon = new Date();
    updateHorizon.setDate(updateHorizon.getDate() - UPDATE_LOOKBACK_DAYS);
    const fetchSince = new Date(
      Math.min(new Date(state.lastProcessedAt).getTime(), updateHorizon.getTime()),
    ).toISOString();
    const all = await listMeetings(fetchSince);
    meetings = all.filter((m) => {
      if (!state.processedIds.includes(m.id)) return true;
      const meta = state.processedMeta?.[m.id];
      if (!meta || !m.updated_at) return false;
      return m.updated_at > meta.updatedAt;
    });
  }

  if (meetings.length === 0) {
    console.log('No new meetings to process');
    return;
  }

  console.log(`Processing ${meetings.length} meeting(s)`);
  const runAt = new Date().toISOString();
  const writtenFiles: string[] = [];

  for (const meeting of meetings) {
    console.log(`→ ${meeting.title} (${meeting.id})`);
    try {
      const detail = await getMeetingDetail(meeting);
      const processed = await processMeeting(detail);
      const written = writeRawSource(processed, dryRun);
      if (written) writtenFiles.push(written);

      try {
        const ingestResult = wikiIngest(processed, { dryRun });
        if (!ingestResult.skipped) {
          console.log(`  Wiki: ${ingestResult.pagesCreated.length} created, ${ingestResult.pagesUpdated.length} updated`);
        }
      } catch (err) {
        console.error(`  Wiki-ingest failed (non-blocking):`, err);
      }

      if (!dryRun) {
        if (!state.processedIds.includes(meeting.id)) {
          state.processedIds.push(meeting.id);
        }
        if (state.processedIds.length > 500) {
          state.processedIds = state.processedIds.slice(-500);
        }
        state.processedMeta = state.processedMeta ?? {};
        state.processedMeta[meeting.id] = {
          updatedAt: meeting.updated_at ?? meeting.created_at,
        };
        const metaIds = Object.keys(state.processedMeta);
        if (metaIds.length > 500) {
          for (const old of metaIds.slice(0, metaIds.length - 500)) {
            delete state.processedMeta[old];
          }
        }
        state.lastProcessedAt = runAt;
        saveState(state);
      }
    } catch (err) {
      console.error(`Failed: ${meeting.id}`, err);
    }
  }

  if (writtenFiles.length > 0) {
    console.log(`\nWrote ${writtenFiles.length} raw source file(s):`);
    for (const f of writtenFiles) console.log(`  ${f}`);
  }

  runCatchup(dryRun);
  syncVault(dryRun);
}

async function runFolderMode(dryRun: boolean): Promise<void> {
  const details = scanFolder(WATCH_FOLDER!);
  if (details.length === 0) {
    console.log('No new files in watch folder');
    return;
  }

  console.log(`Processing ${details.length} file(s) from ${WATCH_FOLDER}`);
  for (const detail of details) {
    console.log(`→ ${detail.title} (${detail.id})`);
    try {
      const processed = await processMeeting(detail);
      writeRawSource(processed, dryRun);
      try {
        const ingestResult = wikiIngest(processed, { dryRun });
        if (!ingestResult.skipped) {
          console.log(`  Wiki: ${ingestResult.pagesCreated.length} created, ${ingestResult.pagesUpdated.length} updated`);
        }
      } catch (err) {
        console.error(`  Wiki-ingest failed (non-blocking):`, err);
      }
      if (!dryRun) {
        const filename = detail.id.replace(/^file-/, '') + '.md';
        markProcessed(WATCH_FOLDER!, filename);
      }
    } catch (err) {
      console.error(`Failed: ${detail.id}`, err);
    }
  }

  runCatchup(dryRun);
  syncVault(dryRun);
}
