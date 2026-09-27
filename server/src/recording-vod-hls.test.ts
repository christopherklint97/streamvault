// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRecordingVodHlsArgs, getRecordingVodHlsState, removeAbandonedRecordingVodStaging, RecordingVodHlsPreparer, rewriteRecordingVodPlaylist, vodHlsDirectory } from './recording-vod-hls';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function master(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-vod-hls-test-'));
  roots.push(root);
  const file = path.join(root, 'r1.ts');
  fs.writeFileSync(file, 'the authoritative master');
  return file;
}

describe('recording VOD HLS', () => {
  it('builds a finite, bounded-I/O, stream-copy VOD package', () => {
    const args = buildRecordingVodHlsArgs('/records/r1.ts', '/records/r1.hls.part/index.m3u8');
    expect(args).toContain('-hls_playlist_type');
    expect(args[args.indexOf('-hls_playlist_type') + 1]).toBe('vod');
    expect(args[args.indexOf('-hls_list_size') + 1]).toBe('0');
    expect(args).toContain('-readrate');
    expect(args[args.indexOf('-c') + 1]).toBe('copy');
    expect(args).not.toContain('delete_segments+temp_file');
  });

  it('publishes seekable status only for a complete manifest and all referenced segments of the current master', async () => {
    const file = master();
    const directory = vodHlsDirectory(file);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'index.m3u8'), '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4,\nsegment-00000.ts\n#EXT-X-ENDLIST\n');
    fs.writeFileSync(path.join(directory, 'segment-00000.ts'), 'segment');
    expect(await getRecordingVodHlsState(file)).toBe('missing');
    const stat = fs.statSync(file);
    fs.writeFileSync(path.join(directory, 'source.json'), JSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs, durationSeconds: 4 }));
    expect(await getRecordingVodHlsState(file)).toBe('ready');
    fs.writeFileSync(path.join(directory, 'index.m3u8'), '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:20,\nsegment-00000.ts\n#EXT-X-ENDLIST\n');
    expect(await getRecordingVodHlsState(file)).toBe('missing');
    fs.writeFileSync(path.join(directory, 'index.m3u8'), '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4,\nsegment-00000.ts\n#EXT-X-ENDLIST\n');
    fs.writeFileSync(path.join(directory, 'source.json'), JSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs, durationSeconds: 120 }));
    expect(await getRecordingVodHlsState(file)).toBe('missing');
    fs.writeFileSync(path.join(directory, 'source.json'), JSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs, durationSeconds: 4 }));
    fs.rmSync(path.join(directory, 'segment-00000.ts'));
    expect(await getRecordingVodHlsState(file)).toBe('missing');
    fs.writeFileSync(path.join(directory, 'segment-00000.ts'), 'segment');
    fs.appendFileSync(file, 'changed');
    expect(await getRecordingVodHlsState(file)).toBe('missing');
  });

  it('coalesces preparation and atomically publishes only after complete segmentation', async () => {
    const file = master();
    const stale = `${vodHlsDirectory(file)}.part-dead`;
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, 'segment-00000.ts'), 'orphan');
    let finish!: () => void;
    let calls = 0;
    const preparer = new RecordingVodHlsPreparer(async (_command, args) => {
      calls++;
      const playlist = args.at(-1)!;
      fs.writeFileSync(path.join(path.dirname(playlist), 'segment-00000.ts'), 'segment');
      fs.writeFileSync(playlist, '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4,\nsegment-00000.ts\n#EXT-X-ENDLIST\n');
      await new Promise<void>(resolve => { finish = resolve; });
      return { code: 0, stdout: '', stderr: '' };
    });
    const first = preparer.ensure(file, 4);
    const second = preparer.ensure(file, 4);
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(await getRecordingVodHlsState(file)).toBe('missing');
    finish();
    await Promise.all([first, second]);
    expect(await getRecordingVodHlsState(file)).toBe('ready');
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('the authoritative master');
  });

  it('reclaims crash leftovers only after the maximum preparation window', async () => {
    const file = master();
    const stale = `${vodHlsDirectory(file)}.part-crashed`;
    const recent = `${vodHlsDirectory(file)}.part-active`;
    fs.mkdirSync(stale);
    fs.mkdirSync(recent);
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    fs.utimesSync(stale, old, old);
    await removeAbandonedRecordingVodStaging(file);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('refuses to duplicate a recording without space for its package and a reserve', async () => {
    const file = master();
    const runner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const preparer = new RecordingVodHlsPreparer(runner, async () => 0);
    await expect(preparer.ensure(file, 4)).rejects.toThrow('Insufficient free space');
    expect(runner).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe('the authoritative master');
  });

  it('respects the configured recording-storage quota before launching FFmpeg', async () => {
    const file = master();
    const runner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const preparer = new RecordingVodHlsPreparer(runner);
    preparer.setQuotaChecker(async () => false);
    await expect(preparer.ensure(file, 4)).rejects.toThrow('Recording storage limit');
    expect(runner).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(true);
  });

  it('stops and discards an in-progress rendition if disk reserve runs out', async () => {
    const file = master();
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    let checks = 0;
    const runner = vi.fn(async (_command, _args, options) => {
      started();
      return new Promise<{ code: null; stdout: string; stderr: string; aborted: boolean }>(resolve => {
        options?.signal?.addEventListener('abort', () => resolve({ code: null, stdout: '', stderr: '', aborted: true }), { once: true });
      });
    });
    const preparer = new RecordingVodHlsPreparer(runner, async () => ++checks === 1 ? 2_147_483_648 : 0);
    const pending = preparer.ensure(file, 4);
    await running;
    await expect(pending).rejects.toThrow('Insufficient free space while preparing');
    expect(await getRecordingVodHlsState(file)).toBe('missing');
    expect(fs.existsSync(file)).toBe(true);
  }, 10_000);

  it('aborts before deletion and never publishes an interrupted package', async () => {
    const file = master();
    let started!: () => void;
    const preparer = new RecordingVodHlsPreparer((_command, _args, options) => {
      started();
      return new Promise(resolve => options?.signal?.addEventListener('abort', () => {
        resolve({ code: 255, stdout: '', stderr: '', aborted: true });
      }, { once: true }));
    });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const preparing = preparer.ensure(file, 4);
    await entered;
    await preparer.cancel(file);
    await preparing;
    expect(await getRecordingVodHlsState(file)).toBe('missing');
    expect(fs.existsSync(vodHlsDirectory(file))).toBe(false);
  });

  it('rewrites finite segment references with an opaque playback session', () => {
    const original = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4,\nsegment-00000.ts\n#EXT-X-ENDLIST\n';
    const playlist = rewriteRecordingVodPlaylist(original, 'r1', 'session1');
    expect(playlist).toContain('/api/recordings/r1/vod/segment-00000.ts?session=session1');
    expect(playlist).toContain('#EXT-X-ENDLIST');
    expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(playlist).not.toContain('ticket=');
  });
});
