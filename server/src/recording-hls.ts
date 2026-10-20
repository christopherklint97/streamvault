import { execFile } from 'node:child_process';
import path from 'node:path';
import { H264_AUD_FIRST_ARGS } from './h264-access-units.js';

export function parseRecordingHlsStart(value: unknown, durationSeconds: number): number | null {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,3})?$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 && seconds < durationSeconds ? seconds : null;
}

/** Where a stream-copied rolling session starts: `input` seeks the demuxer, `output` trims to the cut. */
export interface RecordingHlsCut { input: number; output: number }

const KEYFRAME_LOOKBEHIND_SECONDS = 12;
const DEMUX_LEAD_SECONDS = 5;

type Probe = (args: string[]) => Promise<string>;

const runFfprobe: Probe = args => new Promise((resolve, reject) => {
  execFile('ffprobe', args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

/**
 * Cut a stream copy at the last video keyframe at or before `startSeconds`.
 * A bare `-ss` keeps audio from wherever the demuxer lands but video only from
 * the next keyframe, so players hold that future frame while audio runs ahead.
 * Trimming both streams at the keyframe's decode time starts them together.
 */
export async function findRecordingHlsCut(
  masterPath: string, startSeconds: number, probe: Probe = runFfprobe,
): Promise<RecordingHlsCut | null> {
  if (startSeconds <= 0) return null;
  const format = JSON.parse(await probe(['-v', 'error', '-show_entries', 'format=start_time', '-of', 'json', masterPath]));
  const origin = Number(format?.format?.start_time);
  if (!Number.isFinite(origin)) return null;
  const target = origin + startSeconds;
  const from = Math.max(origin, target - KEYFRAME_LOOKBEHIND_SECONDS);
  const listing = JSON.parse(await probe(['-v', 'error', '-select_streams', 'v:0',
    '-read_intervals', `${from.toFixed(3)}%${(target + 0.5).toFixed(3)}`,
    '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'json', masterPath]));
  let keyframeDts: number | null = null;
  for (const packet of Array.isArray(listing?.packets) ? listing.packets : []) {
    const pts = Number(packet?.pts_time);
    const dts = Number(packet?.dts_time);
    if (typeof packet?.flags === 'string' && packet.flags.startsWith('K') &&
        Number.isFinite(pts) && Number.isFinite(dts) && pts <= target + 0.001 && dts >= origin) {
      keyframeDts = Math.max(keyframeDts ?? dts, dts);
    }
  }
  if (keyframeDts === null) return null;
  const cut = keyframeDts - origin;
  const input = Math.max(0, cut - DEMUX_LEAD_SECONDS);
  // Output timestamps restart at `input`; stay a millisecond early so the
  // keyframe itself is never trimmed by float rounding.
  return { input: Number(input.toFixed(3)), output: Number(Math.max(0, cut - input - 0.001).toFixed(3)) };
}

/** Native iOS HLS reads a local recording at near playback rate, never whole-file at once. */
export function buildRecordingHlsArgs(
  masterPath: string, playlistPath: string, startSeconds = 0, cut: RecordingHlsCut | null = null, h264 = false,
): string[] {
  const inputSeek = cut ? cut.input : startSeconds;
  return [
    '-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts+discardcorrupt',
    ...(inputSeek > 0 ? ['-ss', String(inputSeek)] : []),
    '-readrate', '1.1', '-readrate_initial_burst', '20',
    '-i', masterPath,
    ...(cut && cut.output > 0 ? ['-ss', String(cut.output)] : []),
    '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-sn',
    ...(h264 ? H264_AUD_FIRST_ARGS : []),
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '120', '-hls_delete_threshold', '30',
    '-hls_flags', 'delete_segments+temp_file',
    '-hls_segment_filename', path.join(path.dirname(playlistPath), 'segment-%05d.ts'),
    playlistPath,
  ];
}
