import { getMeetingDetail } from './granola-client.js';
import { processMeeting } from './process.js';
import { rawRelPath, readRawUpdatedAt, writeRawSource } from './write.js';
import { recordRawRefresh, wikiIngest } from './wiki-ingest.js';

async function main() {
  const args = process.argv.slice(2);
  const idIdx = args.indexOf('--meeting-id');
  if (idIdx === -1 || !args[idIdx + 1]) {
    console.error('Usage: ingest-single --meeting-id <id> [--refresh] [--dry-run]');
    process.exit(1);
  }

  const meetingId = args[idIdx + 1];
  const dryRun = args.includes('--dry-run');
  const refresh = args.includes('--refresh');

  const detail = await getMeetingDetail(meetingId);
  console.error(`${refresh ? 'Refreshing' : 'Processing'}: ${detail.title}`);

  if (refresh) {
    // Re-fetch Granola content into the raw source only. No LLM call, no wiki page writes:
    // wiki pages are updated by hand from the refreshed source.
    const sourcePath = rawRelPath(detail.title, detail.createdAt);
    const previousUpdatedAt = readRawUpdatedAt(sourcePath);
    writeRawSource(detail, { dryRun, overwrite: true });
    if (!dryRun) recordRawRefresh(sourcePath);
    console.log(
      JSON.stringify({ sourcePath, refreshed: !dryRun, previousUpdatedAt, updatedAt: detail.updatedAt ?? null }, null, 2),
    );
    return;
  }

  const processed = await processMeeting(detail);

  writeRawSource(detail, { dryRun });
  const result = wikiIngest(processed, { dryRun });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
