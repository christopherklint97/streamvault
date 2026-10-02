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
    expect(cut).toEqual({ videoBefore: 672, audioBefore: 630, videoAfter: 384,
      audioAfter: 360, offset: 13.44, droppedDamagedPictures: 1 });
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
});
