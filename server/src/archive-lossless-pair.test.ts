import { describe, expect, it } from 'vitest';
import { selectLosslessPairCut } from './archive-lossless-pair.js';

const video = (n: number, fps = 50) => Array.from({ length: n }, (_, i) => ({
  hash: `v${i}`, pts: 1.4 + i / fps, key: i % 96 === 0,
}));
const audio = (n: number) => Array.from({ length: n }, (_, i) => ({
  hash: `a${i}`, pts: 1.409067 + i * 1024 / 48000,
}));

describe('exact two-stream seam cut', () => {
  const nextVideo = video(1056);
  const nextAudio = audio(990);
  it('cuts at the last common keyframe, removing a damaged terminal predecessor picture', () => {
    const priorVideo = [...nextVideo.slice(0, 745), { hash: 'corrupt', pts: 1.4 + 745 / 50, key: false }];
    const cut = selectLosslessPairCut(priorVideo, nextVideo, nextAudio.slice(0, 698), nextAudio, true);
    expect(cut).toMatchObject({ videoBefore: 672, audioBefore: 630, videoAfter: 384,
      audioAfter: 360, offset: 13.44, previousOffset: 13.44,
      videoOverlapStart: 0, audioOverlapStart: 0, droppedDamagedPictures: 1 });
  });
  it('rejects an unmatched picture unless it is proved to be one damaged terminal picture', () => {
    const priorVideo = [...nextVideo.slice(0, 745), { hash: 'corrupt', pts: 16.3, key: false }];
    expect(selectLosslessPairCut(priorVideo, nextVideo, nextAudio.slice(0, 698), nextAudio, false)).toBeUndefined();
    priorVideo[370] = { hash: 'different unique picture', pts: 8.8, key: false };
    expect(selectLosslessPairCut(priorVideo, nextVideo, nextAudio.slice(0, 698), nextAudio, true)).toBeUndefined();
  });
  it('rejects nonidentical audio and a cut lacking a nearby AAC boundary', () => {
    const priorAudio = nextAudio.slice(0, 698).map(packet => ({ ...packet }));
    priorAudio[13].hash = 'different audio';
    expect(selectLosslessPairCut(nextVideo.slice(0, 745), nextVideo, priorAudio, nextAudio, false)).toBeUndefined();
    const shifted = nextAudio.map(packet => ({ ...packet, pts: packet.pts + 0.22 }));
    expect(selectLosslessPairCut(nextVideo.slice(0, 745), nextVideo, nextAudio.slice(0, 698), shifted, false)).toBeUndefined();
  });
  it('preserves the unique predecessor prefix and partitions a shorter ESPN replay on matching A/V', () => {
    const rate = 30000 / 1001;
    const uniqueVideo = Array.from({ length: 300 }, (_, i) => ({ hash: `unique${i}`, pts: 1.4 + i / rate, key: i % 60 === 0 }));
    const laterVideo = Array.from({ length: 621 }, (_, i) => ({ hash: `replayed${i}`, pts: 1.4 + i / rate,
      key: [0, 66, 75, 143, 218, 225, 300].includes(i) }));
    const priorVideo = [...uniqueVideo, ...laterVideo.slice(0, 189).map((p, i) => ({ ...p, pts: 1.4 + (300 + i) / rate })),
      { hash: 'terminal damage', pts: 1.4 + 489 / rate, key: false }];
    const uniqueAudio = Array.from({ length: 469 }, (_, i) => ({ hash: `uniqueAAC${i}`, pts: 1.409067 + i * 1024 / 48000 }));
    const laterAudio = audio(972);
    const priorAudio = [...uniqueAudio, ...laterAudio.slice(0, 288).map((p, i) =>
      ({ ...p, pts: 1.409067 + (469 + i) * 1024 / 48000 }))];
    expect(selectLosslessPairCut(priorVideo, laterVideo, priorAudio, laterAudio, true)).toMatchObject({
      videoBefore: 443, videoAfter: 478, videoOverlapStart: 300, audioOverlapStart: 469,
      droppedDamagedPictures: 1,
    });
  });
});
