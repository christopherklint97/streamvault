import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ArchiveStore, ArchiveChunk } from './archive-store.js';
import { prepareLosslessPair, rawTransportContinues } from './archive-lossless-pair-media.js';

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const EXTRA_WORK_MULTIPLIER = 8; // staged elementary streams, muxes and two final copies

export function pairEnabledFor(channelId: string, rawMode: string | undefined,
  allowlist: string | undefined): boolean {
  return rawMode === '1' && (allowlist || '').split(',')
    .map(id => id.trim()).filter(Boolean).includes(channelId);
}

/** A single bounded, abortable canary. Inputs and saved-show masters are never modified.
 * Capture serializes work and owns the queue; this worker publishes both paths
 * only after their validated files exist and a synchronous store transaction succeeds. */
export async function processArchivePair(store: ArchiveStore, root: string, id: string,
  _now = Date.now(), reserveBytes = 20 * 1024 ** 3, maximumBytes = 400 * 1024 ** 3,
  signal?: AbortSignal, prepare: typeof prepareLosslessPair = prepareLosslessPair,
  flags?: { rawMode?: string; allowlist?: string }): Promise<boolean> {
  const current = store.getChunk(id);
  if (!current || !id.endsWith('-chunk-000000000.ts')) return false;
  const canRun = () => !signal?.aborted && pairEnabledFor(current.channelId,
    flags?.rawMode ?? process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK,
    flags?.allowlist ?? process.env.STREAMVAULT_ARCHIVE_PAIR_CHANNEL_IDS);
  if (!canRun() || !store.getArchive(current.channelId)?.enabled || current.unavailable ||
      current.playbackHidden || current.pairId) return false;
  const previous = store.previousChunk(id);
  if (!previous || previous.unavailable || previous.playbackHidden || previous.pairId ||
      previous.id.split('-chunk-')[0] === current.id.split('-chunk-')[0]) return false;
  const followingId = id.replace(/-chunk-000000000\.ts$/, '-chunk-000000001.ts');
  const following = store.getChunk(followingId);
  if (!following || following.unavailable || following.channelId !== current.channelId ||
      following.epoch !== current.epoch || following.end <= current.end) return false;
  const realRoot = await fs.realpath(root);
  const source = async (chunk: ArchiveChunk) => {
    const absolute = path.resolve(realRoot, chunk.path);
    if (!absolute.startsWith(realRoot + path.sep) || !chunk.path.endsWith('.ts') ||
        !(await fs.realpath(absolute)).startsWith(realRoot + path.sep)) throw new Error('Unsafe archive source');
    const stat = await fs.stat(absolute);
    if (!stat.isFile() || stat.size !== chunk.size || stat.size <= 0 || stat.size > MAX_INPUT_BYTES)
      throw new Error('Unsafe archive source size');
    return { absolute, stat };
  };
  const [prior, next, after] = await Promise.all([source(previous), source(current), source(following)]);
  if (!await rawTransportContinues(next.absolute, after.absolute)) return false;
  const maximumWork = Math.ceil((prior.stat.size + next.stat.size) * EXTRA_WORK_MULTIPLIER);
  const free = async () => { const disk = await fs.statfs(realRoot); return disk.bavail * disk.bsize; };
  if ((await free()) <= reserveBytes + maximumWork ||
      store.totalUsageBytes() + Math.ceil((prior.stat.size + next.stat.size) * 1.5) >= maximumBytes)
    return false;
  const token = randomUUID();
  const presentation = (chunk: ArchiveChunk) => {
    const relative = chunk.path.replace(/\.ts$/, `.${token}.pair.playback.ts`);
    const absolute = path.resolve(realRoot, relative);
    if (relative === chunk.path || !absolute.startsWith(realRoot + path.sep))
      throw new Error('Unsafe archive presentation');
    return { relative, absolute };
  };
  const priorOut = presentation(previous), nextOut = presentation(current);
  let committed = false;
  try {
    if (!canRun()) return false;
    const result = await prepare(prior.absolute, next.absolute, priorOut.absolute, nextOut.absolute, signal);
    if (!result || !canRun()) return false;
    const currentPrior = store.getChunk(previous.id), currentNext = store.getChunk(current.id);
    const currentAfter = store.getChunk(followingId);
    if (!store.getArchive(current.channelId)?.enabled || !currentPrior || !currentNext || !currentAfter ||
        currentPrior.unavailable || currentNext.unavailable || currentAfter.unavailable ||
        currentPrior.path !== previous.path || currentNext.path !== current.path ||
        currentAfter.path !== following.path || currentAfter.size !== following.size ||
        currentPrior.size !== previous.size || currentNext.size !== current.size) return false;
    const [priorAfter, nextAfter, followingAfter, first, second] = await Promise.all([
      fs.stat(prior.absolute), fs.stat(next.absolute), fs.stat(after.absolute),
      fs.stat(priorOut.absolute), fs.stat(nextOut.absolute),
    ]);
    if (![priorAfter, nextAfter, followingAfter].every((stat, index) =>
        stat.isFile() && stat.size === [prior, next, after][index].stat.size &&
        stat.mtimeMs === [prior, next, after][index].stat.mtimeMs &&
        stat.ino === [prior, next, after][index].stat.ino) ||
        !first.isFile() || !second.isFile() ||
        first.size !== result.sizes[0] || second.size !== result.sizes[1] ||
        !Number.isSafeInteger(first.size) || !Number.isSafeInteger(second.size) ||
        first.size <= 0 || second.size <= 0 ||
        first.size + second.size > (prior.stat.size + next.stat.size) * 1.5) return false;
    if ((await free()) <= reserveBytes ||
        store.totalUsageBytes() + first.size + second.size >= maximumBytes || !canRun()) return false;
    committed = store.publishPlaybackPair({
      priorId: previous.id, nextId: current.id, priorRawPath: previous.path, nextRawPath: current.path,
      priorPath: priorOut.relative, priorSize: first.size, priorCut: result.cut.previousOffset,
      nextPath: nextOut.relative, nextSize: second.size, nextOffset: result.cut.offset,
      nextDuration: current.duration - result.cut.offset,
    });
    if (committed) for (const old of [previous.playbackPath, current.playbackPath]) {
      if (!old || !old.endsWith('.playback.ts')) continue;
      const absolute = path.resolve(realRoot, old);
      if (absolute.startsWith(realRoot + path.sep)) {
        try {
          if (!(await fs.realpath(path.dirname(absolute))).startsWith(realRoot + path.sep)) continue;
          await fs.rm(absolute, { force: true });
          store.releaseDetachedPlayback(old);
        } catch { /* Leave failed cleanup charged to the physical quota. */ }
      }
    }
    return committed;
  } finally {
    if (!committed) await Promise.all([priorOut.absolute, nextOut.absolute]
      .map(file => fs.rm(file, { force: true }).catch(() => undefined)));
  }
}
