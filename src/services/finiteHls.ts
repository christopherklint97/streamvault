import type Hls from 'hls.js';

/** Attach a finite VOD HLS playlist without substituting a LIVE media clock. */
export async function attachFiniteHls(
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
  if (!HlsPlayer.isSupported()) throw new Error('Seekable HLS playback is not supported on this device');
  const hls: Hls = new HlsPlayer({ enableWorker: true, backBufferLength: 60 });
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
