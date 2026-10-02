import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { ArchiveStore } from './archive-store.js';

const exec = promisify(execFile);
type Packet = { stream_index: number; pts_time: string; dts_time?: string; duration_time?: string; flags: string; data_hash: string };
type PriorPacket = Packet & { priorTime?: number };
type Probe = { streams: Array<{ index: number; codec_type: string; codec_name: string;
  profile?: string; level?: number; width?: number; height?: number; pix_fmt?: string;
  avg_frame_rate?: string; sample_rate?: string; channels?: number }>;
  packets: Packet[]; format?: { duration?: string } };

async function probe(file: string, signal?: AbortSignal): Promise<Probe | undefined> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024 * 1024) return undefined;
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_packets',
    '-show_format', '-show_data_hash', 'sha256', '-show_entries',
    'stream=index,codec_type,codec_name,profile,level,width,height,pix_fmt,avg_frame_rate,sample_rate,channels:packet=stream_index,pts_time,dts_time,duration_time,flags,data_hash:format=duration',
    '-of', 'json', file], { timeout: 15_000, maxBuffer: 5 * 1024 * 1024, signal });
  return JSON.parse(stdout) as Probe;
}

function streams(media: Probe): { audio: Packet[]; video: Packet[] } | undefined {
  if (media.streams.length !== 2) return undefined;
  const video = media.streams.find(s => s.codec_type === 'video' && s.codec_name === 'h264');
  const audio = media.streams.find(s => s.codec_type === 'audio' && s.codec_name === 'aac');
  if (!video || !audio) return undefined;
  const selected = (index: number) => media.packets.filter(p => p.stream_index === index &&
    Number.isFinite(Number(p.pts_time)) && /^SHA256:[a-f0-9]{64}$/i.test(p.data_hash));
  const v = selected(video.index); const a = selected(audio.index);
  return v.length >= 20 && a.length >= 40 ? { video: v, audio: a } : undefined;
}

/** Only a contiguous, byte-identical previous suffix/new prefix is evidence.
 * Compare both elementary streams, never just clocks or a short hash sample. */
