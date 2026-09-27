import path from 'node:path';

export function parseRecordingHlsStart(value: unknown, durationSeconds: number): number | null {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,3})?$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 && seconds < durationSeconds ? seconds : null;
}

/** Native iOS HLS reads a local recording at near playback rate, never whole-file at once. */
export function buildRecordingHlsArgs(masterPath: string, playlistPath: string, startSeconds = 0): string[] {
  return [
    '-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts+discardcorrupt',
    ...(startSeconds > 0 ? ['-ss', String(startSeconds)] : []),
    '-readrate', '1.1', '-readrate_initial_burst', '20',
    '-i', masterPath, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-sn',
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '120', '-hls_delete_threshold', '30',
    '-hls_flags', 'delete_segments+temp_file',
    '-hls_segment_filename', path.join(path.dirname(playlistPath), 'segment-%05d.ts'),
    playlistPath,
  ];
}