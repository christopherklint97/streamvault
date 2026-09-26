import { describe, expect, it } from 'vitest';
import { recordingHlsPath, recordingTransport } from './recording-transport';

describe('recording playback transport', () => {
  it('uses a demuxer for a TS-only saved recording', () => {
    expect(recordingTransport('2026/09/26/abc.ts')).toBe('mpegts');
  });
  it('keeps completed MP4 recordings on native playback', () => {
    expect(recordingTransport('2026/09/26/abc.mp4')).toBe('native');
  });
  it('preserves the authorized ticket and normalized seek offset for native Apple HLS', () => {
    expect(recordingHlsPath('/api/recordings/abc/stream?ticket=signed%2Fvalue', 21.75))
      .toBe('/api/recordings/abc/hls/index.m3u8?ticket=signed%2Fvalue&start=21.75');
  });
  it('rejects non-recording stream paths', () => {
    expect(() => recordingHlsPath('/api/stream/vod_12', 0)).toThrow();
  });
});
