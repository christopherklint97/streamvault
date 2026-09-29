import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ArchiveChunk } from './archive-store.js';

/** Persist the playback-signing key in the existing private data volume so a
 * server restart does not invalidate all active seekable manifests. */
export function loadArchiveSigningKey(directory: string): Buffer {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyFile = path.join(directory, 'archive-signing.key');
  if (!fs.existsSync(keyFile)) {
    try { fs.writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const key = fs.readFileSync(keyFile);
  if (key.length !== 32) throw new Error('Archive signing key is invalid');
  return key;
}

export function createArchiveTicket(scope: string, secret: Buffer, expiresAt: number): string {
  const data = Buffer.from(JSON.stringify([scope, expiresAt])).toString('base64url');
  const signature = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${signature}`;
}

export function verifyArchiveTicket(ticket: unknown, scope: string, secret: Buffer, now = Date.now()): boolean {
  if (typeof ticket !== 'string' || ticket.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket)) return false;
  const [data, mac] = ticket.split('.');
  const expected = createHmac('sha256', secret).update(data).digest();
  const actual = Buffer.from(mac, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    return Array.isArray(parsed) && parsed.length === 2 && parsed[0] === scope &&
      Number.isSafeInteger(parsed[1]) && parsed[1] > now;
  } catch { return false; }
}

export function playableStart(chunk: ArchiveChunk): number { return chunk.start + (chunk.playbackPath ? (chunk.playbackOffset ?? 0) * 1000 : 0); }
export function playableDuration(chunk: ArchiveChunk): number { return chunk.playbackPath ? (chunk.playbackDuration ?? chunk.duration) : chunk.duration; }
export function playableEnd(chunk: ArchiveChunk): number { return playableStart(chunk) + playableDuration(chunk) * 1000; }

export function archiveGaps(chunks: ArchiveChunk[], start: number, end: number): Array<{ startTime: number; endTime: number }> {
  const gaps = [];
  let cursor = start;
  for (const chunk of chunks) {
    if (playableStart(chunk) > cursor + 1000) gaps.push({ startTime: cursor, endTime: playableStart(chunk) });
    cursor = Math.max(cursor, playableEnd(chunk));
  }
  if (end > cursor + 1000) gaps.push({ startTime: cursor, endTime: end });
  return gaps;
}

export function buildArchiveVod(chunks: ArchiveChunk[], segmentUrl: (id: string) => string): string {
  if (!chunks.length) throw new Error('Empty snapshot');
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...chunks.map(playableDuration)))}`,
    '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  let previous: ArchiveChunk | undefined;
  for (const chunk of chunks) {
    const priorSession = previous?.id.split('-chunk-')[0];
    const session = chunk.id.split('-chunk-')[0];
    if (previous && (chunk.epoch !== previous.epoch || session !== priorSession ||
      Math.abs(playableStart(chunk) - playableEnd(previous)) > 1000)) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(playableStart(chunk)).toISOString()}`);
    lines.push(`#EXTINF:${playableDuration(chunk).toFixed(3)},`);
    lines.push(segmentUrl(chunk.id));
    previous = chunk;
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}
