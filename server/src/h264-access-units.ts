import { execFile } from 'node:child_process';

/**
 * Some providers place the access unit delimiter after the SPS/PPS of every
 * keyframe. Desktop decoders accept that, but Apple's native HLS player will
 * not start video on such keyframes after a load or seek: it plays audio
 * against a frozen later frame for one to two segments. Rewriting each access
 * unit to start with its delimiter is a lossless stream-copy fix.
 * Only valid for H.264 video; FFmpeg rejects the filter for other codecs.
 */
export const H264_AUD_FIRST_ARGS = ['-bsf:v', 'h264_metadata=aud=remove,h264_metadata=aud=insert'] as const;

/** FFmpeg's message when a video stream is not H.264. */
export const isUnsupportedBitstreamFilterError = (stderr: string): boolean =>
  /not supported by the bitstream filter/i.test(stderr);

/** MPEG-TS input lists the stream once per program as well, so read the first entry. */
export const firstCodecName = (stdout: string): string | null =>
  stdout.split('\n').map(line => line.trim()).find(Boolean) ?? null;

export function probeVideoCodec(file: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1', file], { timeout: 10_000, maxBuffer: 64 * 1024 },
    (error, stdout) => resolve(error ? null : firstCodecName(stdout)));
  });
}
