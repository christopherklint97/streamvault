export type VideoSignature = { hash: string; pts: number; key: boolean };
export type AudioSignature = { hash: string; pts: number };
export type LosslessPairCut = {
  videoBefore: number; audioBefore: number; videoAfter: number; audioAfter: number;
  videoOverlapStart: number; audioOverlapStart: number;
  /** Offset into the reconnect source. */
  offset: number;
  /** Length retained from the predecessor, including footage before overlap. */
  previousOffset: number;
  droppedDamagedPictures: number;
};

function exactSuffixOverlap<T extends { hash: string }>(previous: T[], next: T[], minMatch: number,
  maxDamagedTail: number): { start: number; matched: number; unmatched: number } | undefined {
  const candidates: Array<{ start: number; matched: number; unmatched: number }> = [];
  for (let start = 0; start < previous.length; start++) {
    if (previous[start].hash !== next[0]?.hash) continue;
    let matched = 0;
    while (start + matched < previous.length && matched < next.length &&
      previous[start + matched].hash === next[matched].hash) matched++;
    const unmatched = previous.length - start - matched;
    if (matched >= minMatch && unmatched <= maxDamagedTail && next.length - matched >= minMatch)
      candidates.push({ start, matched, unmatched });
  }
  // A repeated pattern with two plausible alignments is not safe to cut.
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Cut a reconnect only where both encoded video and AAC bytes prove an exact
 * overlap. A terminal frame may be removed only with independent decoder proof.
 * All earlier unique predecessor packets and all unique successor packets stay. */
export function selectLosslessPairCut(
  previousVideo: VideoSignature[], nextVideo: VideoSignature[],
  previousAudio: AudioSignature[], nextAudio: AudioSignature[],
  provenTerminalDamage: boolean,
): LosslessPairCut | undefined {
  if (previousVideo.length < 30 || nextVideo.length < 60 ||
      previousAudio.length < 40 || nextAudio.length < 80) return undefined;
  const video = exactSuffixOverlap(previousVideo, nextVideo, 20, provenTerminalDamage ? 1 : 0);
  const audio = exactSuffixOverlap(previousAudio, nextAudio, 40, 0);
  if (!video || !audio ||
      Math.abs((previousVideo[video.start].pts - previousVideo[0].pts) -
        (previousAudio[audio.start].pts - previousAudio[0].pts)) > 0.08 ||
      Math.abs((nextVideo[video.matched - 1].pts - nextVideo[0].pts) -
        (nextAudio[audio.matched - 1].pts - nextAudio[0].pts)) > 0.35) return undefined;
  const firstVideoTime = nextVideo[0].pts;
  const firstAudioTime = nextAudio[0].pts;
  let nextVideoCut = -1;
  for (let i = video.matched - 1; i > 0; i--) {
    if (nextVideo[i].key) { nextVideoCut = i; break; }
  }
  if (nextVideoCut < 0) return undefined;
  const offset = nextVideo[nextVideoCut].pts - firstVideoTime;
  // H.264 packet order can contain B-frames, so adjacent packet PTS is not a
  // reliable frame period. Sort a bounded prefix of presentation timestamps.
  const sortedPts = nextVideo.slice(0, 120).map(packet => packet.pts).sort((a, b) => a - b);
  const frameSteps = sortedPts.slice(1).map((pts, i) => pts - sortedPts[i])
    .filter(step => step > 0.001 && step < 0.1).sort((a, b) => a - b);
  const fps = frameSteps.length ? 1 / frameSteps[Math.floor(frameSteps.length / 2)] : NaN;
  const videoBefore = video.start + nextVideoCut;
  const previousOffset = previousVideo[videoBefore].pts - previousVideo[0].pts;
  if (!Number.isFinite(offset) || offset < 0.5 ||
      !Number.isFinite(previousOffset) || previousOffset <= 0 ||
      !Number.isFinite(fps) || fps < 12 || fps > 60 ||
      !Number.isFinite(firstAudioTime) ||
      Math.abs((previousAudio[0].pts - previousVideo[0].pts) - (firstAudioTime - firstVideoTime)) > 0.1 ||
      Math.abs(firstAudioTime - firstVideoTime) > 0.15 ||
      nextVideo.length - nextVideoCut > 30 * fps) return undefined;
  const target = nextVideo[nextVideoCut].pts;
  const firstAfter = nextAudio.findIndex(packet => packet.pts >= target);
  const candidates = [firstAfter - 1, firstAfter].filter(index => index >= 0 && index < nextAudio.length);
  const nextAudioCut = candidates.sort((a, b) =>
    Math.abs(nextAudio[a].pts - target) - Math.abs(nextAudio[b].pts - target))[0] ?? -1;
  const audioBefore = audio.start + nextAudioCut;
  if (nextAudioCut <= 0 || nextAudioCut >= audio.matched || audioBefore >= previousAudio.length ||
      Math.abs(nextAudio[nextAudioCut].pts - target) > 0.03 ||
      Math.abs((previousVideo[videoBefore].pts - previousAudio[audioBefore].pts) -
        (nextVideo[nextVideoCut].pts - nextAudio[nextAudioCut].pts)) > 0.06) return undefined;
  return { videoBefore, audioBefore, videoAfter: nextVideo.length - nextVideoCut,
    audioAfter: nextAudio.length - nextAudioCut,
    videoOverlapStart: video.start, audioOverlapStart: audio.start,
    offset: Number(offset.toFixed(6)), previousOffset: Number(previousOffset.toFixed(6)),
    droppedDamagedPictures: video.unmatched };
}
