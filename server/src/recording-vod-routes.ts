import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express, RequestHandler } from 'express';
import { getRecordingVodHlsState, rewriteRecordingVodPlaylist, vodHlsDirectory } from './recording-vod-hls.js';
import { logger } from './logger.js';

interface RecordingVodRouteDependencies {
  getMasterPath: (id: string) => string | null;
  getStatus: (id: string) => string | null;
  getDuration: (id: string) => number;
  canAccess: (id: string, ticket: string | undefined) => boolean;
  requireAuth: RequestHandler;
  ensure: (masterPath: string, durationSeconds: number) => Promise<void>;
  isPreparing: (masterPath: string) => boolean;
}

const SESSION_IDLE_MS = 4 * 60 * 60_000;
const MAX_SESSIONS = 32;
const sessions = new Map<string, { recordingId: string; expiresAt: number }>();

export function hasActiveRecordingVodViewer(recordingId: string): boolean {
  for (const [sessionId, session] of sessions) {
    if (session.expiresAt <= Date.now()) sessions.delete(sessionId);
    else if (session.recordingId === recordingId) return true;
  }
  return false;
}

/** The existing rolling route remains the immediate fallback until VOD is complete. */
export function registerRecordingVodRoutes(app: Express, dependencies: RecordingVodRouteDependencies): void {
  const activeSession = (id: string, recordingId: string) => {
    const session = sessions.get(id);
    if (!session || session.recordingId !== recordingId || session.expiresAt <= Date.now()) return false;
    session.expiresAt = Date.now() + SESSION_IDLE_MS;
    return true;
  };

  app.get('/api/recordings/:id/vod-status', dependencies.requireAuth, async (req, res) => {
    const id = String(req.params.id);
    const master = dependencies.getMasterPath(id);
    if (dependencies.getStatus(id) !== 'completed' || !master) {
      res.status(404).json({ error: 'Completed recording not found' });
      return;
    }
    const state = await getRecordingVodHlsState(master);
    res.set('Cache-Control', 'no-store').json({ status: state === 'ready' ? 'ready' : dependencies.isPreparing(master) ? 'preparing' : 'missing' });
  });

  app.get('/api/recordings/:id/hls/index.m3u8', async (req, res, next) => {
    if (req.query.session !== undefined) return next(); // An existing rolling-HLS session.
    const id = String(req.params.id);
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : undefined;
    if (!dependencies.canAccess(id, ticket)) return next(); // Rolling route sends its existing 401.
    const master = dependencies.getMasterPath(id);
    if (dependencies.getStatus(id) !== 'completed' || !master || !master.endsWith('.ts')) return next();
    try {
      if (await getRecordingVodHlsState(master) !== 'ready') {
        void dependencies.ensure(master, dependencies.getDuration(id)).catch(error => {
          logger.warn(`Recording ${id}: seekable HLS preparation failed: ${error instanceof Error ? error.message : error}`);
        });
        return next();
      }
      // A saved start is relative to the rolling stream. The client will
      // switch to VOD at that same absolute position on its readiness poll.
      if (typeof req.query.start === 'string' && Number(req.query.start) > 0) return next();
      for (const [sessionId, session] of sessions) {
        if (session.expiresAt <= Date.now()) sessions.delete(sessionId);
      }
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
      const sessionId = randomUUID();
      sessions.set(sessionId, { recordingId: id, expiresAt: Date.now() + SESSION_IDLE_MS });
      res.set('Cache-Control', 'no-store').redirect(302,
        `/api/recordings/${encodeURIComponent(id)}/vod/index.m3u8?session=${sessionId}`);
    } catch (error) { next(error); }
  });

  app.get('/api/recordings/:id/vod/:asset', async (req, res) => {
    const id = String(req.params.id);
    const asset = String(req.params.asset);
    const session = typeof req.query.session === 'string' ? req.query.session : '';
    if (!activeSession(session, id) || !/^(index\.m3u8|segment-\d+\.ts)$/.test(asset)) {
      res.status(404).end();
      return;
    }
    const master = dependencies.getMasterPath(id);
    if (dependencies.getStatus(id) !== 'completed' || !master ||
        (asset === 'index.m3u8' && await getRecordingVodHlsState(master) !== 'ready')) {
      res.status(404).end();
      return;
    }
    const file = path.join(vodHlsDirectory(master), asset);
    if (asset === 'index.m3u8') {
      try {
        const manifest = await fs.readFile(file, 'utf8');
        res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-store')
          .send(rewriteRecordingVodPlaylist(manifest, id, session));
      } catch { res.status(404).end(); }
    } else {
      res.type('video/mp2t').set('Cache-Control', 'private, no-store')
        .sendFile(file, { dotfiles: 'allow' });
    }
  });
}
