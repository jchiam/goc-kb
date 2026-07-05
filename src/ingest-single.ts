import { listMeetings, getMeetingDetail } from './granola-client.js';
import { processMeeting } from './process.js';
import { writeRawSource } from './write.js';
import { wikiIngest } from './wiki-ingest.js';

async function main() {
  const args = process.argv.slice(2);
  const idIdx = args.indexOf('--meeting-id');
  if (idIdx === -1 || !args[idIdx + 1]) {
    console.error('Usage: ingest-single --meeting-id <id> [--dry-run]');
    process.exit(1);
  }

  const meetingId = args[idIdx + 1];
  const dryRun = args.includes('--dry-run');

  // Look back 90 days to find the meeting
  const since = new Date();
  since.setDate(since.getDate() - 90);
  const meetings = await listMeetings(since.toISOString());

  const meeting = meetings.find((m) => m.id === meetingId);
  if (!meeting) {
    console.error(`Meeting ${meetingId} not found in last 90 days`);
    process.exit(1);
  }

  console.error(`Processing: ${meeting.title}`);

  const detail = await getMeetingDetail(meeting);
  const processed = await processMeeting(detail);

  writeRawSource(processed, dryRun);
  const result = wikiIngest(processed, { dryRun });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
