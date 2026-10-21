import { describe, expect, it } from 'vitest';
import {
  buildIosHlsArgs,
  buildIosHlsProbeArgs,
  buildIosHlsRecoveryUrl,
  iosHlsContentType,
  iosHlsModesNeedRetry,
  selectIosHlsAudioMode,
  selectIosHlsVideoMode,
  stabilizeIosHlsPlaylist,
} from './ios-hls';

describe('buildIosHlsArgs', () => {
  it('classifies catalogue VOD as movie HLS instead of rejecting it', () => {
    expect(iosHlsContentType('vod_83608')).toBe('movies');
  });

  it('reauthorizes an expired HLS session without losing its playback position', () => {
    expect(buildIosHlsRecoveryUrl(
      'vod_42',
      'https://provider.example/movie/42.mp4',
      'movies',
      123.456,
    )).toBe('/api/ios-hls-authorize/vod_42/index.m3u8?url=https%3A%2F%2Fprovider.example%2Fmovie%2F42.mp4&type=movies&start=123.456');
  });

  it('classifies manual-M3U movie IDs from the explicit content type', () => {
    expect(iosHlsContentType('1m9dt3', 'movies')).toBe('movies');
  });

  it('seeks before input when starting an HLS session at a requested time', () => {
    expect(buildIosHlsArgs('http://source', '/tmp/index.m3u8', 120)).toContain('-ss');
  });

  it('reconnects its HTTP input when a long provider stream drops', () => {
    const args = buildIosHlsArgs('http://source', '/tmp/session/index.m3u8');
    expect(args).toContain('-reconnect');
    expect(args).toContain('-reconnect_on_network_error');
    expect(args).toContain('-reconnect_streamed');
    expect(args).toContain('-reconnect_delay_max');
  });

  it('forces short independent segments so iPhone playback starts promptly', () => {
    const args = buildIosHlsArgs('http://source', '/tmp/session/index.m3u8');
    expect(args).toContain('-force_key_frames');
    expect(args).toContain('expr:gte(t,n_forced*4)');
    expect(args).toContain('-hls_flags');
    expect(args).toContain('independent_segments+delete_segments');
  });

  it('copies compatible AAC audio with video so timestamps stay synchronized', () => {
    const probeOutput = JSON.stringify({
      streams: [
        { codec_type: 'video', codec_name: 'h264', profile: 'High', level: 40, pix_fmt: 'yuv420p', width: 1920, height: 1040, r_frame_rate: '24000/1001', bit_rate: '2249147' },
        { codec_type: 'audio', codec_name: 'aac', profile: 'LC', channels: 6 },
      ],
    });
    const args = buildIosHlsArgs(
      'http://source',
      '/tmp/session/index.m3u8',
      0,
      selectIosHlsVideoMode(probeOutput),
      selectIosHlsAudioMode(probeOutput),
    );
    const audioCodecIndex = args.indexOf('-c:a');

    expect(selectIosHlsAudioMode(probeOutput)).toBe('copy');
    expect(args[audioCodecIndex + 1]).toBe('copy');
    expect(args).not.toContain('-ac');
  });

  it('transcodes unsupported provider audio to browser-safe stereo AAC', () => {
    const probeOutput = JSON.stringify({
      streams: [{ codec_type: 'audio', codec_name: 'dts', profile: 'DTS', channels: 6 }],
    });
    const args = buildIosHlsArgs('http://source', '/tmp/session/index.m3u8', 0, 'copy', selectIosHlsAudioMode(probeOutput));

    expect(selectIosHlsAudioMode(probeOutput)).toBe('transcode');
    expect(args).toContain('aac');
    expect(args).toContain('-ac');
    expect(args).toContain('2');
  });

  it('probes the primary media metadata needed for safe copy-mode selection', () => {
    expect(buildIosHlsProbeArgs('http://source')).toEqual([
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,profile,level,pix_fmt,width,height,r_frame_rate,channels,bit_rate:stream_tags=BPS:format=bit_rate',
      '-of', 'json',
      'http://source',
    ]);
  });

  it('stream-copies iPhone-compatible H.264 video instead of CPU-bound transcoding', () => {
    const mode = selectIosHlsVideoMode(JSON.stringify({
      streams: [{ codec_type: 'video', codec_name: 'h264', profile: 'High', level: 40, pix_fmt: 'yuv420p', width: 1920, height: 1040, r_frame_rate: '24000/1001', bit_rate: '2249147' }],
    }));
    const args = buildIosHlsArgs('http://source', '/tmp/session/index.m3u8', 0, mode, 'copy');

    expect(mode).toBe('copy');
    expect(args).toContain('copy');
    expect(args).not.toContain('libx264');
    expect(args).not.toContain('-force_key_frames');
  });

  it('uses the transcode fallback for HEVC until Apple sample-entry compatibility is guaranteed', () => {
    expect(selectIosHlsVideoMode(JSON.stringify({
      streams: [{ codec_type: 'video', codec_name: 'hevc', profile: 'Main 10', level: 120, pix_fmt: 'yuv420p10le', width: 1920, height: 1080, r_frame_rate: '24000/1001' }],
    }))).toBe('transcode');
  });

  it('rejects H.264 outside the bounded iPhone compatibility envelope', () => {
    expect(selectIosHlsVideoMode(JSON.stringify({
      streams: [{ codec_type: 'video', codec_name: 'h264', profile: 'High 10', level: 51, pix_fmt: 'yuv420p10le', width: 3840, height: 2160, r_frame_rate: '120/1' }],
    }))).toBe('transcode');
  });

  it('fails closed for unknown levels and streams that can exceed the rolling storage budget', () => {
    const base = {
      codec_type: 'video', codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p',
      width: 1920, height: 1080, r_frame_rate: '24000/1001', bit_rate: '2249147',
    };
    expect(selectIosHlsVideoMode(JSON.stringify({ streams: [{ ...base, level: -99 }] }))).toBe('transcode');
    expect(selectIosHlsVideoMode(JSON.stringify({ streams: [{ ...base, level: 40, bit_rate: '6000001' }] }))).toBe('transcode');
    expect(selectIosHlsVideoMode(JSON.stringify({ streams: [{ ...base, level: 40, bit_rate: 'N/A' }] }))).toBe('transcode');
  });

  it('reads Matroska stream rates from the BPS tag or the container when bit_rate is missing', () => {
    // An H.264 High@4.0 720p59.94 MKV episode reports bit_rate=N/A for its video stream.
    const mkv = {
      codec_type: 'video', codec_name: 'h264', profile: 'High', level: 40, pix_fmt: 'yuv420p',
      width: 1280, height: 720, r_frame_rate: '19001/317', bit_rate: 'N/A',
    };
    expect(selectIosHlsVideoMode(JSON.stringify({ streams: [{ ...mkv, tags: { BPS: '5375372' } }] }))).toBe('copy');
    expect(selectIosHlsVideoMode(JSON.stringify({ streams: [mkv], format: { bit_rate: '5507419' } }))).toBe('copy');
    expect(selectIosHlsVideoMode(JSON.stringify({ streams: [{ ...mkv, tags: { BPS: '6000001' } }] }))).toBe('transcode');
  });

  it('paces and fully transcodes mixed compatibility instead of risking A/V skew', () => {
    const args = buildIosHlsArgs('http://source', '/tmp/session/index.m3u8', 0, 'copy', 'transcode');
    const videoCodecIndex = args.indexOf('-c:v');
    const audioCodecIndex = args.indexOf('-c:a');

    expect(args[videoCodecIndex + 1]).toBe('libx264');
    expect(args[audioCodecIndex + 1]).toBe('aac');
    expect(args[args.indexOf('-readrate') + 1]).toBe('1.25');
  });

  it('builds a growing lead ahead of the player inside a bounded rolling window', () => {
    const args = buildIosHlsArgs('http://source', '/tmp/session/index.m3u8', 0, 'copy', 'copy');

    // AVPlayer buffers only what is published beyond its live start point.
    expect(args[args.indexOf('-readrate') + 1]).toBe('1.25');
    expect(args[args.indexOf('-readrate_initial_burst') + 1]).toBe('120');
    expect(args[args.indexOf('-hls_list_size') + 1]).toBe('900');
    expect(args).toContain('-hls_delete_threshold');
    expect(args[args.indexOf('-hls_delete_threshold') + 1]).toBe('30');
    expect(args).toContain('independent_segments+delete_segments');
  });

  it('keeps the H.264 transcode fallback for incompatible video codecs', () => {
    const mode = selectIosHlsVideoMode(JSON.stringify({
      streams: [{ codec_name: 'mpeg4', pix_fmt: 'yuv420p', width: 1280, height: 720 }],
    }));
    const args = buildIosHlsArgs('http://source', '/tmp/session/index.m3u8', 0, mode);

    expect(mode).toBe('transcode');
    expect(args).toContain('libx264');
    expect(args).toContain('ultrafast');
    expect(args).toContain('-vf');
    expect(args).toContain('-force_key_frames');
  });

  it('fails closed to transcoding when probe metadata is malformed', () => {
    expect(selectIosHlsVideoMode('not-json')).toBe('transcode');
    expect(selectIosHlsVideoMode(JSON.stringify({ streams: [] }))).toBe('transcode');
  });

  it('retries any probe result that would trigger the expensive fallback', () => {
    expect(iosHlsModesNeedRetry({ video: 'transcode', audio: 'transcode' })).toBe(true);
    expect(iosHlsModesNeedRetry({ video: 'copy', audio: 'transcode' })).toBe(true);
    expect(iosHlsModesNeedRetry({ video: 'copy', audio: 'copy' })).toBe(false);
  });

  it('creates H.264/AAC fragmented-MP4 HLS for iPhone playback', () => {
    const args = buildIosHlsArgs('http://127.0.0.1:3001/api/stream/episode_177574', '/tmp/session/index.m3u8');
    expect(args).toContain('-f');
    expect(args).toContain('hls');
    expect(args).toContain('-c:v');
    expect(args).toContain('libx264');
    expect(args).toContain('-c:a');
    expect(args).toContain('aac');
    expect(args).toContain('-hls_segment_type');
    expect(args).toContain('fmp4');
  });

  it('advertises a fixed target duration so copied keyframe-cut segments never exceed it', () => {
    const early = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.387000,\nsegment-00000.m4s\n';
    const later = early.replace('TARGETDURATION:4', 'TARGETDURATION:7') + '#EXTINF:6.707000,\nsegment-00001.m4s\n';
    expect(stabilizeIosHlsPlaylist(early)).toContain('#EXT-X-TARGETDURATION:10\n');
    expect(stabilizeIosHlsPlaylist(later)).toContain('#EXT-X-TARGETDURATION:10\n');
    expect(stabilizeIosHlsPlaylist(later.replace('TARGETDURATION:7', 'TARGETDURATION:12'))).toContain('#EXT-X-TARGETDURATION:12\n');
  });
});
