import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

type Db = InstanceType<typeof Database>;
export interface ArchiveChunk {
  id: string; channelId: string; start: number; end: number; duration: number;
  path: string; size: number; epoch: number; unavailable?: number;
  playbackPath?: string | null; playbackSize?: number; playbackOffset?: number;
  playbackDuration?: number | null; playbackHidden?: number;
  presentationStart?: number | null; pairId?: string | null; pairRole?: string | null;
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
    CREATE TABLE IF NOT EXISTS archive_playback_pairs (
      id TEXT PRIMARY KEY, priorId TEXT NOT NULL UNIQUE REFERENCES media_chunks(id),
      nextId TEXT NOT NULL UNIQUE REFERENCES media_chunks(id), session TEXT NOT NULL UNIQUE,
      shiftMs REAL NOT NULL, priorPath TEXT NOT NULL, nextPath TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS archive_detached_playback (
      path TEXT PRIMARY KEY, size INTEGER NOT NULL CHECK(size > 0)
    );
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
    ['presentationStart', 'REAL'], ['pairId', 'TEXT'], ['pairRole', 'TEXT'],
  ] as const) if (!mediaColumns.has(name)) db.exec(`ALTER TABLE media_chunks ADD COLUMN ${name} ${definition}`);
  const snapshotColumns = new Set((db.pragma('table_info(archive_snapshot_chunks)') as Array<{ name: string }>).map(c => c.name));
  for (const [name, definition] of [
    ['playbackPath', 'TEXT'], ['playbackSize', 'INTEGER NOT NULL DEFAULT 0'],
    ['playbackOffset', 'REAL NOT NULL DEFAULT 0'], ['playbackDuration', 'REAL'],
    ['presentationStart', 'REAL'], ['pairId', 'TEXT'], ['pairRole', 'TEXT'],
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
      SELECT 1, (SELECT COALESCE(SUM(size + playbackSize),0) FROM media_chunks WHERE unavailable = 0)
        + (SELECT COALESCE(SUM(size),0) FROM archive_detached_playback);
    DROP TRIGGER IF EXISTS archive_usage_insert;
    DROP TRIGGER IF EXISTS archive_usage_delete;
    DROP TRIGGER IF EXISTS archive_usage_update;
    CREATE TRIGGER IF NOT EXISTS archive_detached_usage_insert AFTER INSERT ON archive_detached_playback BEGIN
      UPDATE archive_storage_usage SET bytes = bytes + NEW.size WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS archive_detached_usage_delete AFTER DELETE ON archive_detached_playback BEGIN
      UPDATE archive_storage_usage SET bytes = bytes - OLD.size WHERE singleton = 1;
    END;
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
  const detach = (chunk: ArchiveChunk) => {
    if (chunk.playbackPath && chunk.playbackSize && chunk.playbackSize > 0)
      db.prepare('INSERT INTO archive_detached_playback(path,size) VALUES(?,?)')
        .run(chunk.playbackPath, chunk.playbackSize);
  };
  const getArchive = (channelId: string) => db.prepare('SELECT * FROM channel_archives WHERE channelId = ?').get(channelId) as ArchiveRow | undefined;
  const sessionOf = (id: string) => /^(.*)-chunk-\d{9}\.ts$/.exec(id)?.[1];
  // Raw fallback suppresses legacy derivatives, but not explicitly verified pairs.
  const presentation = (c: ArchiveChunk, raw: boolean, selectPairs: boolean): ArchiveChunk => raw && !selectPairs ? {
    ...c, playbackPath: null, playbackSize: 0, playbackOffset: 0, playbackDuration: null,
    presentationStart: null, pairId: null, pairRole: null,
  } : raw && !c.pairId ? {
    ...c, playbackPath: null, playbackSize: 0, playbackOffset: 0, playbackDuration: null,
  } : c;
  const pairValid = (pairId: string): boolean => !!db.prepare(`SELECT 1 FROM archive_playback_pairs p
    JOIN media_chunks a ON a.id = p.priorId JOIN media_chunks b ON b.id = p.nextId
    WHERE p.id = ? AND a.unavailable = 0 AND b.unavailable = 0
      AND a.pairId = p.id AND b.pairId = p.id
      AND a.playbackPath = p.priorPath AND b.playbackPath = p.nextPath`).get(pairId);
  const overlap = (channelId: string, start: number, end: number, raw = false, selectPairs = true) => {
    // A broken seam invalidates the clock of later chunks in that session too;
    // do not issue a partial raw/shifted ticket while recovery is pending.
    const pairs = db.prepare(`SELECT p.id,p.priorId,p.session FROM archive_playback_pairs p
      LEFT JOIN media_chunks a ON a.id = p.priorId LEFT JOIN media_chunks b ON b.id = p.nextId
      WHERE a.channelId = ? OR b.channelId = ?`).all(channelId, channelId) as
      Array<{ id: string; priorId: string; session: string }>;
    const broken = selectPairs ? pairs.filter(p => !pairValid(p.id)) : [];
    const selected = chunks(
      `SELECT * FROM media_chunks WHERE channelId = ? AND unavailable = 0
        AND (? = 1 OR playbackHidden = 0) ORDER BY end,rowid`, channelId, raw ? 1 : 0,
    ).map(c => presentation(c, raw, selectPairs)).filter(chunk => {
      const playableStart = chunk.presentationStart ?? chunk.start + (chunk.playbackPath ? (chunk.playbackOffset ?? 0) * 1000 : 0);
      const playableEnd = playableStart + (chunk.playbackPath ? (chunk.playbackDuration ?? chunk.duration) : chunk.duration) * 1000;
      return playableEnd > start && playableStart < end;
    });
    return broken.some(p => selected.some(c => c.id === p.priorId || sessionOf(c.id) === p.session)) ? [] : selected;
  };
  const snapshot = (id: string): ArchiveSnapshot | undefined => {
    const row = db.prepare('SELECT * FROM archive_snapshots WHERE id = ?').get(id) as Omit<ArchiveSnapshot, 'chunks'> | undefined;
    if (!row) return undefined;
    const selected = chunks(`SELECT c.id,c.channelId,c.start,c.end,c.duration,c.path,c.size,c.epoch,c.unavailable,
      s.playbackPath,s.playbackSize,s.playbackOffset,s.playbackDuration,
      s.presentationStart,s.pairId,s.pairRole
      FROM media_chunks c JOIN archive_snapshot_chunks s ON s.chunkId = c.id
      WHERE s.snapshotId = ? AND c.unavailable = 0
      AND (s.playbackPath IS NULL OR s.playbackPath = c.playbackPath)
      ORDER BY s.ordinal`, id);
    const expected = (db.prepare('SELECT COUNT(*) AS count FROM archive_snapshot_chunks WHERE snapshotId = ?')
      .get(id) as { count: number }).count;
    return selected.length === expected && selected.length > 0 &&
      selected.every(c => !c.pairId || pairValid(c.pairId)) ? { ...row, chunks: selected } : undefined;
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
        const session = sessionOf(chunk.id);
        const shift = session && db.prepare('SELECT shiftMs FROM archive_playback_pairs WHERE session = ?')
          .get(session) as { shiftMs: number } | undefined;
        if (shift) db.prepare(`UPDATE media_chunks SET presentationStart = start + ?
          WHERE id = ? AND presentationStart IS NULL AND pairId IS NULL`).run(shift.shiftMs, chunk.id);
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
    /** Restore a broken pair as raw only after the caller verifies BOTH raw
     * masters. No filesystem work occurs in the store transaction. */
    restorePlaybackPairRaw(id: string, rawAvailable: (relative: string) => boolean): boolean {
      return db.transaction(() => {
        const selected = getChunk(id);
        if (!selected?.pairId) return false;
        const pair = db.prepare(`SELECT priorId,nextId,session FROM archive_playback_pairs WHERE id = ?`)
          .get(selected.pairId) as { priorId: string; nextId: string; session: string } | undefined;
        if (!pair) return false;
        const prefix = `${pair.session}-chunk-`;
        if (db.prepare(`SELECT 1 FROM archive_playback_pairs WHERE id != ?
          AND substr(priorId,1,length(?)) = ? LIMIT 1`).get(selected.pairId, prefix, prefix)) return false;
        const prior = getChunk(pair.priorId), next = getChunk(pair.nextId);
        if (!prior || !next || prior.unavailable || next.unavailable ||
          prior.pairId !== selected.pairId || next.pairId !== selected.pairId ||
          !rawAvailable(prior.path) || !rawAvailable(next.path)) return false;
        detach(prior); detach(next);
        // A snapshot keeps its own presentation clock/path and its pair marker;
        // pairValid() will reject that old cohort after this row is removed.
        db.prepare('DELETE FROM archive_playback_pairs WHERE id = ?').run(selected.pairId);
        db.prepare(`UPDATE media_chunks SET playbackPath = NULL, playbackSize = 0,
          playbackOffset = 0, playbackDuration = NULL, presentationStart = NULL,
          pairId = NULL, pairRole = NULL WHERE id IN (?,?)`).run(pair.priorId, pair.nextId);
        const priorSession = sessionOf(pair.priorId);
        if (priorSession && db.prepare('SELECT 1 FROM archive_playback_pairs WHERE session = ?').get(priorSession))
          db.prepare('UPDATE media_chunks SET presentationStart = ? WHERE id = ?')
            .run(prior.presentationStart, pair.priorId);
        db.prepare(`UPDATE media_chunks SET presentationStart = NULL WHERE pairId IS NULL
          AND substr(id,1,length(?)) = ?`).run(prefix, prefix);
        return true;
      }).immediate();
    },
    /** A broken upstream pair invalidates the presentation clock of later
     * pairs that use its session. Restore descendants first in one transaction,
     * or leave the whole chain fail-closed if any raw master is unavailable. */
    restorePlaybackChainRaw(id: string, rawAvailable: (relative: string) => boolean): boolean {
      return db.transaction(() => {
        const selected = getChunk(id);
        if (!selected?.pairId) return false;
        const order: Array<{ id: string; priorId: string; nextId: string; session: string }> = [];
        const seen = new Set<string>();
        const visit = (pairId: string): boolean => {
          if (seen.has(pairId) || seen.size >= 32) return false;
          seen.add(pairId);
          const pair = db.prepare(`SELECT id,priorId,nextId,session FROM archive_playback_pairs WHERE id = ?`)
            .get(pairId) as (typeof order)[number] | undefined;
          if (!pair) return false;
          const prefix = `${pair.session}-chunk-`;
          const dependents = db.prepare(`SELECT id FROM archive_playback_pairs WHERE id != ?
            AND substr(priorId,1,length(?)) = ? ORDER BY id`)
            .all(pairId, prefix, prefix) as Array<{ id: string }>;
          for (const dependent of dependents) if (!visit(dependent.id)) return false;
          order.push(pair);
          return true;
        };
        if (!visit(selected.pairId)) return false;
        for (const pair of order) {
          const prior = getChunk(pair.priorId), next = getChunk(pair.nextId);
          if (!prior || !next || prior.unavailable || next.unavailable ||
              prior.pairId !== pair.id || next.pairId !== pair.id ||
              !rawAvailable(prior.path) || !rawAvailable(next.path)) return false;
        }
        for (const pair of order) {
          const prior = getChunk(pair.priorId)!, next = getChunk(pair.nextId)!;
          detach(prior); detach(next);
          db.prepare('DELETE FROM archive_playback_pairs WHERE id = ?').run(pair.id);
          db.prepare(`UPDATE media_chunks SET playbackPath = NULL, playbackSize = 0,
            playbackOffset = 0, playbackDuration = NULL, presentationStart = NULL,
            pairId = NULL, pairRole = NULL WHERE id IN (?,?)`).run(pair.priorId, pair.nextId);
          const priorSession = sessionOf(pair.priorId);
          if (priorSession && db.prepare('SELECT 1 FROM archive_playback_pairs WHERE session = ?').get(priorSession))
            db.prepare('UPDATE media_chunks SET presentationStart = ? WHERE id = ?')
              .run(prior.presentationStart, pair.priorId);
          const prefix = `${pair.session}-chunk-`;
          db.prepare(`UPDATE media_chunks SET presentationStart = NULL WHERE pairId IS NULL
            AND substr(id,1,length(?)) = ?`).run(prefix, prefix);
        }
        return true;
      }).immediate();
    },
    /** Caller verifies and renames both existing media paths before this
     * metadata-only transaction. False leaves both staged files to the caller. */
    publishPlaybackPair(pair: { priorId: string; nextId: string; priorRawPath: string; nextRawPath: string;
      priorPath: string; priorSize: number;
      priorCut: number; nextPath: string; nextSize: number; nextOffset: number; nextDuration: number;
      sessionTimeline?: Array<{ id: string; presentationStart: number }> },
    now = Date.now()): boolean {
      const { priorId, nextId, priorPath, priorSize, priorCut, nextPath, nextSize, nextOffset, nextDuration } = pair;
      if (priorId === nextId || priorPath === nextPath ||
        ![priorPath, nextPath].every(p => typeof p === 'string' && p.endsWith('.playback.ts') && !p.startsWith('/')) ||
        ![priorSize, nextSize].every(n => Number.isSafeInteger(n) && n > 0) ||
        !Number.isSafeInteger(now) || ![priorCut, nextOffset, nextDuration].every(n => Number.isFinite(n)) ||
        priorCut <= 0 || nextOffset < 0 || nextDuration <= 0) return false;
      return db.transaction(() => {
        const prior = getChunk(priorId), next = getChunk(nextId);
        const session = sessionOf(nextId);
        if (!prior || !next || !session || !sessionOf(priorId) || sessionOf(priorId) === session ||
          prior.path !== pair.priorRawPath || next.path !== pair.nextRawPath ||
          prior.channelId !== next.channelId || prior.unavailable || next.unavailable ||
          prior.playbackHidden || next.playbackHidden ||
          prior.pairId || next.pairId || prior.end >= next.end ||
          [prior.path, next.path, prior.playbackPath, next.playbackPath].includes(priorPath) ||
          [prior.path, next.path, prior.playbackPath, next.playbackPath].includes(nextPath) ||
          priorCut > prior.duration || nextOffset + nextDuration > next.duration + 0.001 ||
          db.prepare('SELECT 1 FROM archive_playback_pairs WHERE session = ?').get(session)) return false;
        const pinned = db.prepare(`SELECT 1 FROM archive_snapshot_chunks sc
          JOIN archive_snapshots s ON s.id = sc.snapshotId WHERE sc.chunkId = ?
          AND sc.playbackPath = ? AND s.expiresAt > ? LIMIT 1`);
        if ((prior.playbackPath && pinned.get(priorId, prior.playbackPath, now)) ||
          (next.playbackPath && pinned.get(nextId, next.playbackPath, now))) return false;
        const previous = db.prepare(`SELECT p.id FROM media_chunks p WHERE p.channelId = ? AND p.unavailable = 0
          AND p.playbackHidden = 0 AND (p.end < ? OR (p.end = ? AND p.rowid <
            (SELECT rowid FROM media_chunks WHERE id = ?))) ORDER BY p.end DESC,p.rowid DESC LIMIT 1`)
          .get(next.channelId, next.end, next.end, nextId) as { id: string } | undefined;
        if (previous?.id !== priorId) return false;
        const priorPresentationStart = prior.presentationStart ?? prior.start;
        if (pair.sessionTimeline) {
          const rows = chunks(`SELECT * FROM media_chunks WHERE channelId = ?
            AND id LIKE ? ORDER BY id`, next.channelId, `${session}-chunk-%`);
          if (rows.length !== pair.sessionTimeline.length || rows.length < 2 || rows.length > 14 ||
              rows.some((row, index) => row.id !== pair.sessionTimeline![index]?.id || row.unavailable ||
                row.epoch !== next.epoch || !Number.isFinite(pair.sessionTimeline![index].presentationStart) ||
                (index > 0 && Math.abs(pair.sessionTimeline![index].presentationStart -
                  (pair.sessionTimeline![index - 1].presentationStart +
                    (index === 1 ? nextDuration : rows[index - 1].duration) * 1000)) > 1)) ||
              Math.abs(pair.sessionTimeline[0].presentationStart - (priorPresentationStart + priorCut * 1000)) > 1)
            return false;
        }
        detach(prior); detach(next);
        const id = randomUUID();
        const shift = priorPresentationStart + priorCut * 1000 - next.start - nextOffset * 1000;
        db.prepare(`INSERT INTO archive_playback_pairs(id,priorId,nextId,session,shiftMs,priorPath,nextPath)
          VALUES(?,?,?,?,?,?,?)`).run(id, priorId, nextId, session, shift, priorPath, nextPath);
        const update = db.prepare(`UPDATE media_chunks SET playbackPath = ?, playbackSize = ?, playbackOffset = ?,
          playbackDuration = ?, presentationStart = ?, pairId = ?, pairRole = ? WHERE id = ?
          AND pairId IS NULL AND unavailable = 0`);
        if (update.run(priorPath, priorSize, 0, priorCut, priorPresentationStart, id, 'prior', priorId).changes !== 1 ||
          update.run(nextPath, nextSize, nextOffset, nextDuration,
            priorPresentationStart + priorCut * 1000, id, 'next', nextId).changes !== 1) throw new Error('Pair changed during publication');
        if (pair.sessionTimeline) {
          const updateStart = db.prepare(`UPDATE media_chunks SET presentationStart = ?
            WHERE id = ? AND pairId IS NULL AND unavailable = 0`);
          for (const row of pair.sessionTimeline.slice(1))
            if (updateStart.run(row.presentationStart, row.id).changes !== 1)
              throw new Error('Pair session changed during publication');
        } else {
          const prefix = `${session}-chunk-`;
          db.prepare(`UPDATE media_chunks SET presentationStart = start + ? WHERE id != ?
            AND substr(id,1,length(?)) = ? AND pairId IS NULL AND presentationStart IS NULL`)
            .run(shift, nextId, prefix, prefix);
        }
        return true;
      }).immediate();
    },
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
    /** Backfill includes legacy single-file derivatives only when replacing
     * them cannot invalidate a still-live derived snapshot. Publication
     * rechecks pins under its own IMMEDIATE transaction. */
    pairCandidates(channelId: string, since: number, now = Date.now()): ArchiveChunk[] {
      return chunks(`SELECT c.* FROM media_chunks c WHERE c.channelId = ? AND c.end > ?
        AND c.unavailable = 0 AND c.playbackHidden = 0 AND c.pairId IS NULL
        AND c.id LIKE '%-chunk-000000000.ts'
        AND NOT EXISTS (SELECT 1 FROM archive_snapshot_chunks sc
          JOIN archive_snapshots s ON s.id = sc.snapshotId
          WHERE sc.chunkId = c.id AND sc.playbackPath = c.playbackPath
            AND c.playbackPath IS NOT NULL AND s.expiresAt > ?)
        ORDER BY c.end,c.rowid`, channelId, since, now);
    },
    markAvailable(id: string) { db.prepare('UPDATE media_chunks SET unavailable = 0 WHERE id = ? AND unavailable != 0').run(id); },
    reconcilePlaybackMissing(id: string): 'restored_raw' | 'pair_pending' | 'absent' {
      return db.transaction(() => {
        const chunk = getChunk(id);
        if (!chunk?.playbackPath) return 'absent';
        // A single-file derivative returns to raw immediately. A pair remains
        // unavailable until BOTH raw masters pass restorePlaybackPairRaw().
        // Snapshots bound to the lost path fail closed; saved shows stay raw.
        db.prepare(`UPDATE media_chunks SET playbackPath = NULL, playbackSize = 0,
          playbackOffset = 0, playbackDuration = NULL, unavailable = 0 WHERE id = ?`).run(id);
        return chunk.pairId ? 'pair_pending' : 'restored_raw';
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
    coverage(channelId: string, raw = false, selectPairs = true) {
      if (raw && !selectPairs) return db.prepare(`SELECT MIN(start) availableFrom, MAX(end) availableTo,
        COALESCE(SUM(size + playbackSize),0) diskUsageBytes
        FROM media_chunks WHERE channelId = ? AND unavailable = 0`).get(channelId) as
        { availableFrom: number | null; availableTo: number | null; diskUsageBytes: number };
      return db.prepare(`SELECT
        MIN(CASE WHEN playbackHidden = 0 THEN COALESCE(presentationStart, start +
          CASE WHEN playbackPath IS NOT NULL THEN playbackOffset * 1000 ELSE 0 END) END) availableFrom,
        MAX(CASE WHEN playbackHidden = 0 THEN
          COALESCE(presentationStart, start + CASE WHEN playbackPath IS NOT NULL THEN playbackOffset * 1000 ELSE 0 END)
            + CASE WHEN playbackPath IS NOT NULL THEN COALESCE(playbackDuration,duration) ELSE duration END * 1000 END) availableTo,
        COALESCE(SUM(size + playbackSize),0) diskUsageBytes
        FROM media_chunks WHERE channelId = ? AND unavailable = 0`)
        .get(channelId) as { availableFrom: number | null; availableTo: number | null; diskUsageBytes: number };
    },
    totalUsageBytes(): number {
      return (db.prepare('SELECT bytes FROM archive_storage_usage WHERE singleton = 1').get() as { bytes: number }).bytes;
    },
    detachedPlayback(): Array<{ path: string; size: number }> {
      return db.prepare('SELECT path,size FROM archive_detached_playback ORDER BY path').all() as Array<{ path: string; size: number }>;
    },
    /** Call ONLY after deleting the detached file (or confirming it missing). */
    releaseDetachedPlayback(relative: string): void {
      db.prepare('DELETE FROM archive_detached_playback WHERE path = ?').run(relative);
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
    createSnapshot(channelId: string, startTime: number, endTime: number, now: number, expiresAt: number,
      raw = false, selectPairs = true): ArchiveSnapshot {
      const id = randomUUID();
      db.transaction(() => {
        const selected = overlap(channelId, startTime, endTime, raw, selectPairs);
        if (!selected.length) throw new Error('No published chunks in this interval');
        if (selected.some(c => c.pairId && !pairValid(c.pairId))) throw new Error('Archive pair is unavailable');
        if (selectPairs && db.prepare(`SELECT 1 FROM archive_playback_pairs p JOIN media_chunks a ON a.id = p.priorId
          JOIN media_chunks b ON b.id = p.nextId WHERE a.channelId = ? AND
          (a.start < ? AND a.end > ? OR b.start < ? AND b.end > ?) AND
          (a.playbackPath IS NULL OR b.playbackPath IS NULL OR a.unavailable != 0 OR b.unavailable != 0)
          LIMIT 1`).get(channelId, endTime, startTime, endTime, startTime)) throw new Error('Archive pair is unavailable');
        db.prepare('INSERT INTO archive_snapshots(id,channelId,startTime,endTime,expiresAt,createdAt) VALUES(?,?,?,?,?,?)').run(id, channelId, startTime, endTime, expiresAt, now);
        const add = db.prepare(`INSERT INTO archive_snapshot_chunks
          (snapshotId,chunkId,ordinal,playbackPath,playbackSize,playbackOffset,playbackDuration,presentationStart,pairId,pairRole)
          VALUES(?,?,?,?,?,?,?,?,?,?)`);
        selected.forEach((c, ordinal) => add.run(id, c.id, ordinal,
          c.playbackPath ?? null, c.playbackSize ?? 0, c.playbackOffset ?? 0,
          c.playbackDuration ?? null, c.presentationStart ?? null, c.pairId ?? null, c.pairRole ?? null));
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
    /** Candidates are hints; retirePlaybackPair rechecks the policy and pins
     * inside an IMMEDIATE transaction before changing either half. */
    retirablePairs(channelId: string, cutoff: number, now: number): string[] {
      return (db.prepare(`SELECT p.id FROM archive_playback_pairs p
        JOIN media_chunks a ON a.id = p.priorId JOIN media_chunks b ON b.id = p.nextId
        WHERE a.channelId = ? AND b.channelId = ? AND a.end <= ? AND b.end <= ?
          AND a.pairId = p.id AND b.pairId = p.id
          AND NOT EXISTS (SELECT 1 FROM archive_snapshot_chunks sc
            JOIN archive_snapshots s ON s.id = sc.snapshotId
            WHERE sc.chunkId IN (a.id,b.id) AND s.expiresAt > ?)
        ORDER BY b.end,p.id`).all(channelId, channelId, cutoff, cutoff, now) as Array<{ id: string }>).map(p => p.id);
    },
    retirePlaybackPair(channelId: string, pairId: string, now: number): boolean {
      return db.transaction(() => {
        const policy = getArchive(channelId);
        if (!policy) return false;
        const cutoff = now - policy.retentionHours * 3_600_000;
        if (!db.prepare(`SELECT 1 FROM archive_playback_pairs p
          JOIN media_chunks a ON a.id = p.priorId JOIN media_chunks b ON b.id = p.nextId
          WHERE p.id = ? AND a.channelId = ? AND b.channelId = ?
            AND a.end <= ? AND b.end <= ? AND a.pairId = p.id AND b.pairId = p.id
            AND NOT EXISTS (SELECT 1 FROM archive_snapshot_chunks sc
              JOIN archive_snapshots s ON s.id = sc.snapshotId
              WHERE sc.chunkId IN (a.id,b.id) AND s.expiresAt > ?)`).get(
                pairId, channelId, channelId, cutoff, cutoff, now)) return false;
        const pair = db.prepare('SELECT priorId,nextId,session FROM archive_playback_pairs WHERE id = ?')
          .get(pairId) as { priorId: string; nextId: string; session: string };
        const prefix = `${pair.session}-chunk-`;
        if (db.prepare(`SELECT 1 FROM archive_playback_pairs WHERE id != ?
          AND substr(priorId,1,length(?)) = ? LIMIT 1`).get(pairId, prefix, prefix)) return false;
        const prior = getChunk(pair.priorId)!, next = getChunk(pair.nextId)!;
        detach(prior); detach(next);
        db.prepare('DELETE FROM archive_playback_pairs WHERE id = ?').run(pairId);
        db.prepare(`UPDATE media_chunks SET playbackPath = NULL, playbackSize = 0,
          playbackOffset = 0, playbackDuration = NULL, presentationStart = NULL,
          pairId = NULL, pairRole = NULL WHERE id IN (?,?)`).run(pair.priorId, pair.nextId);
        const priorSession = sessionOf(pair.priorId);
        if (priorSession && db.prepare('SELECT 1 FROM archive_playback_pairs WHERE session = ?').get(priorSession))
          db.prepare('UPDATE media_chunks SET presentationStart = ? WHERE id = ?')
            .run(prior.presentationStart, pair.priorId);
        db.prepare(`UPDATE media_chunks SET presentationStart = NULL WHERE pairId IS NULL
          AND substr(id,1,length(?)) = ?`).run(prefix, prefix);
        return true;
      }).immediate();
    },
    prunable(channelId: string, cutoff: number, now: number) {
      return chunks(`SELECT c.* FROM media_chunks c WHERE c.channelId = ? AND c.end <= ?
        AND c.pairId IS NULL
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
          AND c.pairId IS NULL
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
