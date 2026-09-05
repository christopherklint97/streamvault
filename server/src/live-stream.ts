/** Build the ffmpeg pipeline used by the live MPEG-TS proxy. */
export function buildLiveMpegTsArgs(audioOnly: boolean): string[] {
  const input = [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+nobuffer+discardcorrupt',
    '-i', 'pipe:0',
  ];

  if (audioOnly) {
    return [
      ...input,
      '-map', '0:a:0', '-vn', '-sn',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000',
      '-f', 'mpegts', 'pipe:1',
    ];
  }

  return [
    ...input,
    '-map', '0:v', '-map', '0:a?',
    '-c', 'copy', '-sn',
    '-bsf:v', 'filter_units=remove_types=6|39|40',
    '-f', 'mpegts', 'pipe:1',
  ];
}
