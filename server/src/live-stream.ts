export const LIVE_MPEG_TS_CONTENT_TYPE = 'video/mp2t';

export type LivePipeline = 'hls-manifest' | 'ffmpeg-url' | 'ffmpeg-pipe' | 'binary';

export function selectLivePipeline(options: {
  isM3u8: boolean;
  audioOnly: boolean;
  keepSubtitles: boolean;
}): LivePipeline {
  if (options.isM3u8) return options.audioOnly ? 'ffmpeg-url' : 'hls-manifest';
  if (options.audioOnly || !options.keepSubtitles) return 'ffmpeg-pipe';
  return 'binary';
}

/** Build the ffmpeg pipeline used by the live MPEG-TS proxy. */
export function buildLiveMpegTsArgs(audioOnly: boolean, source = 'pipe:0'): string[] {
  const networkReconnect = source === 'pipe:0'
    ? []
    : ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
  const input = [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+nobuffer+discardcorrupt',
    ...networkReconnect,
    '-i', source,
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

export type LiveFfmpegExitAction = 'end' | 'send-502' | 'destroy' | 'ignore';

export function liveFfmpegExitAction(
  code: number | null,
  _signal: NodeJS.Signals | null,
  clientClosed: boolean,
  headersSent: boolean,
): LiveFfmpegExitAction {
  if (clientClosed) return 'ignore';
  if (code === 0) return 'end';
  return headersSent ? 'destroy' : 'send-502';
}

export class ConcurrentStreamLimiter {
  private readonly limit: number;
  private active = 0;

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  get activeCount(): number {
    return this.active;
  }

  acquire(): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }
}
