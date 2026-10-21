import { spawn } from 'node:child_process';

/** Build iPhone-safe HLS output from an arbitrary VOD source. */
export type IosHlsVideoMode = 'copy' | 'transcode';
export type IosHlsAudioMode = 'copy' | 'transcode';

export interface IosHlsMediaModes {
  video: IosHlsVideoMode;
  audio: IosHlsAudioMode;
}

export function iosHlsModesNeedRetry(modes: IosHlsMediaModes): boolean {
  return modes.video !== 'copy' || modes.audio !== 'copy';
}

interface IosHlsProbeStream {
  codec_type?: unknown;
  codec_name?: unknown;
  profile?: unknown;
  level?: unknown;
  pix_fmt?: unknown;
  width?: unknown;
  height?: unknown;
  r_frame_rate?: unknown;
  channels?: unknown;
  bit_rate?: unknown;
  tags?: { BPS?: unknown };
}

interface IosHlsProbeOutput {
  streams: IosHlsProbeStream[];
  formatBitRate: number;
}

function parseProbeOutput(probeOutput: string): IosHlsProbeOutput {
  try {
    const parsed = JSON.parse(probeOutput) as { streams?: unknown; format?: { bit_rate?: unknown } };
    return {
      streams: Array.isArray(parsed.streams) ? parsed.streams as IosHlsProbeStream[] : [],
      formatBitRate: Number(parsed.format?.bit_rate),
    };
  } catch {
    return { streams: [], formatBitRate: Number.NaN };
  }
}

function parseProbeStreams(probeOutput: string): IosHlsProbeStream[] {
  return parseProbeOutput(probeOutput).streams;
}

/** Matroska leaves stream bit_rate empty; its BPS statistics tag, then the container rate, stand in. */
function videoBitRate(video: IosHlsProbeStream, formatBitRate: number): number {
  for (const candidate of [video.bit_rate, video.tags?.BPS, formatBitRate]) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return Number.NaN;
}

function parseFrameRate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const [numeratorText, denominatorText = '1'] = value.split('/');
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const frameRate = numerator / denominator;
  return frameRate > 0 ? frameRate : null;
}

export function buildIosHlsProbeArgs(inputUrl: string): string[] {
  return [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,profile,level,pix_fmt,width,height,r_frame_rate,channels,bit_rate:stream_tags=BPS:format=bit_rate',
    '-of', 'json',
    inputUrl,
  ];
}

export function selectIosHlsVideoMode(probeOutput: string): IosHlsVideoMode {
  const { streams, formatBitRate } = parseProbeOutput(probeOutput);
  const video = streams.find(stream => stream.codec_type === 'video')
    ?? streams.find(stream => typeof stream.width === 'number' && typeof stream.height === 'number');
  if (!video) return 'transcode';

  const profile = typeof video.profile === 'string' ? video.profile : '';
  const level = typeof video.level === 'number' ? video.level : Number.NaN;
  const width = typeof video.width === 'number' ? video.width : Number.NaN;
  const height = typeof video.height === 'number' ? video.height : Number.NaN;
  const frameRate = parseFrameRate(video.r_frame_rate);
  const bitRate = videoBitRate(video, formatBitRate);
  const compatibleProfiles = new Set(['Baseline', 'Constrained Baseline', 'Main', 'High']);
  const dimensionsCompatible = Math.max(width, height) <= 1920 && Math.min(width, height) <= 1080;

  return video.codec_name === 'h264'
    && compatibleProfiles.has(profile)
    && Number.isFinite(level)
    && level > 0
    && level <= 42
    && (video.pix_fmt === 'yuv420p' || video.pix_fmt === 'yuvj420p')
    && dimensionsCompatible
    && frameRate !== null
    && frameRate <= 60
    && Number.isFinite(bitRate)
    && bitRate > 0
    && bitRate <= 6_000_000
    ? 'copy'
    : 'transcode';
}

