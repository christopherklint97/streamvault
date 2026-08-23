/**
 * Build FFmpeg arguments that convert video browsers cannot decode from a
 * Matroska source into streamable H.264/AAC fragmented MP4.
 */
export function buildBrowserCompatibleVideoArgs(inputUrl: string, startSeconds = 0): string[] {
  return [
    '-hide_banner', '-loglevel', 'warning',
    ...(startSeconds > 0 ? ['-ss', String(startSeconds)] : []),
    '-i', inputUrl,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k',
    '-sn',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4', 'pipe:1',
  ];
}
