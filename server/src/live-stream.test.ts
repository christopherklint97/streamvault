import { describe, expect, it } from 'vitest';
import {
  ConcurrentStreamLimiter,
  LIVE_MPEG_TS_CONTENT_TYPE,
  buildLiveMpegTsArgs,
  liveFfmpegExitAction,
  selectLivePipeline,
} from './live-stream.js';

describe('buildLiveMpegTsArgs', () => {
  it('copies video and audio while stripping subtitles in normal live mode', () => {
    expect(buildLiveMpegTsArgs(false)).toEqual([
      '-hide_banner', '-loglevel', 'warning',
      '-fflags', '+nobuffer+discardcorrupt',
      '-i', 'pipe:0',
      '-map', '0:v', '-map', '0:a?',
      '-c', 'copy', '-sn',
      '-bsf:v', 'filter_units=remove_types=6|39|40',
      '-f', 'mpegts', 'pipe:1',
    ]);
  });

  it('removes video and emits browser-compatible AAC in audio-only mode', () => {
    const args = buildLiveMpegTsArgs(true);

    expect(args).toContain('-vn');
    expect(args).toContain('0:a:0');
    expect(args).toContain('aac');
    expect(args).not.toContain('0:v');
    expect(args.slice(-3)).toEqual(['-f', 'mpegts', 'pipe:1']);
  });

  it('reconnects when ffmpeg reads an HLS manifest URL', () => {
    const inputUrl = 'http://127.0.0.1:3001/api/stream/live_hls';
    const args = buildLiveMpegTsArgs(true, inputUrl);

    expect(args).toContain('-reconnect');
    expect(args).toContain('-reconnect_streamed');
    expect(args).toContain(inputUrl);
    expect(args).not.toContain('pipe:0');
  });
});

describe('selectLivePipeline', () => {
  it('transcodes HLS through the audio-only pipeline instead of returning video', () => {
    expect(selectLivePipeline({ isM3u8: true, audioOnly: true, keepSubtitles: false })).toBe('ffmpeg-url');
  });

  it('rewrites a normal HLS manifest', () => {
    expect(selectLivePipeline({ isM3u8: true, audioOnly: false, keepSubtitles: false })).toBe('hls-manifest');
  });

  it('uses ffmpeg for MPEG-TS audio-only and subtitle stripping', () => {
    expect(selectLivePipeline({ isM3u8: false, audioOnly: true, keepSubtitles: false })).toBe('ffmpeg-pipe');
    expect(selectLivePipeline({ isM3u8: false, audioOnly: false, keepSubtitles: false })).toBe('ffmpeg-pipe');
  });

  it('passes through MPEG-TS when subtitles are explicitly enabled', () => {
    expect(selectLivePipeline({ isM3u8: false, audioOnly: false, keepSubtitles: true })).toBe('binary');
  });
});

describe('live ffmpeg response handling', () => {
  it('uses MPEG-TS MIME regardless of the upstream type', () => {
    expect(LIVE_MPEG_TS_CONTENT_TYPE).toBe('video/mp2t');
  });

  it('ends only successful streams and surfaces encoder failures', () => {
    expect(liveFfmpegExitAction(0, null, false, true)).toBe('end');
    expect(liveFfmpegExitAction(1, null, false, false)).toBe('send-502');
    expect(liveFfmpegExitAction(1, null, false, true)).toBe('destroy');
    expect(liveFfmpegExitAction(null, 'SIGKILL', true, true)).toBe('ignore');
  });
});

describe('ConcurrentStreamLimiter', () => {
  it('rejects work above the limit and releases each slot exactly once', () => {
    const limiter = new ConcurrentStreamLimiter(2);
    const releaseFirst = limiter.acquire();
    const releaseSecond = limiter.acquire();

    expect(releaseFirst).toBeTypeOf('function');
    expect(releaseSecond).toBeTypeOf('function');
    expect(limiter.acquire()).toBeNull();

    releaseFirst?.();
    releaseFirst?.();
    expect(limiter.activeCount).toBe(1);
    expect(limiter.acquire()).toBeTypeOf('function');
  });
});
