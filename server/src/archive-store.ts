import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

type Db = InstanceType<typeof Database>;
export interface ArchiveChunk {
  id: string; channelId: string; start: number; end: number; duration: number;
  path: string; size: number; epoch: number; unavailable?: number;
  playbackPath?: string | null; playbackSize?: number; playbackOffset?: number;
  playbackDuration?: number | null; playbackHidden?: number;
}
export interface ArchiveRow {
  channelId: string; channelName: string; enabled: number; retentionHours: number;
  status: string; error: string | null; lastPublishedAt: number | null;
  // Counts are retry attempts, not proven successful restarts. A recovery is
  // confirmed only when a replacement writer publishes a new indexed chunk.
  autoRestartCount: number; stalledRestartCount: number;
  lastAutoRestartAt: number | null; lastStalledRestartAt: number | null;
  lastAutoRestartReason: string | null;
  lastRecoveredRestartCount: number; lastRecoveredAt: number | null;
}
export interface ArchiveSnapshot {
  id: string; channelId: string; startTime: number; endTime: number;
  expiresAt: number; createdAt: number; chunks: ArchiveChunk[];
}

/** Only additive tables; never migrate or remove legacy recording media. */
export function ensureArchiveSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_archives (
      channelId TEXT PRIMARY KEY, channelName TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
      retentionHours INTEGER NOT NULL DEFAULT 24, status TEXT NOT NULL DEFAULT 'stopped',
      error TEXT, lastPublishedAt INTEGER,
      autoRestartCount INTEGER NOT NULL DEFAULT 0, stalledRestartCount INTEGER NOT NULL DEFAULT 0,
      lastAutoRestartAt INTEGER, lastStalledRestartAt INTEGER, lastAutoRestartReason TEXT,
      lastRecoveredRestartCount INTEGER NOT NULL DEFAULT 0, lastRecoveredAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS media_chunks (
      id TEXT PRIMARY KEY, channelId TEXT NOT NULL, start INTEGER NOT NULL,
      end INTEGER NOT NULL, duration REAL NOT NULL, path TEXT NOT NULL UNIQUE,
      size INTEGER NOT NULL, epoch INTEGER NOT NULL,
      CHECK(end > start AND duration > 0 AND size > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_media_chunks_channel_time ON media_chunks(channelId,start,end);
    CREATE TABLE IF NOT EXISTS archive_publication_cursors (
      session TEXT PRIMARY KEY, sequence INTEGER NOT NULL, end INTEGER NOT NULL, epoch INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recording_chunk_refs (
      recordingId TEXT NOT NULL, chunkId TEXT NOT NULL REFERENCES media_chunks(id),
      PRIMARY KEY(recordingId,chunkId)
    );
    CREATE INDEX IF NOT EXISTS idx_recording_chunk_refs_chunk ON recording_chunk_refs(chunkId);
    CREATE TABLE IF NOT EXISTS archive_snapshots (
      id TEXT PRIMARY KEY, channelId TEXT NOT NULL, startTime INTEGER NOT NULL,
      endTime INTEGER NOT NULL, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archive_snapshots_expiry ON archive_snapshots(expiresAt);
    CREATE TABLE IF NOT EXISTS archive_snapshot_chunks (
      snapshotId TEXT NOT NULL REFERENCES archive_snapshots(id),
      chunkId TEXT NOT NULL REFERENCES media_chunks(id), ordinal INTEGER NOT NULL,
      playbackPath TEXT, playbackSize INTEGER NOT NULL DEFAULT 0,
      playbackOffset REAL NOT NULL DEFAULT 0, playbackDuration REAL,
      PRIMARY KEY(snapshotId,chunkId)
    );
    CREATE INDEX IF NOT EXISTS idx_archive_snapshot_chunks_chunk ON archive_snapshot_chunks(chunkId);
    CREATE TABLE IF NOT EXISTS archive_program_history (
      programId INTEGER PRIMARY KEY, channelId TEXT NOT NULL, title TEXT NOT NULL,
      startTime INTEGER NOT NULL, endTime INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archive_program_history_time ON archive_program_history(channelId,startTime,endTime);
  `);
  if (!(db.pragma('table_info(archive_snapshots)') as Array<{ name: string }>).some(c => c.name === 'createdAt')) {
    db.exec('ALTER TABLE archive_snapshots ADD COLUMN createdAt INTEGER NOT NULL DEFAULT 0');
  }
  if (!(db.pragma('table_info(media_chunks)') as Array<{ name: string }>).some(c => c.name === 'unavailable')) {
    db.exec('ALTER TABLE media_chunks ADD COLUMN unavailable INTEGER NOT NULL DEFAULT 0');
  }
  const mediaColumns = new Set((db.pragma('table_info(media_chunks)') as Array<{ name: string }>).map(c => c.name));
  for (const [name, definition] of [
    ['playbackPath', 'TEXT'], ['playbackSize', 'INTEGER NOT NULL DEFAULT 0'],
    ['playbackOffset', 'REAL NOT NULL DEFAULT 0'], ['playbackDuration', 'REAL'],
    ['playbackHidden', 'INTEGER NOT NULL DEFAULT 0'],
  ] as const) if (!mediaColumns.has(name)) db.exec(`ALTER TABLE media_chunks ADD COLUMN ${name} ${definition}`);
  const snapshotColumns = new Set((db.pragma('table_info(archive_snapshot_chunks)') as Array<{ name: string }>).map(c => c.name));
  for (const [name, definition] of [
    ['playbackPath', 'TEXT'], ['playbackSize', 'INTEGER NOT NULL DEFAULT 0'],
    ['playbackOffset', 'REAL NOT NULL DEFAULT 0'], ['playbackDuration', 'REAL'],
  ] as const) if (!snapshotColumns.has(name)) db.exec(`ALTER TABLE archive_snapshot_chunks ADD COLUMN ${name} ${definition}`);
  const archiveColumns = new Set((db.pragma('table_info(channel_archives)') as Array<{ name: string }>).map(c => c.name));
  for (const [name, definition] of [
    ['autoRestartCount', 'INTEGER NOT NULL DEFAULT 0'],
    ['stalledRestartCount', 'INTEGER NOT NULL DEFAULT 0'],
    ['lastAutoRestartAt', 'INTEGER'],
    ['lastStalledRestartAt', 'INTEGER'],
    ['lastAutoRestartReason', 'TEXT'],
    ['lastRecoveredRestartCount', 'INTEGER NOT NULL DEFAULT 0'],
    ['lastRecoveredAt', 'INTEGER'],
  ] as const) {
    if (!archiveColumns.has(name)) db.exec(`ALTER TABLE channel_archives ADD COLUMN ${name} ${definition}`);
  }
  // Seed once during migration; triggers maintain the quota in O(1) per chunk
  // instead of scanning every indexed segment on each capture poll.
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_storage_usage (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), bytes INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO archive_storage_usage(singleton,bytes)
      SELECT 1, COALESCE(SUM(size + playbackSize),0) FROM media_chunks WHERE unavailable = 0;
    DROP TRIGGER IF EXISTS archive_usage_insert;
    DROP TRIGGER IF EXISTS archive_usage_delete;
    DROP TRIGGER IF EXISTS archive_usage_update;
    CREATE TRIGGER archive_usage_insert AFTER INSERT ON media_chunks
      WHEN NEW.unavailable = 0 BEGIN
      UPDATE archive_storage_usage SET bytes = bytes + NEW.size + NEW.playbackSize WHERE singleton = 1;
    END;
    CREATE TRIGGER archive_usage_delete AFTER DELETE ON media_chunks
      WHEN OLD.unavailable = 0 BEGIN
      UPDATE archive_storage_usage SET bytes = bytes - OLD.size - OLD.playbackSize WHERE singleton = 1;
    END;
    CREATE TRIGGER archive_usage_update AFTER UPDATE OF size,unavailable,playbackSize ON media_chunks BEGIN
      UPDATE archive_storage_usage SET bytes = bytes - CASE WHEN OLD.unavailable = 0 THEN OLD.size + OLD.playbackSize ELSE 0 END
        + CASE WHEN NEW.unavailable = 0 THEN NEW.size + NEW.playbackSize ELSE 0 END WHERE singleton = 1;
    END;
  `);
}

export function createArchiveStore(db: Db) {
  const chunks = (sql: string, ...params: (string | number)[]) => db.prepare(sql).all(...params) as ArchiveChunk[];
  const getChunk = (id: string) => db.prepare('SELECT * FROM media_chunks WHERE id = ?').get(id) as ArchiveChunk | undefined;
  const getArchive = (channelId: string) => db.prepare('SELECT * FROM channel_archives WHERE channelId = ?').get(channelId) as ArchiveRow | undefined;
  const overlap = (channelId: string, start: number, end: number) => chunks(
    'SELECT * FROM media_chunks WHERE channelId = ? AND unavailable = 0 AND playbackHidden = 0 AND end > ? AND start < ? ORDER BY end,rowid', channelId, start - 1000, end + 1000,
  ).filter(chunk => {
    const playableStart = chunk.start + (chunk.playbackPath ? (chunk.playbackOffset ?? 0) * 1000 : 0);
    const playableEnd = playableStart + (chunk.playbackPath ? (chunk.playbackDuration ?? chunk.duration) : chunk.duration) * 1000;
    return playableEnd > start && playableStart < end;
  });
  const snapshot = (id: string): ArchiveSnapshot | undefined => {
    const row = db.prepare('SELECT * FROM archive_snapshots WHERE id = ?').get(id) as Omit<ArchiveSnapshot, 'chunks'> | undefined;
    if (!row) return undefined;
    const selected = chunks(`SELECT c.id,c.channelId,c.start,c.end,c.duration,c.path,c.size,c.epoch,c.unavailable,
      s.playbackPath,s.playbackSize,s.playbackOffset,s.playbackDuration
      FROM media_chunks c JOIN archive_snapshot_chunks s ON s.chunkId = c.id
      WHERE s.snapshotId = ? AND c.unavailable = 0
      AND (s.playbackPath IS NULL OR s.playbackPath = c.playbackPath)
      ORDER BY s.ordinal`, id);
    const expected = (db.prepare('SELECT COUNT(*) AS count FROM archive_snapshot_chunks WHERE snapshotId = ?')
      .get(id) as { count: number }).count;
    return selected.length === expected && selected.length > 0 ? { ...row, chunks: selected } : undefined;
  };
  return {
    configure(channelId: string, channelName: string, enabled: boolean, retentionHours: number): ArchiveRow {
      if (!Number.isSafeInteger(retentionHours) || retentionHours < 1 || retentionHours > 168) throw new Error('Invalid retention hours');
      db.prepare(`INSERT INTO channel_archives(channelId,channelName,enabled,retentionHours)
        VALUES(?,?,?,?) ON CONFLICT(channelId) DO UPDATE SET channelName=excluded.channelName,
        enabled=excluded.enabled, retentionHours=excluded.retentionHours`).run(channelId, channelName, enabled ? 1 : 0, retentionHours);
      return getArchive(channelId)!;
    },
    getArchive,
    cursor(session: string) {
      return db.prepare('SELECT sequence,end,epoch FROM archive_publication_cursors WHERE session = ?').get(session) as
        { sequence: number; end: number; epoch: number } | undefined;
    },
    archives: () => db.prepare('SELECT * FROM channel_archives ORDER BY channelName').all() as ArchiveRow[],
    setStatus(channelId: string, status: string, error: string | null = null) {
      db.prepare('UPDATE channel_archives SET status = ?, error = ? WHERE channelId = ?').run(status, error, channelId);
    },
    noteAutoRestart(channelId: string, reason: 'stalled' | 'source_exit' | 'storage_low', at: number) {
      db.prepare(`UPDATE channel_archives SET autoRestartCount = autoRestartCount + 1,
        lastAutoRestartAt = ?, lastAutoRestartReason = ?,
        stalledRestartCount = stalledRestartCount + CASE WHEN ? = 'stalled' THEN 1 ELSE 0 END,
        lastStalledRestartAt = CASE WHEN ? = 'stalled' THEN ? ELSE lastStalledRestartAt END
        WHERE channelId = ?`).run(at, reason, reason, reason, at, channelId);
    },
    noteRecovery(channelId: string, at: number) {
      db.prepare(`UPDATE channel_archives SET lastRecoveredRestartCount = autoRestartCount,
        lastRecoveredAt = ? WHERE channelId = ? AND autoRestartCount > lastRecoveredRestartCount`)
        .run(at, channelId);
    },
    publish(chunk: ArchiveChunk): ArchiveChunk {
      db.transaction(() => {
        db.prepare(`INSERT OR IGNORE INTO media_chunks(id,channelId,start,end,duration,path,size,epoch)
          VALUES(@id,@channelId,@start,@end,@duration,@path,@size,@epoch)`).run(chunk);
        const match = /([^/]+)-chunk-(\d{9})\.ts$/.exec(chunk.id);
        if (match) db.prepare(`INSERT INTO archive_publication_cursors(session,sequence,end,epoch) VALUES(?,?,?,?)
          ON CONFLICT(session) DO UPDATE SET sequence=excluded.sequence,end=excluded.end,epoch=excluded.epoch
          WHERE excluded.sequence > archive_publication_cursors.sequence`)
          .run(match[1], Number(match[2]), chunk.end, chunk.epoch);
        db.prepare('UPDATE channel_archives SET lastPublishedAt = MAX(COALESCE(lastPublishedAt,0),?), status = ?, error = NULL WHERE channelId = ?')
          .run(chunk.end, 'capturing', chunk.channelId);
      })();
      return getChunk(chunk.id)!;
    },
    getChunk,
    /** Publish a verified copy without replacing the immutable capture master.
     * A previously issued snapshot or saved show keeps its original media. */
    setPlaybackMedia(id: string, relative: string, size: number, offset: number, duration: number, _now: number): boolean {
      if (!relative.endsWith('.playback.ts') || !Number.isSafeInteger(size) || size <= 0 ||
        !Number.isFinite(offset) || offset <= 0 || !Number.isFinite(duration) || duration <= 0) return false;
      return db.transaction(() => {
        const original = getChunk(id);
        // Each snapshot pins the media choice made at creation. Older archive
        // snapshots and saved recordings retain the raw file while future
        // archive snapshots can use this verified copy.
        if (!original || original.unavailable || original.playbackHidden || original.playbackPath ||
          offset + duration > original.duration + 0.75) return false;
        return db.prepare(`UPDATE media_chunks SET playbackPath = ?, playbackSize = ?, playbackOffset = ?, playbackDuration = ?
          WHERE id = ? AND playbackPath IS NULL AND playbackHidden = 0`).run(relative, size, offset, duration, id).changes === 1;
      }).immediate();
    },
    hidePlaybackDuplicate(id: string): boolean {
      return db.prepare(`UPDATE media_chunks SET playbackHidden = 1 WHERE id = ?
        AND unavailable = 0 AND playbackHidden = 0 AND playbackPath IS NULL`).run(id).changes === 1;
    },
    /** Select previous media by publication end, even when an older chunk
     * was re-indexed after a recovery scan. */
    previousChunk(id: string): ArchiveChunk | undefined {
      return db.prepare(`SELECT p.* FROM media_chunks p JOIN media_chunks c ON c.id = ?
        WHERE p.channelId = c.channelId AND p.unavailable = 0 AND p.playbackHidden = 0
        AND (p.end < c.end OR (p.end = c.end AND p.rowid < c.rowid))
        ORDER BY p.end DESC,p.rowid DESC LIMIT 1`).get(id) as ArchiveChunk | undefined;
    },
    recentViewerWindows(now: number, maxAgeMs: number): Array<{ channelId: string; startTime: number; endTime: number }> {
      return db.prepare(`SELECT DISTINCT channelId,startTime,endTime FROM archive_snapshots
        WHERE createdAt >= ? AND expiresAt > ? ORDER BY createdAt DESC`)
        .all(now - maxAgeMs, now) as Array<{ channelId: string; startTime: number; endTime: number }>;
    },
    seamCandidates(channelId: string, since: number): ArchiveChunk[] {
      return chunks(`SELECT c.* FROM media_chunks c WHERE c.channelId = ? AND c.end > ?
        AND c.unavailable = 0 AND c.playbackHidden = 0 AND c.playbackPath IS NULL
        AND c.id LIKE '%-chunk-000000000.ts'
        ORDER BY c.end,c.rowid`, channelId, since);
    },
    markAvailable(id: string) { db.prepare('UPDATE media_chunks SET unavailable = 0 WHERE id = ? AND unavailable != 0').run(id); },
    reconcilePlaybackMissing(id: string): 'restored_raw' | 'absent' {
      return db.transaction(() => {
        const chunk = getChunk(id);
        if (!chunk?.playbackPath) return 'absent';
        // The captured master is intact. New archive tickets can use it;
        // snapshots bound to the lost derived path become unavailable rather
        // than silently serving mismatched media. Saved shows stay playable.
        db.prepare(`UPDATE media_chunks SET playbackPath = NULL, playbackSize = 0,
          playbackOffset = 0, playbackDuration = NULL, unavailable = 0 WHERE id = ?`).run(id);
        return 'restored_raw';
      }).immediate();
    },
    indexedChunks() { return chunks('SELECT * FROM media_chunks ORDER BY channelId,id'); },
    reconcileMissing(id: string): 'removed' | 'quarantined' | 'absent' {
      return db.transaction(() => {
        if (!getChunk(id)) return 'absent';
        const referenced = db.prepare(`SELECT 1 FROM recording_chunk_refs WHERE chunkId = ? UNION ALL
          SELECT 1 FROM archive_snapshot_chunks WHERE chunkId = ? LIMIT 1`).get(id, id);
        if (referenced) {
          db.prepare('UPDATE media_chunks SET unavailable = 1 WHERE id = ?').run(id);
          return 'quarantined';
        }
        db.prepare('DELETE FROM media_chunks WHERE id = ?').run(id);
        return 'removed';
      }).immediate();
    },
    overlap,
    coverage(channelId: string) {
      return db.prepare(`SELECT
        MIN(CASE WHEN playbackHidden = 0 THEN start +
          CASE WHEN playbackPath IS NOT NULL THEN playbackOffset * 1000 ELSE 0 END END) availableFrom,
        MAX(CASE WHEN playbackHidden = 0 THEN
          CASE WHEN playbackPath IS NOT NULL THEN start + playbackOffset * 1000 +
            COALESCE(playbackDuration, duration) * 1000 ELSE end END END) availableTo,
        COALESCE(SUM(size + playbackSize),0) diskUsageBytes
        FROM media_chunks WHERE channelId = ? AND unavailable = 0`)
        .get(channelId) as { availableFrom: number | null; availableTo: number | null; diskUsageBytes: number };
    },
    totalUsageBytes(): number {
      return (db.prepare('SELECT bytes FROM archive_storage_usage WHERE singleton = 1').get() as { bytes: number }).bytes;
    },
    addRecordingRef(recordingId: string, chunkId: string) {
      db.prepare('INSERT OR IGNORE INTO recording_chunk_refs(recordingId,chunkId) VALUES(?,?)').run(recordingId, chunkId);
    },
    removeRecordingRefs(recordingId: string) {
      db.prepare('DELETE FROM recording_chunk_refs WHERE recordingId = ?').run(recordingId);
    },
    recordingChunks(recordingId: string) {
      return chunks(`SELECT c.* FROM media_chunks c JOIN recording_chunk_refs r ON r.chunkId = c.id
        WHERE r.recordingId = ? AND c.unavailable = 0 ORDER BY c.end,c.rowid`, recordingId);
    },
    createSnapshot(channelId: string, startTime: number, endTime: number, now: number, expiresAt: number): ArchiveSnapshot {
      const id = randomUUID();
      db.transaction(() => {
        const selected = overlap(channelId, startTime, endTime);
        if (!selected.length) throw new Error('No published chunks in this interval');
        db.prepare('INSERT INTO archive_snapshots(id,channelId,startTime,endTime,expiresAt,createdAt) VALUES(?,?,?,?,?,?)').run(id, channelId, startTime, endTime, expiresAt, now);
        const add = db.prepare(`INSERT INTO archive_snapshot_chunks
          (snapshotId,chunkId,ordinal,playbackPath,playbackSize,playbackOffset,playbackDuration)
          VALUES(?,?,?,?,?,?,?)`);
        selected.forEach((c, ordinal) => add.run(id, c.id, ordinal,
          c.playbackPath ?? null, c.playbackSize ?? 0, c.playbackOffset ?? 0, c.playbackDuration ?? null));
      }).immediate();
      return snapshot(id)!;
    },
    createRecordingSnapshot(recordingId: string, channelId: string, startTime: number, endTime: number, now: number, expiresAt: number): ArchiveSnapshot {
      const id = randomUUID();
      db.transaction(() => {
        const selected = chunks(`SELECT c.* FROM media_chunks c JOIN recording_chunk_refs r ON r.chunkId = c.id
          WHERE r.recordingId = ? AND c.channelId = ? AND c.unavailable = 0 ORDER BY c.end,c.rowid`, recordingId, channelId);
        const expected = (db.prepare('SELECT COUNT(*) AS count FROM recording_chunk_refs WHERE recordingId = ?')
          .get(recordingId) as { count: number }).count;
        if (!selected.length || selected.length !== expected) throw new Error('Saved segments are unavailable');
        db.prepare('INSERT INTO archive_snapshots(id,channelId,startTime,endTime,expiresAt,createdAt) VALUES(?,?,?,?,?,?)')
          .run(id, channelId, startTime, endTime, expiresAt, now);
        // Saved shows keep the captured master, even if the archive has a
        // trimmed presentation copy of the same indexed chunk.
        const add = db.prepare(`INSERT INTO archive_snapshot_chunks
          (snapshotId,chunkId,ordinal,playbackPath,playbackSize,playbackOffset,playbackDuration)
          VALUES(?,?,?,NULL,0,0,NULL)`);
        selected.forEach((c, ordinal) => add.run(id, c.id, ordinal));
      }).immediate();
      return snapshot(id)!;
    },
    snapshot,
    renewSnapshot(id: string, now: number, leaseMs: number, maxLifetimeMs: number): ArchiveSnapshot | undefined {
      const changed = db.prepare(`UPDATE archive_snapshots SET expiresAt = MIN(?, createdAt + ?)
        WHERE id = ? AND expiresAt > ? AND createdAt + ? > ?`).run(now + leaseMs, maxLifetimeMs, id, now, maxLifetimeMs, now);
      return changed.changes ? snapshot(id) : undefined;
    },
    clearExpired(now: number) {
      db.transaction(() => {
        db.prepare('DELETE FROM archive_snapshot_chunks WHERE snapshotId IN (SELECT id FROM archive_snapshots WHERE expiresAt <= ?)').run(now);
        db.prepare('DELETE FROM archive_snapshots WHERE expiresAt <= ?').run(now);
      })();
    },
    prunable(channelId: string, cutoff: number, now: number) {
      return chunks(`SELECT c.* FROM media_chunks c WHERE c.channelId = ? AND c.end <= ?
        AND NOT EXISTS (SELECT 1 FROM recording_chunk_refs r WHERE r.chunkId = c.id)
        AND NOT EXISTS (SELECT 1 FROM archive_snapshot_chunks sc JOIN archive_snapshots s ON s.id = sc.snapshotId
          WHERE sc.chunkId = c.id AND s.expiresAt > ?) ORDER BY c.end,c.id`, channelId, cutoff, now);
    },
    /** IMMEDIATE locks out other SQLite connections until eligibility, unlink and
     * index deletion finish. A snapshot cannot pin after the final check. */
    pruneChunk(channelId: string, id: string, now: number, unlink: (chunk: ArchiveChunk) => void): boolean {
      return db.transaction(() => {
        const policy = getArchive(channelId);
        if (!policy) return false;
        const cutoff = now - policy.retentionHours * 3_600_000;
        const candidate = chunks(`SELECT c.* FROM media_chunks c WHERE c.id = ? AND c.channelId = ? AND c.end <= ?
          AND NOT EXISTS (SELECT 1 FROM recording_chunk_refs r WHERE r.chunkId = c.id)
          AND NOT EXISTS (SELECT 1 FROM archive_snapshot_chunks sc JOIN archive_snapshots s ON s.id = sc.snapshotId
            WHERE sc.chunkId = c.id AND s.expiresAt > ?)`, id, channelId, cutoff, now)[0];
        if (!candidate) return false;
        unlink(candidate);
        db.prepare('DELETE FROM archive_snapshot_chunks WHERE chunkId = ?').run(id);
        db.prepare('DELETE FROM media_chunks WHERE id = ?').run(id);
        return true;
      }).immediate();
    },
  };
}
export type ArchiveStore = ReturnType<typeof createArchiveStore>;
