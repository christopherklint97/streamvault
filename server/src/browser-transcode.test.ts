import { describe, expect, it } from 'vitest';
import { buildBrowserCompatibleVideoArgs } from './browser-transcode';

describe('buildBrowserCompatibleVideoArgs', () => {
  it('seeks before input so a restarted transcode begins at requested episode time', () => {
    expect(buildBrowserCompatibleVideoArgs('http://127.0.0.1:3001/api/stream/episode_177574', 120)).toContain('-ss');
    expect(buildBrowserCompatibleVideoArgs('http://127.0.0.1:3001/api/stream/episode_177574', 120)).toContain('120');
  });

  it('transcodes browser-incompatible MKV video to fragmented H.264/AAC MP4', () => {
    expect(buildBrowserCompatibleVideoArgs('http://127.0.0.1:3001/api/stream/episode_177574')).toEqual([
      '-hide_banner', '-loglevel', 'warning',
      '-i', 'http://127.0.0.1:3001/api/stream/episode_177574',
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k',
      '-sn',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1',
    ]);
  });
});
