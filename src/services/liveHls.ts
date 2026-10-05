import type Hls from 'hls.js';

/** Attach a rolling live HLS playlist without replacing the player at source EOF. */
export async function attachLiveHls(
  video: HTMLVideoElement,
  url: string,
  onFatal: (detail: string) => void,
): Promise<() => void> {
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.load();
    return () => { video.removeAttribute('src'); video.load(); };
  }

  const { default: HlsPlayer } = await import('hls.js');
  if (!HlsPlayer.isSupported()) throw new Error('Live HLS playback is not supported on this device');
  const hls: Hls = new HlsPlayer({
    enableWorker: true,
    backBufferLength: 30,
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 8,
  });
  let disposed = false;
  hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
    if (!data.fatal || disposed) return;
    disposed = true;
    hls.destroy();
    onFatal(data.details);
  });
  hls.attachMedia(video);
  hls.loadSource(url);
  return () => {
    if (disposed) return;
    disposed = true;
    hls.destroy();
  };
}