function prefixMatchWindow(previous: PriorPacket[], next: Packet[]):
  { duration: number; start: number; end: number } | undefined {
  const candidates: Array<{ duration: number; start: number; end: number }> = [];
  for (let i = 0; i < previous.length; i++) {
    if (previous[i].data_hash !== next[0]?.data_hash) continue;
    const available = Math.min(previous.length - i, next.length);
    let count = 0;
    while (count < available && previous[i + count].data_hash === next[count].data_hash) count++;
    // An upstream cut can leave one or two differently packetized final
    // video packets. A mismatch earlier in the overlap is not evidence of a
    // replay, and an entirely duplicated next segment needs separate handling.
    if (previous.length - i - count > 2 || count >= next.length) continue;
    if (count < 2) continue;
    const start = Number(next[0].pts_time);
    const end = Number(next[count - 1].pts_time) + Number(next[count - 1].duration_time || 0);
    const priorStart = previous[i].priorTime ?? Number(previous[i].pts_time);
    const last = previous[i + count - 1];
    const priorEnd = (last.priorTime ?? Number(last.pts_time)) + Number(last.duration_time || 0);
    if (end - start >= 2 && Number.isFinite(priorStart) && Number.isFinite(priorEnd))
      candidates.push({ duration: end - start, start: priorStart, end: priorEnd });
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function matchedPrefix(previous: Packet[], next: Packet[]): number | undefined {
  return prefixMatchWindow(previous, next)?.duration;
}

/** A whole chunk may be replayed, not just its beginning. Require identical
 * A/V payloads in the SAME prior file and at the same time there. Matching
 * video and unrelated, repeating AAC at different moments cannot hide media. */
function fullMatchWindows(previous: Packet[], next: Packet[]): Array<{ start: number; end: number }> {
  if (next.length < 20 || next.length > previous.length) return [];
  const start = Number(next[0].pts_time);
  const end = Number(next.at(-1)!.pts_time) + Number(next.at(-1)!.duration_time || 0);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 2) return [];
  const windows: Array<{ start: number; end: number }> = [];
  for (let i = 0; i <= previous.length - next.length; i++) {
    if (previous[i].data_hash !== next[0].data_hash ||
        !next.every((packet, j) => packet.data_hash === previous[i + j].data_hash)) continue;
    windows.push({ start: Number(previous[i].pts_time),
      end: Number(previous[i + next.length - 1].pts_time) + Number(previous[i + next.length - 1].duration_time || 0) });
  }
  return windows.filter(w => Number.isFinite(w.start) && Number.isFinite(w.end));
}

export function fullDuplicateInSameWindow(prior: Array<{ video: Packet[]; audio: Packet[] }>,
  current: { video: Packet[]; audio: Packet[] }): boolean {
  return prior.some(part => {
    const video = fullMatchWindows(part.video, current.video);
    const audio = fullMatchWindows(part.audio, current.audio);
    return video.some(v => audio.some(a => Math.abs(v.start - a.start) <= 0.5 &&
      Math.abs(v.end - a.end) <= 0.5));
  });
}

function frameRate(value?: string): { rate: number; timeBase: string } | undefined {
  const match = /^(\d+)\/(\d+)$/.exec(value || '');
  if (!match) return undefined;
  const numerator = Number(match[1]); const denominator = Number(match[2]);
  const rate = numerator / denominator;
  return numerator > 0 && denominator > 0 && rate >= 12 && rate <= 60
    ? { rate, timeBase: `${denominator}:${numerator}` } : undefined;
}

async function decodedVideoFrames(file: string, signal?: AbortSignal): Promise<{ hashes: string[]; decoderError: boolean }> {
  const { stdout, stderr } = await exec('nice', ['-n', '15', 'ionice', '-c', '3', 'ffmpeg',
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
    '-i', file, '-map', '0:v:0', '-an', '-vsync', '0', '-pix_fmt', 'yuv420p',
    '-f', 'framemd5', 'pipe:1'], { timeout: 45_000, maxBuffer: 2 * 1024 * 1024, signal });
  const hashes = stdout.split('\n').filter(line => line && !line.startsWith('#'))
    .map(line => line.split(',').at(-1)?.trim() || '');
  if (hashes.length < 20 || hashes.some(hash => !/^[a-f0-9]{32}$/i.test(hash)))
    throw new Error('Invalid decoded video frame inventory');
  const errors = stderr.trim().split(/\r?\n/).filter(Boolean);
  if (errors.some(line => !/^\[h264 @ 0x[\da-f]+\] error while decoding MB \d+ \d+, bytestream -?\d+$/i.test(line)))
    throw new Error('Unclassified video decoder error');
  return { hashes, decoderError: errors.length > 0 };
}

/** Inspect only decoded-frame timing; never surface FFmpeg diagnostics or paths. */
export function localizedTerminalDecoderError(trace: string, terminalTime: number, fps: number): boolean {
  const lines = trace.split(/\r?\n/);
  const diagnostics = lines.map((line, index) => ({ line, index }))
    .filter(({ line }) => /error|invalid|corrupt|conceal|missing reference/i.test(line));
  const damage = diagnostics.filter(({ line }) =>
    /^\[h264 @ 0x[\da-f]+\] error while decoding MB \d+ \d+, bytestream -?\d+$/i.test(line));
  const conceal = diagnostics.filter(({ line }) =>
    /^\[h264 @ 0x[\da-f]+\] concealing \d+ DC, \d+ AC, \d+ MV errors in [IPB] frame$/i.test(line));
  const corrupt = diagnostics.filter(({ line }) =>
    /^\[vist#\d+:\d+\/h264 @ 0x[\da-f]+\] \[dec:h264 @ 0x[\da-f]+\] corrupt decoded frame$/i.test(line));
  if (damage.length !== 1 || conceal.length > 1 || corrupt.length > 1 ||
      diagnostics.length !== damage.length + conceal.length + corrupt.length ||
      diagnostics.some(({ index }) => index < damage[0].index)) return false;
  // H.264 B-frames may flush earlier presentation-time pictures after the
  // macroblock error. The decoder's explicit corrupt-frame marker, when
  // present, identifies the damaged picture more reliably than the first
  // post-error frame; require every intervening output to stay near the tail.
  const markerIndex = corrupt[0]?.index ?? damage[0].index;
  const intermediate = lines.slice(damage[0].index + 1, markerIndex)
    .filter(line => line.includes('decoder -> pts:'));
  if (intermediate.length > 4 || intermediate.some(line => {
    const pts = /decoder -> pts:[^\n]*?pts_time:([\d.-]+)/.exec(line);
    const time = Number(pts?.[1]);
    return !pts || !Number.isFinite(time) || time < terminalTime - 4 / fps || time > terminalTime;
  })) return false;
  const nextFrameIndex = lines.findIndex((line, index) =>
    index > markerIndex && line.includes('decoder -> pts:'));
  if (nextFrameIndex < 0 || diagnostics.some(({ index }) => index > nextFrameIndex)) return false;
  const parsed = /decoder -> pts:[^\n]*?pts_time:([\d.-]+)/.exec(lines[nextFrameIndex]);
  return Boolean(parsed && Number.isFinite(Number(parsed[1])) &&
    Math.abs(Number(parsed[1]) - terminalTime) <= 0.25 / fps);
}

async function terminalDecoderDamage(file: string, terminalTime: number, fps: number,
  signal?: AbortSignal): Promise<boolean> {
  const { stderr } = await exec('nice', ['-n', '15', 'ionice', '-c', '3', 'ffmpeg',
    '-hide_banner', '-loglevel', 'info', '-debug_ts', '-nostdin', '-threads', '1',
    '-i', file, '-map', '0:v:0', '-an', '-vsync', '0', '-f', 'null', '-'],
  { timeout: 45_000, maxBuffer: 4 * 1024 * 1024, signal });
  return localizedTerminalDecoderError(stderr, terminalTime, fps);
}

export function allowDamagedTerminalPicture(unmatched: number, decoderError: boolean): boolean {
  return unmatched === 0 || (unmatched === 1 && decoderError);
}

function monotonicDts(packets: Packet[]): boolean {
  let prior = -Infinity;
  for (const packet of packets) {
    const dts = Number(packet.dts_time);
    if (!Number.isFinite(dts) || !Number.isFinite(Number(packet.pts_time)) || dts <= prior) return false;
    prior = dts;
  }
  return true;
}

/** A bounded background-only alternative to keyframe copy. A timestamp-only
 * cut is unsafe for B-frames: the first unique packet need not be the first
 * unique picture in presentation order. Preserve every preceding picture and
 * each decoded picture after the verified overlap. */
async function prepareFrameAccurateCopy(previousFiles: string[], nextFile: string, output: string,
  current: { video: Packet[]; audio: Packet[] }, videoDuration: number, audioDuration: number,
  media: Probe, signal?: AbortSignal): Promise<{ kind: 'trim'; offset: number; duration: number; size: number } | undefined> {
  const sourceDuration = Number(media.format?.duration);
  const v = media.streams.find(s => s.codec_type === 'video');
  const a = media.streams.find(s => s.codec_type === 'audio');
  const fps = frameRate(v?.avg_frame_rate);
  const sampleRate = Number(a?.sample_rate);

  if (!fps || !v || !a || !['Baseline', 'Constrained Baseline', 'Main', 'High'].includes(v.profile || '') ||
      !Number.isInteger(v.level) || v.level! < 10 || v.level! > 52 ||
      v.pix_fmt !== 'yuv420p' || !v.width || !v.height || v.width > 1920 || v.height > 1080 ||
      ![1, 2].includes(a.channels ?? 0) || sampleRate !== 48_000 ||
      !Number.isFinite(sourceDuration) || sourceDuration - Math.min(videoDuration, audioDuration) > 9.5)
    return undefined;
  // AAC LC carries 1024 samples per packet here; reject layouts where a
  // packet count cannot be converted to an exact decoded sample position.
  if (!current.audio.every(packet => Math.abs(Number(packet.duration_time) - 1024 / sampleRate) < 0.00001))
    return undefined;
  const previousFrames: string[] = [];
  let finalPredecessorDecoderError = false;
  let finalPredecessorFrameCount = 0;
  for (const file of previousFiles) {
    const decoded = await decodedVideoFrames(file, signal);
    finalPredecessorDecoderError = decoded.decoderError;
    const frames = decoded.hashes;
    finalPredecessorFrameCount = frames.length;
    let repeated = 0;
    for (let n = 1; n <= Math.min(20, previousFrames.length, frames.length); n++) {
      if (previousFrames.slice(-n).every((hash, i) => hash === frames[i])) repeated = n;
    }
    previousFrames.push(...frames.slice(repeated));
  }
  const nextInventory = await decodedVideoFrames(nextFile, signal);
  if (nextInventory.decoderError) return undefined;
  const nextFrames = nextInventory.hashes;
  const matches: Array<{ count: number; unmatched: number }> = [];
  for (let start = 0; start < previousFrames.length; start++) {
    if (previousFrames[start] !== nextFrames[0]) continue;
    let count = 0;
    while (start + count < previousFrames.length && count < nextFrames.length &&
      previousFrames[start + count] === nextFrames[count]) count++;
    const unmatched = previousFrames.length - start - count;
    if (count >= 20 && count < nextFrames.length &&
        allowDamagedTerminalPicture(unmatched, finalPredecessorDecoderError) &&
        Math.abs(count / fps.rate - videoDuration) <= 0.15) matches.push({ count, unmatched });
  }

  if (matches.length !== 1) return undefined;
  const { count: firstUnique, unmatched } = matches[0];
  // The decoder can report an error earlier in the predecessor; never use
  // that as permission to discard a genuinely unique final picture.
  if (unmatched === 1 && !await terminalDecoderDamage(previousFiles.at(-1)!,
    (finalPredecessorFrameCount - 1) / fps.rate, fps.rate, signal)) return undefined;
  const offset = firstUnique / fps.rate;
  const firstAudio = Number(current.audio[0].pts_time);
  const firstVideo = Number(current.video[0].pts_time);
  // Every matching AAC packet was already verified against the predecessor.
  const matchedAudio = current.audio.findIndex(packet =>
    Number(packet.pts_time) - firstAudio >= audioDuration - 0.011);
  if (matchedAudio < 40 || matchedAudio >= current.audio.length) return undefined;
  const audioOffset = matchedAudio * 1024 / sampleRate;

  if (Math.abs(audioOffset - audioDuration) > 0.03) return undefined;
  const avDelay = firstVideo + offset - (firstAudio + audioOffset);

  if (!Number.isFinite(avDelay) || avDelay < 0 || avDelay > 0.25 ||
      sourceDuration - offset < 2 || sourceDuration - offset > 9.5) return undefined;
  const profile = v.profile === 'Constrained Baseline' ? 'baseline' : v.profile!.toLowerCase();
  // Copy the verified *unique* AAC packets. Re-encoding AAC introduces an
  // additional priming packet (observed as a ~21 ms delay in the scratch seam).
  const audioTemporary = `${output}.audio.part`;
  try {
    await exec('nice', ['-n', '15', 'ionice', '-c', '3', 'ffmpeg', '-hide_banner', '-loglevel', 'error',
      '-nostdin', '-i', nextFile, '-ss', audioOffset.toFixed(6), '-map', '0:a:0',
      '-c:a', 'copy', '-f', 'mpegts', '-y', audioTemporary],
    { timeout: 15_000, maxBuffer: 64 * 1024, signal });
    const audioProbe = await probe(audioTemporary, signal);
    const audioStream = audioProbe?.streams.find(stream => stream.codec_type === 'audio');
    const copiedAudio = audioProbe?.packets.filter(packet => packet.stream_index === audioStream?.index);
    const expectedAudio = current.audio.slice(matchedAudio);
    if (!copiedAudio || copiedAudio.length !== expectedAudio.length ||
        !copiedAudio.every((packet, index) => packet.data_hash === expectedAudio[index].data_hash))
      return undefined;
    const filter = `[0:v:0]trim=start_frame=${firstUnique},setpts=PTS-STARTPTS+${avDelay.toFixed(6)}/TB[v]`;
    await exec('nice', ['-n', '15', 'ionice', '-c', '3', 'ffmpeg', '-hide_banner', '-loglevel', 'error',
      '-nostdin', '-threads', '1', '-filter_threads', '1', '-i', nextFile, '-i', audioTemporary,
      '-filter_complex', filter, '-map', '[v]', '-map', '1:a:0',
      '-vsync', '0', '-enc_time_base:v', fps.timeBase,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '19', '-pix_fmt', 'yuv420p',
      '-profile:v', profile, '-level:v', (v.level! / 10).toFixed(1),
      ...(profile === 'baseline' ? ['-bf', '0'] : []), '-threads:v', '1',
      '-c:a', 'copy', '-f', 'mpegts', '-y', output],
    { timeout: 65_000, maxBuffer: 64 * 1024, signal });
  } finally {
    await fs.rm(audioTemporary, { force: true });
  }
  const result = await probe(output, signal);
  const selected = result && streams(result);
  const duration = Number(result?.format?.duration);
  const size = (await fs.stat(output)).size;
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'json', output],
  { timeout: 15_000, maxBuffer: 2048, signal });
  const actualFrames = Number((JSON.parse(stdout) as { streams?: Array<{ nb_read_frames?: string }> })
    .streams?.[0]?.nb_read_frames);

  if (!selected || !selected.video[0].flags.includes('K') ||
      selected.audio.length !== current.audio.length - matchedAudio ||
      !selected.audio.every((packet, index) => packet.data_hash === current.audio[matchedAudio + index].data_hash) ||
      !monotonicDts(selected.video) || !monotonicDts(selected.audio) ||
      Math.abs(Number(selected.video[0].pts_time) - Number(selected.audio[0].pts_time) - avDelay) > 0.06 ||
      Math.abs(Number(selected.video.at(-1)!.pts_time) - Number(selected.audio.at(-1)!.pts_time)) > 0.3 ||
      actualFrames !== nextFrames.length - firstUnique ||
      !Number.isFinite(duration) || duration <= 0 ||
      Math.abs(duration - (sourceDuration - offset)) > 0.5 ||
      size <= 0 || size > (await fs.stat(nextFile)).size * 1.5) return undefined;
  return { kind: 'trim', offset, duration, size };
}

/** Stage and validate a stream-copy TS rendition. Never writes to either master.
 * Returns undefined on uncertain evidence, missing keyframe, or invalid output. */
export async function prepareSeamCopy(previousFiles: string[], nextFile: string, output: string, signal?: AbortSignal,
  frameAccurate = process.env.STREAMVAULT_FRAME_ACCURATE_SEAMS === '1'):
  Promise<{ kind: 'trim'; offset: number; duration: number; size: number } | { kind: 'duplicate' } | undefined> {
  if (previousFiles.length < 1 || previousFiles.length > 2) return undefined;
  const probes = await Promise.all([...previousFiles, nextFile].map(file => probe(file, signal)));
  if (probes.some(p => !p)) return undefined;
  const prior = probes.slice(0, -1).map(p => streams(p!));
  const current = streams(probes.at(-1)!);
  if (prior.some(p => !p) || !current) return undefined;
  // Convert each previous file's packet clock into one prior-media timeline.
  // FFmpeg may reset PTS at chunk boundaries; A/V within each file shares its
  // own clock, so anchor both streams to the same first packet.
  let elapsed = 0;
  const timedPrior = prior.map(part => {
    const packets = [...part!.video, ...part!.audio];
    const base = Math.min(...packets.map(p => Number(p.pts_time)));
    const end = Math.max(...packets.map(p => Number(p.pts_time) + Number(p.duration_time || 0)));
    const timed = (items: Packet[]): PriorPacket[] => items.map(p =>
      ({ ...p, priorTime: elapsed + Number(p.pts_time) - base }));
    const result = { video: timed(part!.video), audio: timed(part!.audio) };
    elapsed += end - base;
    return result;
  });
  const join = (kind: 'video' | 'audio') => {
    const first = timedPrior[0][kind];
    if (timedPrior.length === 1) return first;
    const second = timedPrior[1][kind];
    // Adjacent independently muxed TS clips may repeat a handful of AAC
    // preroll packets. Remove only a byte-identical boundary intersection.
    let repeated = 0;
    for (let n = 1; n <= Math.min(first.length, second.length, kind === 'audio' ? 60 : 20); n++) {
      if (first.slice(-n).every((p, i) => p.data_hash === second[i].data_hash)) repeated = n;
    }
    return [...first, ...second.slice(repeated)];
  };
  const priorVideo = join('video');
  const priorAudio = join('audio');
  if (fullDuplicateInSameWindow(prior as Array<{ video: Packet[]; audio: Packet[] }>, current)) {
    return { kind: 'duplicate' };
  }
  const video = prefixMatchWindow(priorVideo, current.video);
  const audio = prefixMatchWindow(priorAudio, current.audio);
  if (!video || !audio || Math.abs(video.duration - audio.duration) > 0.5 ||
      Math.abs(video.start - audio.start) > 0.5 || Math.abs(video.end - audio.end) > 0.5) return undefined;
  const firstVideo = Number(current.video[0].pts_time);
  const sourceDuration = Number(probes.at(-1)!.format?.duration);
  if (frameAccurate && Number.isFinite(sourceDuration) &&
      sourceDuration - Math.min(video.duration, audio.duration) <= 9.5) {
    try {
      const precise = await prepareFrameAccurateCopy(previousFiles, nextFile, output, current,
        video.duration, audio.duration, probes.at(-1)!, signal);
      if (precise) return precise;
    } catch (error) {
      if (signal?.aborted) throw error;

      // Ineligible/corrupt media or an overloaded encoder must not change the
      // raw capture. Fall back to the proven keyframe-aligned stream copy.
    }
    await fs.rm(output, { force: true });
  }
  const keyframes = current.video.filter(p => p.flags.includes('K') &&
    Number(p.pts_time) - firstVideo >= 0.5 && Number(p.pts_time) - firstVideo <= Math.min(video.duration, audio.duration) - 0.15);
  const keyframe = keyframes.at(-1);
  if (!keyframe) return undefined;
  const offset = Number(keyframe.pts_time) - firstVideo;
  if (!Number.isFinite(sourceDuration) || sourceDuration - offset < 2) return undefined;
  try {
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
      '-ss', offset.toFixed(6), '-i', nextFile, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy',
      '-avoid_negative_ts', 'make_zero', '-f', 'mpegts', '-y', output],
    { timeout: 30_000, maxBuffer: 64 * 1024, signal });
    const result = await probe(output, signal);
    const outputStreams = result && streams(result);
    const duration = Number(result?.format?.duration);
    const size = (await fs.stat(output)).size;
    // Preserve the final packet of *each* elementary stream, not just a
    // non-empty tail. A copy seek can otherwise silently discard unique A/V.
    if (!outputStreams || !Number.isFinite(duration) || duration <= 0 ||
        duration < sourceDuration - offset - 0.5 || duration > sourceDuration - offset + 0.5 ||
        outputStreams.video[0].data_hash !== keyframe.data_hash ||
        !outputStreams.video[0].flags.includes('K') ||
        outputStreams.video.at(-1)!.data_hash !== current.video.at(-1)!.data_hash ||
        outputStreams.audio.at(-1)!.data_hash !== current.audio.at(-1)!.data_hash) return undefined;
    return { kind: 'trim', offset, duration, size };
  } finally {
    // The caller removes a staged output unless it commits the verified copy.
  }
}

