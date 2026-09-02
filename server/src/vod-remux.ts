/**
 * Build the ffmpeg command for a browser-compatible VOD remux.
 *
 * Fragmented MP4 lets iOS Safari consume streams that arrive from providers
 * in Matroska. Preserve the original video while converting provider audio to
 * stereo AAC-LC, the baseline audio format for browser MP4 playback.
 */
export function buildFragmentedMp4Args(inputUrl: string, isHevc: boolean): string[] {
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-i', inputUrl,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'copy',
    ...(isHevc ? ['-tag:v', 'hvc1'] : []),
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
    '-sn',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+delay_moov',
    '-f', 'mp4', 'pipe:1',
  ];
}
