import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { ArchiveStore } from './archive-store.js';

const exec = promisify(execFile);
type Packet = { stream_index: number; pts_time: string; duration_time?: string; flags: string; data_hash: string };
type PriorPacket = Packet & { priorTime?: number };
type Probe = { streams: Array<{ index: number; codec_type: string; codec_name: string }>;
  packets: Packet[]; format?: { duration?: string } };

async function probe(file: string, signal?: AbortSignal): Promise<Probe | undefined> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024 * 1024) return undefined;
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_packets',
    '-show_format', '-show_data_hash', 'sha256', '-show_entries',
    'stream=index,codec_type,codec_name:packet=stream_index,pts_time,duration_time,flags,data_hash:format=duration',
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

/** Stage and validate a stream-copy TS rendition. Never writes to either master.
 * Returns undefined on uncertain evidence, missing keyframe, or invalid output. */
export async function prepareSeamCopy(previousFiles: string[], nextFile: string, output: string, signal?: AbortSignal):
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
  const keyframes = current.video.filter(p => p.flags.includes('K') &&
    Number(p.pts_time) - firstVideo >= 0.5 && Number(p.pts_time) - firstVideo <= Math.min(video.duration, audio.duration) - 0.15);
  const keyframe = keyframes.at(-1);
  if (!keyframe) return undefined;
  const offset = Number(keyframe.pts_time) - firstVideo;
  const sourceDuration = Number(probes.at(-1)!.format?.duration);
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

/** One background job per seam; unchanged capture files remain authoritative.
 * Caller serializes jobs and limits outstanding IDs. Fail closed on any doubt. */
export async function processArchiveSeam(store: ArchiveStore, root: string, id: string,
  now = Date.now(), reserveBytes = 20 * 1024 ** 3, maximumBytes = 400 * 1024 ** 3,
  signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
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
  if (disk.bavail * disk.bsize <= reserveBytes + maximumCopy ||
      store.totalUsageBytes() + maximumCopy >= maximumBytes) return false;
  const relative = current.path.replace(/\.ts$/, '.playback.ts');
  const output = path.resolve(root, relative);
  if (!output.startsWith(path.resolve(root) + path.sep)) return false;
  const staged = `${output}.part`;
  try {
    try { await fs.stat(output); return false; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const result = await prepareSeamCopy(preceding, input, staged, signal);
    if (signal?.aborted) return false;
    if (!result) return false;
    const after = await fs.stat(input);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return false;
    if (!predecessorsIntact()) return false;
    if (result.kind === 'duplicate') return store.hidePlaybackDuplicate(id);
    if (result.size > before.size * 1.5) return false;
    const remaining = await fs.statfs(root);
    if (remaining.bavail * remaining.bsize <= reserveBytes ||
        store.totalUsageBytes() + result.size >= maximumBytes) return false;
    if (signal?.aborted) return false;
    await fs.rename(staged, output);
    if (signal?.aborted) return false;
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