export function frameAccurateEnabledFor(channelId: string, end: number, now: number): boolean {
  if (process.env.STREAMVAULT_FRAME_ACCURATE_SEAMS !== '1' || end > now || now - end >= 5 * 60_000) return false;
  return (process.env.STREAMVAULT_FRAME_ACCURATE_CHANNEL_IDS || '').split(',')
    .map(id => id.trim()).filter(Boolean).includes(channelId);
}

/** One background job per seam; unchanged capture files remain authoritative.
 * Caller serializes jobs and limits outstanding IDs. Fail closed on any doubt. */
export async function processArchiveSeam(store: ArchiveStore, root: string, id: string,
  now = Date.now(), reserveBytes = 20 * 1024 ** 3, maximumBytes = 400 * 1024 ** 3,
  signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted || process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK === '1') return false;
  const current = store.getChunk(id);
  const previous = store.previousChunk(id);
  if (!current || !previous || !store.getArchive(current.channelId) || current.unavailable ||
      current.playbackPath || current.playbackHidden || !id.endsWith('-chunk-000000000.ts') ||
      previous.id.split('-chunk-')[0] === id.split('-chunk-')[0]) return false;
  const older = store.previousChunk(previous.id);
  const prior = older && older.id.split('-chunk-')[0] === previous.id.split('-chunk-')[0] ? [older, previous] : [previous];
  const checked = async (relative: string): Promise<string> => {
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.resolve(root) + path.sep) || !relative.endsWith('.ts') ||
      !(await fs.realpath(file)).startsWith((await fs.realpath(root)) + path.sep)) throw new Error('Unsafe archive path');
    return file;
  };
  const input = await checked(current.path);
  const preceding = await Promise.all(prior.map(c => checked(c.path)));
  const before = await fs.stat(input);
  if (!before.isFile() || before.size !== current.size) return false;
  const beforePrior = await Promise.all(preceding.map(file => fs.stat(file)));
  const predecessorsIntact = () => store.getArchive(current.channelId)?.enabled && prior.every((chunk, i) => {
    const indexed = store.getChunk(chunk.id);
    if (!indexed || indexed.unavailable || indexed.path !== chunk.path || indexed.size !== chunk.size) return false;
    try {
      const file = fsSync.statSync(preceding[i]);
      return file.isFile() && file.size === beforePrior[i].size && file.mtimeMs === beforePrior[i].mtimeMs;
    } catch { return false; }
  });
  const disk = await fs.statfs(root);
  const maximumCopy = Math.ceil(before.size * 1.5);
  if (signal?.aborted || process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK === '1' ||
      disk.bavail * disk.bsize <= reserveBytes + maximumCopy ||
      store.totalUsageBytes() + maximumCopy >= maximumBytes) return false;
  const relative = current.path.replace(/\.ts$/, '.playback.ts');
  const output = path.resolve(root, relative);
  if (!output.startsWith(path.resolve(root) + path.sep)) return false;
  const staged = `${output}.part`;
  try {
    try { await fs.stat(output); return false; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const result = await prepareSeamCopy(preceding, input, staged, signal,
      frameAccurateEnabledFor(current.channelId, current.end, now));
    if (signal?.aborted || process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK === '1') return false;
    if (!result) return false;
    const after = await fs.stat(input);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return false;
    if (!predecessorsIntact()) return false;
    if (result.kind === 'duplicate') return store.hidePlaybackDuplicate(id);
    if (result.size > before.size * 1.5) return false;
    const remaining = await fs.statfs(root);
    if (remaining.bavail * remaining.bsize <= reserveBytes ||
        store.totalUsageBytes() + result.size >= maximumBytes) return false;
    if (signal?.aborted || process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK === '1') return false;
    await fs.rename(staged, output);
    if (signal?.aborted || process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK === '1') return false;
    // Rename yielded to retention/disable handlers: never publish a trim if
    // any media used to prove the overlap disappeared during that await.
    if (!predecessorsIntact()) return false;
    const published = store.setPlaybackMedia(id, relative, result.size, result.offset, result.duration, now);
    return published;
  } finally {
    await fs.rm(staged, { force: true });
    if (store.getChunk(id)?.playbackPath !== relative) await fs.rm(output, { force: true });
  }
}