export function selectIosHlsAudioMode(probeOutput: string): IosHlsAudioMode {
  const audio = parseProbeStreams(probeOutput).find(stream => stream.codec_type === 'audio');
  const compatibleProfiles = new Set(['LC', 'HE-AAC', 'HE-AACv2']);
  return audio?.codec_name === 'aac'
    && typeof audio.profile === 'string'
    && compatibleProfiles.has(audio.profile)
    && typeof audio.channels === 'number'
    && audio.channels > 0
    && audio.channels <= 8
    ? 'copy'
    : 'transcode';
}

const IOS_HLS_PROBE_TIMEOUT_MS = 10_000;
const IOS_HLS_PROBE_OUTPUT_LIMIT = 64 * 1024;
const TRANSCODE_MEDIA_MODES: IosHlsMediaModes = { video: 'transcode', audio: 'transcode' };

export function probeIosHlsMediaModes(inputUrl: string): Promise<IosHlsMediaModes> {
  return new Promise((resolve) => {
    const ffprobe = spawn('ffprobe', buildIosHlsProbeArgs(inputUrl), { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let settled = false;
    const finish = (modes: IosHlsMediaModes) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(modes);
    };
    const timer = setTimeout(() => {
      if (!ffprobe.killed) ffprobe.kill('SIGKILL');
      finish(TRANSCODE_MEDIA_MODES);
    }, IOS_HLS_PROBE_TIMEOUT_MS);
    timer.unref();

    ffprobe.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > IOS_HLS_PROBE_OUTPUT_LIMIT) {
        if (!ffprobe.killed) ffprobe.kill('SIGKILL');
        finish(TRANSCODE_MEDIA_MODES);
      }
    });
    ffprobe.on('error', () => finish(TRANSCODE_MEDIA_MODES));
    ffprobe.on('close', (code) => finish(code === 0
      ? { video: selectIosHlsVideoMode(stdout), audio: selectIosHlsAudioMode(stdout) }
      : TRANSCODE_MEDIA_MODES));
  });
}

export async function probeIosHlsVideoMode(inputUrl: string): Promise<IosHlsVideoMode> {
  return (await probeIosHlsMediaModes(inputUrl)).video;
}

export function buildIosHlsRecoveryUrl(
  channelId: string,
  sourceUrl: string,
  contentType: 'series' | 'movies',
  startSeconds = 0,
): string {
  const params = new URLSearchParams({ url: sourceUrl, type: contentType });
  if (startSeconds > 0) params.set('start', String(startSeconds));
  return `/api/ios-hls-authorize/${encodeURIComponent(channelId)}/index.m3u8?${params.toString()}`;
}

export function iosHlsContentType(channelId: string, requestedType?: unknown): 'series' | 'movies' | null {
  if (channelId.startsWith('episode_')) return 'series';
  if (channelId.startsWith('vod_') || requestedType === 'movies') return 'movies';
  return null;
}

export function buildIosHlsArgs(
  inputUrl: string,
  playlistPath: string,
  startSeconds = 0,
  videoMode: IosHlsVideoMode = 'transcode',
  audioMode: IosHlsAudioMode = 'transcode',
): string[] {
  const slash = playlistPath.lastIndexOf('/');
  const outputDir = slash >= 0 ? playlistPath.slice(0, slash) : '.';
  // Mixed copy/transcode pipelines can introduce codec delay and A/V skew.
  // Preserve both source timelines together, or transcode both together.
  const copyMedia = videoMode === 'copy' && audioMode === 'copy';
  const videoArgs = copyMedia
    ? ['-c:v', 'copy']
    : [
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p',
      '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-force_key_frames', 'expr:gte(t,n_forced*4)',
    ];
  const audioArgs = copyMedia
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'];
  const pacingArgs = ['-readrate', '1.1', '-readrate_initial_burst', '30'];

  return [
    '-hide_banner', '-loglevel', 'warning',
    ...(startSeconds > 0 ? ['-ss', String(startSeconds)] : []),
    '-reconnect', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    ...pacingArgs,
    '-i', inputUrl,
    '-map', '0:v:0', '-map', '0:a:0?',
    ...videoArgs,
    ...audioArgs,
    '-sn',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '300',
    '-hls_delete_threshold', '30',
    '-hls_segment_type', 'fmp4',
    '-hls_flags', 'independent_segments+delete_segments',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', `${outputDir}/segment-%05d.m4s`,
    playlistPath,
  ];
}
