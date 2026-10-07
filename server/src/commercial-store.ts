import type Database from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof Database>;

export interface CommercialSegmentWrite {
  startSeconds: number;
  endSeconds: number;
  detector: string;
  confidence: number | null;
  detectorVersion: string;
  reviewState: string;
}

export interface DBCommercialSegment {
  id: number;
  recording_id: string;
  start_seconds: number;
  end_seconds: number;
  detector: string;
  confidence: number | null;
  detector_version: string;
  review_state: string;
  created_at: number;
  updated_at: number;
}

export function createCommercialStore(db: SqliteDatabase) {
  const insert = db.prepare(`
    INSERT INTO commercial_segments
      (recording_id, start_seconds, end_seconds, detector, confidence, detector_version, review_state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSegments = (recordingId: string, segments: CommercialSegmentWrite[], now: number) => {
    for (const segment of segments) {
      insert.run(
        recordingId, segment.startSeconds, segment.endSeconds, segment.detector,
        segment.confidence, segment.detectorVersion, segment.reviewState, now, now,
      );
    }
  };
  const replace = db.transaction((recordingId: string, segments: CommercialSegmentWrite[]) => {
    db.prepare('DELETE FROM commercial_segments WHERE recording_id = ?').run(recordingId);
    insertSegments(recordingId, segments, Date.now());
  });
  const replaceIfIdle = db.transaction((
    recordingId: string,
    segments: CommercialSegmentWrite[],
    state: 'review_needed' | 'ready',
    now: number,
  ) => {
    const updated = db.prepare(`
      UPDATE recordings
      SET analysis_state=?, analysis_error=NULL, analysis_completed_at=?, analysis_started_at=NULL
      WHERE id=? AND COALESCE(analysis_state, 'not_requested') NOT IN ('queued', 'analyzing')
    `).run(state, now, recordingId);
    if (updated.changes !== 1) return false;
    db.prepare('DELETE FROM commercial_segments WHERE recording_id = ?').run(recordingId);
    insertSegments(recordingId, segments, now);
    return true;
  });
  const deleteRecording = db.transaction((recordingId: string) => {
    db.prepare('DELETE FROM commercial_segments WHERE recording_id = ?').run(recordingId);
    db.prepare('DELETE FROM recordings WHERE id = ?').run(recordingId);
  });
  const claimNext = db.transaction((now: number) => {
    const candidate = db.prepare(`
      SELECT id FROM recordings
      WHERE analysis_state = 'queued'
      ORDER BY COALESCE(analysis_requested_at, created_at), created_at
      LIMIT 1
    `).get() as { id: string } | undefined;
    if (!candidate) return undefined;
    const claimed = db.prepare(`
      UPDATE recordings
      SET analysis_state='analyzing', analysis_error=NULL, analysis_started_at=?, analysis_completed_at=NULL
      WHERE id=? AND analysis_state='queued'
    `).run(now, candidate.id);
    if (claimed.changes !== 1) return undefined;
    return db.prepare('SELECT * FROM recordings WHERE id=?').get(candidate.id) as Record<string, unknown>;
  });
  const complete = db.transaction((
    recordingId: string,
    segments: CommercialSegmentWrite[],
    state: 'review_needed' | 'ready',
    profile: string,
    now: number,
  ) => {
    const completed = db.prepare(`
      UPDATE recordings
      SET analysis_state=?, analysis_error=NULL, analysis_completed_at=?, analysis_started_at=NULL, analysis_profile=?
      WHERE id=? AND analysis_state='analyzing'
    `).run(state, now, profile, recordingId);
    if (completed.changes !== 1) return false;
    db.prepare('DELETE FROM commercial_segments WHERE recording_id = ?').run(recordingId);
    insertSegments(recordingId, segments, now);
    return true;
  });

  return {
    getSegments(recordingId: string): DBCommercialSegment[] {
      return db.prepare('SELECT * FROM commercial_segments WHERE recording_id = ? ORDER BY start_seconds, end_seconds')
        .all(recordingId) as DBCommercialSegment[];
    },
    replaceSegments(recordingId: string, segments: CommercialSegmentWrite[]): void {
      replace(recordingId, segments);
    },
    replaceSegmentsIfIdle(
      recordingId: string,
      segments: CommercialSegmentWrite[],
      state: 'review_needed' | 'ready',
      now: number,
    ): boolean {
      return replaceIfIdle(recordingId, segments, state, now);
    },
    queueAnalysis(recordingId: string, now: number): boolean {
      return db.prepare(`
        UPDATE recordings
        SET analysis_state='queued', analysis_error=NULL, analysis_requested_at=?,
            analysis_started_at=NULL, analysis_completed_at=NULL
        WHERE id=? AND status='completed'
          AND COALESCE(analysis_state, 'not_requested') NOT IN ('queued', 'analyzing')
      `).run(now, recordingId).changes === 1;
    },
    deleteRecordingWithSegments(recordingId: string): void {
      deleteRecording(recordingId);
    },
    recoverStaleAnalysis(): number {
      return db.prepare(`
        UPDATE recordings SET analysis_state = 'queued', analysis_error = 'Recovered after interrupted analysis', analysis_started_at = NULL
        WHERE analysis_state = 'analyzing'
      `).run().changes;
    },
    claimNextQueuedAnalysis(now: number): Record<string, unknown> | undefined {
      return claimNext(now);
    },
    failAnalysis(recordingId: string, message: string, now: number): boolean {
      return db.prepare(`
        UPDATE recordings
        SET analysis_state='failed', analysis_error=?, analysis_completed_at=?, analysis_started_at=NULL
        WHERE id=? AND analysis_state='analyzing'
      `).run(message, now, recordingId).changes === 1;
    },
    completeAnalysis(
      recordingId: string,
      segments: CommercialSegmentWrite[],
      state: 'review_needed' | 'ready',
      profile: string,
      now: number,
    ): boolean {
      return complete(recordingId, segments, state, profile, now);
    },
  };
}
