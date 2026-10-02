import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { localizedTerminalDecoderError } from './archive-seam.js';
import { selectLosslessPairCut, type VideoSignature, type AudioSignature, type LosslessPairCut } from './archive-lossless-pair.js';

const exec = promisify(execFile);
export function lowPriorityMediaCommand(tool: 'ffprobe' | 'ffmpeg', args: string[]) {
  return { file: 'nice', args: ['-n', '15', 'ionice', '-c', '3', tool, ...args] };
}
function execMedia(tool: 'ffprobe' | 'ffmpeg', args: string[], options: {
  timeout: number; maxBuffer: number; signal?: AbortSignal;
}) {
  const { file, args: argv } = lowPriorityMediaCommand(tool, args);
  return exec(file, argv, options);
}
type Packet = { stream_index: number; pts_time: string; dts_time: string; flags: string; data_hash: string };
type Inventory = { video: Array<VideoSignature & { dts: number }>; audio: Array<AudioSignature & { dts: number }> };

async function inventory(file: string, signal?: AbortSignal): Promise<Inventory> {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024 * 1024)
    throw new Error('Unbounded archive candidate');
  const { stdout } = await execMedia('ffprobe', ['-v', 'error', '-show_streams', '-show_packets',
    '-show_data_hash', 'sha256', '-show_entries',
    'stream=index,codec_type,codec_name:packet=stream_index,pts_time,dts_time,flags,data_hash',
    '-of', 'json', file], { timeout: 20_000, maxBuffer: 5 * 1024 * 1024, signal });
  const parsed = JSON.parse(stdout) as {
    streams: Array<{ index: number; codec_type: string; codec_name: string }>;
    packets: Packet[];
  };
  if (parsed.streams.length !== 2) throw new Error('Unexpected archive streams');
  const videoIndex = parsed.streams.find(s => s.codec_type === 'video' && s.codec_name === 'h264')?.index;
  const audioIndex = parsed.streams.find(s => s.codec_type === 'audio' && s.codec_name === 'aac')?.index;
  if (videoIndex === undefined || audioIndex === undefined) throw new Error('Unsupported archive streams');
  const selected = (index: number) => parsed.packets.filter(p => p.stream_index === index &&
    Number.isFinite(Number(p.pts_time)) && Number.isFinite(Number(p.dts_time)) &&
    /^SHA256:[0-9a-f]{64}$/i.test(p.data_hash));
  const v = selected(videoIndex); const a = selected(audioIndex);
  if (v.length < 30 || a.length < 40 || v.length + a.length !== parsed.packets.length)
    throw new Error('Incomplete archive packet inventory');
  return { video: v.map(p => ({ hash: p.data_hash, pts: Number(p.pts_time), dts: Number(p.dts_time), key: p.flags.includes('K') })),
    audio: a.map(p => ({ hash: p.data_hash, pts: Number(p.pts_time), dts: Number(p.dts_time) })) };
}

async function ffmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  await execMedia('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', ...args],
    { timeout: 40_000, maxBuffer: 64 * 1024, signal });
}
function hashes(items: Array<VideoSignature | AudioSignature>): string[] { return items.map(item => item.hash); }
function equals(a: string[], b: string[]): boolean { return a.length === b.length && a.every((x, i) => x === b[i]); }
async function firstAudioTime(file: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await execMedia('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_packets', '-read_intervals', '%+#1', '-show_entries', 'packet=pts_time', '-of', 'json', file],
  { timeout: 15_000, maxBuffer: 2048, signal });
  const pts = Number((JSON.parse(stdout) as { packets?: Array<{ pts_time?: string }> }).packets?.[0]?.pts_time);
  if (!Number.isFinite(pts)) throw new Error('No AAC presentation clock');
  return pts;
}

/** Preserve packet order and payloads while aligning the pair's LAST per-PID
 * continuity counters with its original second master. The next raw chunk in
 * that same capture session therefore resumes with its original counters. */
