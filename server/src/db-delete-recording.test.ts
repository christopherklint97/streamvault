// @vitest-environment node
import { expect, it, vi } from 'vitest';

// Never open, validate, quarantine, restore, or back up the on-disk database
// from a test: db.ts runs those steps at import time against server/data.
vi.mock('better-sqlite3', async importOriginal => {
  const Actual = (await importOriginal<typeof import('better-sqlite3')>()).default;
  return { default: class extends Actual { constructor() { super(':memory:'); } } };
});
vi.mock('./db-lifecycle.js', () => ({
  backupDatabaseInWorker: vi.fn(async () => undefined),
  checkDatabaseReadable: () => ({ ok: true }),
  isDatabaseBackupDue: () => false,
  restoreLatestValidBackup: () => null,
}));

it('keeps archive chunk refs when the recording row delete fails', async () => {
  const { default: db, deleteRecording, archiveStore } = await import('./db.js');
  db.prepare(`INSERT INTO recordings (id, channel_id, channel_name, title, status, start_time, end_time, created_at)
    VALUES ('r1', 'c1', 'Channel', 'Show', 'completed', 1, 2, 1)`).run();
  archiveStore.configure('c1', 'Channel', true, 24);
  archiveStore.publish({ id: 'chunk', channelId: 'c1', start: 1, end: 2, duration: 1, path: 'chunk.ts', size: 1, epoch: 1 });
  archiveStore.addRecordingRef('r1', 'chunk');
  db.exec(`CREATE TRIGGER block_delete BEFORE DELETE ON recordings BEGIN SELECT RAISE(ABORT, 'blocked'); END;`);

  expect(() => deleteRecording('r1')).toThrow('blocked');
  expect(archiveStore.recordingChunks('r1').map(chunk => chunk.id)).toEqual(['chunk']);

  db.exec('DROP TRIGGER block_delete');
  deleteRecording('r1');
  expect(archiveStore.recordingChunks('r1')).toEqual([]);
});
