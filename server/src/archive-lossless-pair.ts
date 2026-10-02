export type VideoSignature = { hash: string; pts: number; key: boolean };
export type AudioSignature = { hash: string; pts: number };
export type LosslessPairCut = {
  videoBefore: number; audioBefore: number; videoAfter: number; audioAfter: number;
  offset: number; droppedDamagedPictures: number;
};

/** Choose only an already-duplicated keyframe and matching AAC packet boundary.
 * A terminal frame may be discarded only when the caller independently proves
 * it is corrupt and the clean next segment supplies the same picture. */
export function selectLosslessPairCut(
  previousVideo: VideoSignature[], nextVideo: VideoSignature[],
  previousAudio: AudioSignature[], nextAudio: AudioSignature[],
  provenTerminalDamage: boolean,
): LosslessPairCut | undefined {
  if (previousVideo.length < 30 || nextVideo.length <= previousVideo.length + 30 ||
      previousAudio.length < 40 || nextAudio.length <= previousAudio.length + 40) return undefined;
  if (!previousAudio.every((packet, index) => packet.hash === nextAudio[index]?.hash)) return undefined;
  const matched = previousVideo.findIndex((packet, index) => packet.hash !== nextVideo[index]?.hash);
  const matchedPictures = matched === -1 ? previousVideo.length : matched;
  const unmatched = previousVideo.length - matchedPictures;
  if (unmatched !== 0 && !(unmatched === 1 && provenTerminalDamage)) return undefined;
  if (nextVideo.length - matchedPictures < 30 ||
      !previousVideo.every((packet, index) => index >= matchedPictures || packet.hash === nextVideo[index]?.hash)) return undefined;
  const firstVideoTime = nextVideo[0].pts;
  const firstAudioTime = nextAudio[0].pts;
  let videoBefore = -1;
  for (let index = matchedPictures - 1; index > 0; index--) {
    if (nextVideo[index].key) { videoBefore = index; break; }
  }
  if (videoBefore < 0) return undefined;
  const offset = nextVideo[videoBefore].pts - firstVideoTime;
  const fps = 1 / (nextVideo[1].pts - firstVideoTime);
  if (!Number.isFinite(offset) || offset < 0.5 || !Number.isFinite(fps) || fps < 12 || fps > 60 ||
      !Number.isFinite(firstAudioTime) ||
      Math.abs((previousAudio[0].pts - previousVideo[0].pts) - (firstAudioTime - firstVideoTime)) > 0.03 ||
      Math.abs(firstAudioTime - firstVideoTime) > 0.15 ||
      nextVideo.length - videoBefore > 9.5 * fps ||
      previousVideo.slice(videoBefore, matchedPictures).some((p, i) => p.hash !== nextVideo[videoBefore + i].hash)) return undefined;
  const target = nextVideo[videoBefore].pts;
  const firstAfter = nextAudio.findIndex(packet => packet.pts >= target);
  const candidates = [firstAfter - 1, firstAfter].filter(index => index >= 0 && index < nextAudio.length);
  const audioBefore = candidates.sort((a, b) =>
    Math.abs(nextAudio[a].pts - target) - Math.abs(nextAudio[b].pts - target))[0] ?? -1;
  if (audioBefore <= 0 || audioBefore >= previousAudio.length ||
      Math.abs(nextAudio[audioBefore].pts - nextVideo[videoBefore].pts) > 0.03 ||
      !Number.isFinite(previousAudio[audioBefore]?.pts)) return undefined;
  return { videoBefore, audioBefore, videoAfter: nextVideo.length - videoBefore,
    audioAfter: nextAudio.length - audioBefore,
    offset: Number(offset.toFixed(6)), droppedDamagedPictures: unmatched };
}