async function continuityPair(first: string, second: string, rawNext: string): Promise<void> {
  const source = await fs.readFile(rawNext);
  if (!source.length || source.length % 188) throw new Error('Invalid source transport packets');
  const tail = new Map<number, number>();
  for (let i = 0; i < source.length; i += 188) {
    if (source[i] !== 0x47) throw new Error('Invalid source transport sync');
    const pid = ((source[i + 1] & 31) << 8) | source[i + 2];
    if (pid !== 8191) tail.set(pid, source[i + 3] & 15);
  }
  const buffers = await Promise.all([first, second].map(file => fs.readFile(file)));
  const payloadCounts = new Map<number, number>();
  for (const buffer of buffers) {
    if (!buffer.length || buffer.length % 188) throw new Error('Invalid transport packet count');
    for (let i = 0; i < buffer.length; i += 188) {
      if (buffer[i] !== 0x47) throw new Error('Invalid TS sync');
      const pid = ((buffer[i + 1] & 31) << 8) | buffer[i + 2];
      const adaptation = (buffer[i + 3] >> 4) & 3;
      if (adaptation === 0) throw new Error('Invalid TS adaptation');
      if (pid === 8191) continue;
      if (!tail.has(pid)) throw new Error('Cannot anchor pair transport stream');
      if (adaptation & 1) payloadCounts.set(pid, (payloadCounts.get(pid) ?? 0) + 1);
    }
  }
  const state = new Map<number, number>();
  for (const [pid, count] of payloadCounts) {
    if (count < 1) throw new Error('Missing pair transport payload');
    state.set(pid, (tail.get(pid)! - count) & 15);
  }
  for (const [index, file] of [first, second].entries()) {
    const buffer = buffers[index];
    for (let i = 0; i < buffer.length; i += 188) {
      if (buffer[i] !== 0x47) throw new Error('Invalid TS sync');
      const pid = ((buffer[i + 1] & 31) << 8) | buffer[i + 2];
      const adaptation = (buffer[i + 3] >> 4) & 3;
      if (adaptation === 0) throw new Error('Invalid TS adaptation');
      if (pid === 8191) continue;
      const prior = state.get(pid);
      if (prior === undefined) throw new Error('Missing pair transport counter');
      const cc = (prior + (adaptation & 1 ? 1 : 0)) & 15;
      buffer[i + 3] = (buffer[i + 3] & 0xf0) | cc;
      state.set(pid, cc);
    }
    await fs.writeFile(file, buffer);
  }
  for (const [pid, last] of state)
    if (last !== tail.get(pid)) throw new Error('Pair transport end did not match captured session');
}

/** Scratch-only bit-exact construction. Caller must reserve storage and atomically
 * pin BOTH files before allowing live playback. This function cannot change DB. */
