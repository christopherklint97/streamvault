/**
 * Build the ffmpeg command for a browser-compatible VOD remux.
 *
 * Fragmented MP4 lets iOS Safari consume HEVC/AAC streams that arrive from
 * providers in Matroska. This is stream-copy only: video and audio are never
 * decoded or re-encoded.
 */
export function buildFragmentedMp4Args(inputUrl: string, isHevc: boolean): string[] {
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-i', inputUrl,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c', 'copy',
    ...(isHevc ? ['-tag:v', 'hvc1'] : []),
    '-sn',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+delay_moov',
    '-f', 'mp4', 'pipe:1',
  ];
}
