import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ArchiveStore, ArchiveChunk } from './archive-store.js';
import { prepareLosslessPair, prepareEarlyThreeChunkPair, rawTransportContinues,
  rawMediaClockContinues } from './archive-lossless-pair-media.js';
import { planVerifiedPairTimeline } from './archive-pair-timeline.js';

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const EXTRA_WORK_MULTIPLIER = 8; // staged elementary streams, muxes and two final copies

export function pairEnabledFor(channelId: string, rawMode: string | undefined,
  allowlist = '*'): boolean {
  // All enabled archives are eligible by default. The optional allowlist is
  // only an injected test constraint; it is never read from production config.
  return process.env.STREAMVAULT_ARCHIVE_RAW_ONLY !== '1' && rawMode !== '0' &&
    channelId.length > 0 && allowlist.split(',')
    .map(id => id.trim()).some(id => id === '*' || id === channelId);
}

/** One bounded, abortable pair at a time. Inputs and saved-show masters are never modified.
 * Capture serializes work and owns the queue; this worker publishes both paths
 * only after their validated files exist and a synchronous store transaction succeeds. */
export async function processArchivePair(store: ArchiveStore, root: string, id: string,
  _now = Date.now(), reserveBytes = 20 * 1024 ** 3, maximumBytes = 400 * 1024 ** 3,
  signal?: AbortSignal, prepare: typeof prepareLosslessPair = prepareLosslessPair,
  flags?: { rawMode?: string; allowlist?: string;
    clockContinues?: typeof rawMediaClockContinues; transportContinues?: typeof rawTransportContinues;
    prepareEarly?: typeof prepareEarlyThreeChunkPair }): Promise<boolean> {
  const current = store.getChunk(id);
  if (!current || !id.endsWith('-chunk-000000000.ts')) return false;
  const canRun = () => !signal?.aborted && pairEnabledFor(current.channelId,
    flags?.rawMode ?? process.env.STREAMVAULT_ARCHIVE_RAW_PLAYBACK,
    flags?.allowlist);
  if (!canRun() || !store.getArchive(current.channelId)?.enabled || current.unavailable ||
      current.playbackHidden || current.pairId) return false;
  const previous = store.previousChunk(id);
  if (!previous || previous.unavailable || previous.playbackHidden || previous.pairId ||
      previous.id.split('-chunk-')[0] === current.id.split('-chunk-')[0]) return false;
  const possibleWitness = store.previousChunk(previous.id);
  const witness = possibleWitness && !possibleWitness.unavailable && !possibleWitness.playbackHidden &&
    !possibleWitness.pairId && !possibleWitness.playbackPath &&
    possibleWitness.epoch === previous.epoch &&
    possibleWitness.id.split('-chunk-')[0] === previous.id.split('-chunk-')[0]
      ? possibleWitness : undefined;
  const followingId = id.replace(/-chunk-000000000\.ts$/, '-chunk-000000001.ts');
  const following = store.getChunk(followingId);
  if (!following || following.unavailable || following.channelId !== current.channelId ||
      following.epoch !== current.epoch || following.end <= current.end) return false;
  const sessionId = id.split('-chunk-')[0];
  const session = store.indexedChunks().filter(chunk => chunk.channelId === current.channelId &&
    chunk.id.startsWith(`${sessionId}-chunk-`)).sort((a, b) => a.id.localeCompare(b.id));
  if (session.length < 2 || session.length > 14 || session[0].id !== id) return false;
  // Do not pin a clock for a session that can still append another chunk.
  // A newly indexed first chunk in a different epoch proves a handoff.
  if (!store.indexedChunks().some(chunk => chunk.channelId === current.channelId &&
      chunk.epoch !== current.epoch && chunk.id.endsWith('-chunk-000000000.ts') &&
      chunk.end > session.at(-1)!.end && !chunk.unavailable)) return false;
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
  const [prior, sources] = await Promise.all([source(previous), Promise.all(session.map(source))]);
  const next = sources[0];
  for (let index = 1; index < sources.length; index++)
    if (!await (flags?.transportContinues ?? rawTransportContinues)(
          sources[index - 1].absolute, sources[index].absolute) ||
        !await (flags?.clockContinues ?? rawMediaClockContinues)(
          sources[index - 1].absolute, sources[index].absolute)) return false;
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
  const witnessOut = witness ? presentation(witness) : undefined;
  let committed = false;
  try {
    if (!canRun()) return false;
    let result = await prepare(prior.absolute, next.absolute, priorOut.absolute, nextOut.absolute, signal);
    let selectedPrior = previous, selectedInput = prior, selectedOut = priorOut;
    let witnessInput: Awaited<ReturnType<typeof source>> | undefined;
    if (!result && witness && witnessOut && !previous.playbackPath && canRun()) {
      // The final raw chunk may begin without H.264 parameter sets. Only an
      // independently proved, contiguous witness may replace its presentation.
      witnessInput = await source(witness);
      if (!await (flags?.transportContinues ?? rawTransportContinues)(
          witnessInput.absolute, prior.absolute) ||
          !await (flags?.clockContinues ?? rawMediaClockContinues)(
            witnessInput.absolute, prior.absolute)) return false;
      const work = Math.ceil((witnessInput.stat.size + prior.stat.size + next.stat.size) * EXTRA_WORK_MULTIPLIER);
      if ((await free()) <= reserveBytes + work ||
          store.totalUsageBytes() + Math.ceil((witnessInput.stat.size + next.stat.size) * 1.5) >= maximumBytes)
        return false;
      await Promise.all([priorOut.absolute, nextOut.absolute]
        .map(file => fs.rm(file, { force: true })));
      result = await (flags?.prepareEarly ?? prepareEarlyThreeChunkPair)(
        witnessInput.absolute, prior.absolute, next.absolute,
        witnessOut.absolute, nextOut.absolute, signal);
      if (result) { selectedPrior = witness; selectedInput = witnessInput; selectedOut = witnessOut; }
    }
    if (!result || !canRun()) return false;
    const starts = planVerifiedPairTimeline(selectedPrior.presentationStart ?? selectedPrior.start, result.cut.previousOffset,
      result.cut.offset, session, session.slice(1).map(() => true));
    if (!starts) return false;
    const currentPrior = store.getChunk(selectedPrior.id), currentNext = store.getChunk(current.id);
    const currentMiddle = witnessInput ? store.getChunk(previous.id) : undefined;
    const currentAfter = store.getChunk(followingId);
    if (!store.getArchive(current.channelId)?.enabled || !currentPrior || !currentNext || !currentAfter ||
        currentPrior.unavailable || currentNext.unavailable || currentAfter.unavailable ||
        (witnessInput && (!currentMiddle || currentMiddle.unavailable || currentMiddle.pairId ||
          currentMiddle.playbackPath || currentMiddle.path !== previous.path ||
          currentMiddle.size !== previous.size)) ||
        currentPrior.path !== selectedPrior.path || currentNext.path !== current.path ||
        currentAfter.path !== following.path || currentAfter.size !== following.size ||
        currentPrior.size !== selectedPrior.size || currentNext.size !== current.size) return false;
    const [priorAfter, witnessAfter, finalSources, first, second] = await Promise.all([
      fs.stat(prior.absolute), witnessInput ? fs.stat(witnessInput.absolute) : Promise.resolve(undefined),
      Promise.all(sources.map(item => fs.stat(item.absolute))),
      fs.stat(selectedOut.absolute), fs.stat(nextOut.absolute),
    ]);
    const finalSession = store.indexedChunks().filter(chunk => chunk.channelId === current.channelId &&
      chunk.id.startsWith(`${sessionId}-chunk-`)).sort((a, b) => a.id.localeCompare(b.id));
    if (!priorAfter.isFile() || priorAfter.size !== prior.stat.size ||
        priorAfter.mtimeMs !== prior.stat.mtimeMs || priorAfter.ino !== prior.stat.ino ||
        (witnessInput && (!witnessAfter?.isFile() || witnessAfter.size !== witnessInput.stat.size ||
          witnessAfter.mtimeMs !== witnessInput.stat.mtimeMs || witnessAfter.ino !== witnessInput.stat.ino)) ||
        finalSession.length !== session.length ||
        finalSession.some((chunk, index) => chunk.id !== session[index].id ||
          chunk.path !== session[index].path || chunk.size !== session[index].size ||
          chunk.duration !== session[index].duration || chunk.epoch !== session[index].epoch ||
          chunk.unavailable) ||
        !finalSources.every((stat, index) =>
          stat.isFile() && stat.size === sources[index].stat.size &&
          stat.mtimeMs === sources[index].stat.mtimeMs && stat.ino === sources[index].stat.ino) ||
        !first.isFile() || !second.isFile() ||
        first.size !== result.sizes[0] || second.size !== result.sizes[1] ||
        !Number.isSafeInteger(first.size) || !Number.isSafeInteger(second.size) ||
        first.size <= 0 || second.size <= 0 ||
        first.size + second.size > (selectedInput.stat.size + next.stat.size) * 1.5) return false;
    if ((await free()) <= reserveBytes ||
        store.totalUsageBytes() + first.size + second.size >= maximumBytes || !canRun()) return false;
    committed = store.publishPlaybackPair({
      priorId: selectedPrior.id, middleId: witnessInput ? previous.id : undefined,
      nextId: current.id, priorRawPath: selectedPrior.path,
      middleRawPath: witnessInput ? previous.path : undefined, nextRawPath: current.path,
      priorPath: selectedOut.relative, priorSize: first.size, priorCut: result.cut.previousOffset,
      nextPath: nextOut.relative, nextSize: second.size, nextOffset: result.cut.offset,
      nextDuration: current.duration - result.cut.offset,
      sessionTimeline: session.map((chunk, index) => ({ id: chunk.id, presentationStart: starts[index] })),
    });
    if (committed) for (const old of [selectedPrior.playbackPath, current.playbackPath]) {
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
    if (!committed) await Promise.all([priorOut.absolute, witnessOut?.absolute, nextOut.absolute]
      .filter((file): file is string => !!file)
      .map(file => fs.rm(file, { force: true }).catch(() => undefined)));
  }
}
