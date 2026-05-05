import cron from 'node-cron';
import { runPipeline } from './ingest.js';

const CRON_SCHEDULE = process.env.CRON_SCHEDULE ?? '0 * * * *';

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const meetingId = getArg('--meeting-id');
const dryRun = hasFlag('--dry-run');
const runOnce = hasFlag('--once');

async function main(): Promise<void> {
  if (meetingId || runOnce) {
    await runPipeline({ meetingId, dryRun });
    return;
  }

  console.log(`Pipeline starting. Schedule: ${CRON_SCHEDULE}`);
  await runPipeline({ dryRun }).catch(console.error);

  cron.schedule(CRON_SCHEDULE, () => {
    runPipeline({ dryRun }).catch(console.error);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
