import { describe, expect, it } from 'vitest';
import { createArchiveTicket, verifyArchiveTicket, buildArchiveVod, archiveGaps, loadArchiveSigningKey } from './archive-hls.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const chunks = [
  { id: 'one', channelId: 'channel', start: 1000, end: 21000, duration: 20, path: 'archive/one.ts', size: 100, epoch: 1 },
  { id: 'two', channelId: 'channel', start: 25000, end: 45000, duration: 20, path: 'archive/two.ts', size: 100, epoch: 2 },
];
describe('finite private HLS', () => {
  it('keeps scoped playback URLs valid across restarts without exposing the signing key', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-key-'));
    try {
      const secret = loadArchiveSigningKey(directory);
      const token = createArchiveTicket('saved-snapshot', secret, 100000);
      expect(verifyArchiveTicket(token, 'saved-snapshot', loadArchiveSigningKey(directory), 90000)).toBe(true);
      expect(fs.statSync(path.join(directory, 'archive-signing.key')).mode & 0o777).toBe(0o600);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it('uses derived duration and chronology at a writer seam but keeps a finite playlist', () => {
    const clipped = { ...chunks[1], start: 19_000, end: 39_000, epoch: 1,
      playbackPath: 'archive/two.playback.ts', playbackOffset: 3, playbackDuration: 17 };
    const playlist = buildArchiveVod([chunks[0], clipped], id => `${id}.ts`);
    expect(playlist).toContain('#EXTINF:17.000,');
    expect(playlist).toContain('#EXT-X-PROGRAM-DATE-TIME:1970-01-01T00:00:22.000Z');
    expect(playlist).toContain('#EXT-X-DISCONTINUITY');
    expect(playlist).toContain('#EXT-X-ENDLIST');
  });

  it('produces finite seekable VOD with real gaps and scoped chunk tickets', () => {
    const secret = Buffer.alloc(32, 1);
    const expiresAt = 100000;
    const ticket = createArchiveTicket('snapshot', secret, expiresAt);
    const playlist = buildArchiveVod(chunks, id => `/api/archive/chunks/${id}.ts?ticket=${ticket}`);
    expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(playlist).toContain('#EXT-X-ENDLIST');
    expect(playlist).toContain('#EXT-X-DISCONTINUITY');
    expect(playlist.match(/#EXTINF:/g)).toHaveLength(2);
    expect(archiveGaps(chunks, 1000, 45000)).toEqual([{ startTime: 21000, endTime: 25000 }]);
    expect(verifyArchiveTicket(ticket, 'snapshot', secret, 99999)).toBe(true);
    expect(verifyArchiveTicket(ticket, 'other', secret, 99999)).toBe(false);
    expect(verifyArchiveTicket(ticket, 'snapshot', secret, expiresAt)).toBe(false);
  });
});
