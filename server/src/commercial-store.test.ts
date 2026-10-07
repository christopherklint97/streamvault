// @vitest-environment node
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureRecordingSchema } from './db-migrations.js';
import { createCommercialStore } from './commercial-store.js';

function database(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE programs (id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT DEFAULT '', start_time INTEGER NOT NULL, stop_time INTEGER NOT NULL, category TEXT DEFAULT '');
    CREATE TABLE recordings (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, actual_start INTEGER, actual_end INTEGER, file_path TEXT, file_size INTEGER DEFAULT 0, duration INTEGER DEFAULT 0, error TEXT, rule_id TEXT, program_title TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE recording_rules (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, match_title TEXT NOT NULL, match_type TEXT NOT NULL, enabled INTEGER NOT NULL, padding_before INTEGER NOT NULL, padding_after INTEGER NOT NULL, max_recordings INTEGER NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO recordings (id,channel_id,channel_name,title,status,start_time,end_time,created_at,duration) VALUES ('r1','c','C','T','completed',1,2,1,100);
  `);
  ensureRecordingSchema(db);
  return db;
}

describe('commercial segment persistence', () => {
  it('atomically replaces intervals and explicitly cleans them on recording deletion', () => {
    const db = database();
    const store = createCommercialStore(db);
    store.replaceSegments('r1', [{ startSeconds: 10, endSeconds: 20, detector: 'manual', confidence: 1, detectorVersion: 'manual-v1', reviewState: 'approved' }]);
    expect(store.getSegments('r1')).toMatchObject([{ start_seconds: 10, end_seconds: 20, review_state: 'approved' }]);
    store.deleteRecordingWithSegments('r1');
    expect(store.getSegments('r1')).toEqual([]);
    expect(db.prepare("SELECT id FROM recordings WHERE id='r1'").get()).toBeUndefined();
    db.close();
  });

  it('recovers stale analyzing jobs without altering last good segments', () => {
    const db = database();
    const store = createCommercialStore(db);
    store.replaceSegments('r1', [{ startSeconds: 1, endSeconds: 2, detector: 'comskip', confidence: null, detectorVersion: 'a140b6a', reviewState: 'suggested' }]);
    db.prepare("UPDATE recordings SET analysis_state='analyzing'").run();
    expect(store.recoverStaleAnalysis()).toBe(1);
    expect(store.getSegments('r1')).toHaveLength(1);
    expect(db.prepare("SELECT analysis_state FROM recordings WHERE id='r1'").get()).toEqual({ analysis_state: 'queued' });
    db.close();
  });

  it('atomically claims only one queued recording', () => {
    const db = database();
    const store = createCommercialStore(db);
    db.prepare("UPDATE recordings SET analysis_state='queued', analysis_requested_at=10").run();

    expect(store.claimNextQueuedAnalysis(50)).toMatchObject({ id: 'r1', analysis_state: 'analyzing', analysis_started_at: 50 });
    expect(store.claimNextQueuedAnalysis(60)).toBeUndefined();
    db.close();
  });

  it('atomically replaces segments and completes only a still-analyzing recording', () => {
    const db = database();
    const store = createCommercialStore(db);
    store.replaceSegments('r1', [{ startSeconds: 1, endSeconds: 2, detector: 'manual', confidence: 1, detectorVersion: 'manual-v1', reviewState: 'accepted' }]);
    db.prepare("UPDATE recordings SET analysis_state='analyzing'").run();
    const next = [{ startSeconds: 10, endSeconds: 20, detector: 'comskip', confidence: null, detectorVersion: 'rev', reviewState: 'suggested' }];

    expect(store.completeAnalysis('r1', next, 'review_needed', 'profile', 100)).toBe(true);
    expect(store.getSegments('r1')).toMatchObject([{ start_seconds: 10, end_seconds: 20 }]);
    expect(db.prepare("SELECT analysis_state, analysis_profile FROM recordings WHERE id='r1'").get())
      .toEqual({ analysis_state: 'review_needed', analysis_profile: 'profile' });

    db.prepare("UPDATE recordings SET analysis_state='queued'").run();
    expect(store.completeAnalysis('r1', [], 'ready', 'new-profile', 200)).toBe(false);
    expect(store.getSegments('r1')).toMatchObject([{ start_seconds: 10, end_seconds: 20 }]);
    db.close();
  });

  it('queues analysis only from an idle completed state', () => {
    const db = database();
    const store = createCommercialStore(db);

    expect(store.queueAnalysis('r1', 100)).toBe(true);
    expect(store.queueAnalysis('r1', 200)).toBe(false);
    expect(db.prepare("SELECT analysis_state,analysis_requested_at FROM recordings WHERE id='r1'").get())
      .toEqual({ analysis_state: 'queued', analysis_requested_at: 100 });

    db.prepare("UPDATE recordings SET status='recording', analysis_state='ready'").run();
    expect(store.queueAnalysis('r1', 300)).toBe(false);
    db.close();
  });

  it('atomically rejects manual edits while analysis is queued or running', () => {
    const db = database();
    const store = createCommercialStore(db);
    const original = [{ startSeconds: 1, endSeconds: 2, detector: 'manual', confidence: 1, detectorVersion: 'manual-v1', reviewState: 'accepted' }];
    const replacement = [{ startSeconds: 10, endSeconds: 20, detector: 'manual', confidence: 1, detectorVersion: 'manual-v1', reviewState: 'accepted' }];
    store.replaceSegments('r1', original);

    db.prepare("UPDATE recordings SET analysis_state='queued'").run();
    expect(store.replaceSegmentsIfIdle('r1', replacement, 'ready', 100)).toBe(false);
    db.prepare("UPDATE recordings SET analysis_state='analyzing'").run();
    expect(store.replaceSegmentsIfIdle('r1', replacement, 'ready', 200)).toBe(false);
    expect(store.getSegments('r1')).toMatchObject([{ start_seconds: 1, end_seconds: 2 }]);

    db.prepare("UPDATE recordings SET analysis_state='review_needed'").run();
    expect(store.replaceSegmentsIfIdle('r1', replacement, 'ready', 300)).toBe(true);
    expect(store.getSegments('r1')).toMatchObject([{ start_seconds: 10, end_seconds: 20 }]);
    db.close();
  });
});
