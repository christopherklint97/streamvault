/** Build iPhone-safe HLS output from an arbitrary VOD source. */
export function buildIosHlsArgs(inputUrl: string, playlistPath: string, startSeconds = 0): string[] {
  const slash = playlistPath.lastIndexOf('/');
  const outputDir = slash >= 0 ? playlistPath.slice(0, slash) : '.';
  return [
    '-hide_banner', '-loglevel', 'warning',
    ...(startSeconds > 0 ? ['-ss', String(startSeconds)] : []),
    '-i', inputUrl,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k',
    '-sn',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '0',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', `${outputDir}/segment-%05d.m4s`,
    playlistPath,
  ];
}