export async function prepareLosslessPair(previous: string, next: string,
  previousOutput: string, nextOutput: string, signal?: AbortSignal):
  Promise<{ cut: LosslessPairCut; sizes: [number, number] } | undefined> {
  const paths = [previous, next, previousOutput, nextOutput].map(file => path.resolve(file));
  if (new Set(paths).size !== 4 ||
      (await Promise.all([previousOutput, nextOutput].map(async file =>
        fs.stat(file).then(() => true, () => false)))).some(Boolean))
    throw new Error('Archive presentation output must be new and distinct from masters');
  const [before, after] = await Promise.all([inventory(previous, signal), inventory(next, signal)]);
  const candidate = selectLosslessPairCut(before.video, after.video, before.audio, after.audio, true);
  if (!candidate) return undefined;
  let damaged = false;
  if (candidate.droppedDamagedPictures === 1) {
    const pts = before.video.slice(0, 120).map(packet => packet.pts).sort((a, b) => a - b);
    const steps = pts.slice(1).map((time, index) => time - pts[index])
      .filter(step => step > 0.001 && step < 0.1).sort((a, b) => a - b);
    const fps = 1 / steps[Math.floor(steps.length / 2)];
    const { stderr } = await execMedia('ffmpeg', ['-hide_banner', '-loglevel', 'info', '-debug_ts',
      '-nostdin', '-threads', '1', '-i', previous, '-map', '0:v:0', '-an', '-vsync', '0', '-f', 'null', '-'],
    { timeout: 45_000, maxBuffer: 4 * 1024 * 1024, signal });
    damaged = localizedTerminalDecoderError(stderr, before.video.at(-1)!.pts - before.video[0].pts, fps);
  }
  const cut = selectLosslessPairCut(before.video, after.video, before.audio, after.audio, damaged);
  if (!cut) return undefined;
  const priorVideo = `${previousOutput}.video.part.ts`;
  const priorAudio = `${previousOutput}.audio.part.ts`;
  const video = `${nextOutput}.video.part.ts`;
  const audio = `${nextOutput}.audio.part.ts`;
  const joined = `${nextOutput}.joined.part.ts`;
  const priorPart = `${previousOutput}.part.ts`;
  const nextPart = `${nextOutput}.part.ts`;
  let published = false;
  try {
    // Count elementary packets, not a wall-clock -t: B-frame DTS ordering and
    // AAC preroll can otherwise retain a duplicate or drop a unique packet.
    await ffmpeg(['-copyts', '-i', previous, '-map', '0:v:0', '-c', 'copy',
      '-frames:v', String(cut.videoBefore), '-mpegts_copyts', '1', '-f', 'mpegts', '-y', priorVideo], signal);
    await ffmpeg(['-copyts', '-i', previous, '-map', '0:a:0', '-c', 'copy',
      '-frames:a', String(cut.audioBefore), '-mpegts_copyts', '1', '-f', 'mpegts', '-y', priorAudio], signal);
    await ffmpeg(['-copyts', '-i', priorVideo, '-i', priorAudio, '-map', '0:v:0', '-map', '1:a:0',
      '-c', 'copy', '-mpegts_copyts', '1', '-f', 'mpegts', '-y', priorPart], signal);
    await ffmpeg(['-copyts', '-ss', cut.offset.toFixed(6), '-i', next, '-map', '0:v:0',
      '-c', 'copy', '-frames:v', String(cut.videoAfter), '-mpegts_copyts', '1', '-f', 'mpegts', '-y', video], signal);
    const nextAudioIndex = cut.audioBefore - cut.audioOverlapStart;
    const audioSeek = after.audio[nextAudioIndex].pts - after.audio[0].pts;
    await ffmpeg(['-i', next, '-ss', audioSeek.toFixed(6), '-map', '0:a:0',
      '-c', 'copy', '-frames:a', String(cut.audioAfter), '-f', 'mpegts', '-y', audio], signal);
    const audioShift = after.audio[nextAudioIndex].pts - await firstAudioTime(audio, signal);
    await ffmpeg(['-copyts', '-i', video, '-itsoffset', audioShift.toFixed(6), '-i', audio,
      '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-mpegts_copyts', '1', '-f', 'mpegts', '-y', joined], signal);
    // FFmpeg can give the independently muxed output a different initial video
    // clock than the predecessor (AAC priming). Align video timestamps to its
    // original frame cadence rather than blindly adding the overlap duration.
    const [initialPrior, initialNext] = await Promise.all([inventory(priorPart, signal), inventory(joined, signal)]);
    const shift = initialPrior.video[0].pts + cut.previousOffset - initialNext.video[0].pts;
    if (!Number.isFinite(shift) || Math.abs(shift) > 6 * 3600) return undefined;
    await ffmpeg(['-itsoffset', shift.toFixed(6), '-i', joined, '-map', '0:v:0', '-map', '0:a:0',
      '-c', 'copy', '-copyts', '-mpegts_copyts', '1', '-f', 'mpegts', '-y', nextPart], signal);
    const [a, b] = await Promise.all([inventory(priorPart, signal), inventory(nextPart, signal)]);
    if (!equals([...hashes(a.video), ...hashes(b.video)],
      [...hashes(before.video.slice(0, cut.videoOverlapStart)), ...hashes(after.video)]) ||
        !equals([...hashes(a.audio), ...hashes(b.audio)],
          [...hashes(before.audio.slice(0, cut.audioOverlapStart)), ...hashes(after.audio)]) ||
        !b.video[0].key ||
        a.video.at(-1)!.dts >= b.video[0].dts ||
        a.audio.at(-1)!.dts >= b.audio[0].dts ||
        a.video.length !== cut.videoBefore || b.video.length !== cut.videoAfter ||
        a.audio.length !== cut.audioBefore || b.audio.length !== cut.audioAfter ||
        Math.abs(b.video[0].pts - a.video[0].pts - cut.previousOffset) > 0.04 ||
        Math.abs(b.audio[0].pts - a.audio[0].pts - cut.previousOffset) > 0.04)
      return undefined;
    const sizes = [await fs.stat(priorPart), await fs.stat(nextPart)];
    const originals = [await fs.stat(previous), await fs.stat(next)];
    if (sizes[0].size + sizes[1].size > (originals[0].size + originals[1].size) * 1.5)
      return undefined;
    await continuityPair(priorPart, nextPart, next);
    await fs.rename(priorPart, previousOutput);
    await fs.rename(nextPart, nextOutput);
    published = true;
    return { cut, sizes: [sizes[0].size, sizes[1].size] };
  } finally {
    await Promise.all([priorVideo, priorAudio, video, audio, joined, priorPart, nextPart]
      .map(file => fs.rm(file, { force: true })));
    if (!published) await Promise.all([previousOutput, nextOutput].map(file => fs.rm(file, { force: true })));
  }
}
