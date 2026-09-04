/** Build iPhone-safe HLS output from an arbitrary VOD source. */
export function iosHlsContentType(channelId: string, requestedType?: unknown): 'series' | 'movies' | null {
  if (channelId.startsWith('episode_')) return 'series';
  if (channelId.startsWith('vod_') || requestedType === 'movies') return 'movies';
  return null;
}

export function buildIosHlsArgs(inputUrl: string, playlistPath: string, startSeconds = 0): string[] {
  const slash = playlistPath.lastIndexOf('/');
  const outputDir = slash >= 0 ? playlistPath.slice(0, slash) : '.';
  return [
    '-hide_banner', '-loglevel', 'warning',
    ...(startSeconds > 0 ? ['-ss', String(startSeconds)] : []),
    '-reconnect', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', inputUrl,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-force_key_frames', 'expr:gte(t,n_forced*4)',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-sn',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '0',
    '-hls_segment_type', 'fmp4',
    '-hls_flags', 'independent_segments',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', `${outputDir}/segment-%05d.m4s`,
    playlistPath,
  ];
}
