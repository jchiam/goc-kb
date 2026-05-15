import { execSync } from 'node:child_process';

const VAULT_PATH = process.env.VAULT_PATH ?? process.env.OBSIDIAN_VAULT_PATH ?? '/vault';
const RCLONE_DEST = process.env.RCLONE_DEST;

export function syncVault(dryRun = false): void {
  if (!RCLONE_DEST) {
    console.warn('RCLONE_DEST not set — skipping sync');
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] Would sync: ${VAULT_PATH} → ${RCLONE_DEST}`);
    return;
  }

  console.log(`Syncing ${VAULT_PATH} → ${RCLONE_DEST}`);
  execSync(`rclone sync "${VAULT_PATH}" "${RCLONE_DEST}" --stats-one-line -v`, { stdio: 'inherit' });
  console.log('Sync complete');
}
