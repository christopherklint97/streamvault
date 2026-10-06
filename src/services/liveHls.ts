import type Hls from 'hls.js';
import { isAppleMobile } from '../utils/platform';

/** Attach a rolling live HLS playlist without replacing the player at source EOF. */
export async function attachLiveHls(
  video: HTMLVideoElement,
  url: string,
  onFatal: (detail: string) => void,
  isCurrent: () => boolean = () => true,
  loadHls: () => Promise<typeof import('hls.js')> = () => import('hls.js'),
  onBufferAppended?: () => void,
): Promise<() => void> {
  if (!isCurrent()) throw new Error('Live playback superseded');
  const nativeSupported = !!video.canPlayType('application/vnd.apple.mpegurl');
  const nativeAttach = () => {
    video.src = url;
    video.load();
    return () => { video.removeAttribute('src'); video.load(); };
  };
  // Chromium can advertise native HLS but keep too little lead to cover source
  // replay catch-up. Prefer the controlled MSE buffer there; retain WebKit HLS.
  const safari = /Safari\//.test(navigator.userAgent) && !/(Chrome|Chromium|Edg|OPR)\//.test(navigator.userAgent);
  if (nativeSupported && (isAppleMobile() || safari)) return nativeAttach();

  const { default: HlsPlayer } = await loadHls();
  if (!isCurrent()) throw new Error('Live playback superseded');
  if (!HlsPlayer.isSupported()) {
    if (nativeSupported) return nativeAttach();
    throw new Error('Live HLS playback is not supported on this device');
  }
  const hls: Hls = new HlsPlayer({
    enableWorker: true,
    backBufferLength: 30,
    // Six advertised TARGETDURATIONs: 24 seconds on this server's target of
    // four, clamped to the available window. Prioritize headroom over latency.
    liveSyncDurationCount: 6,
    // Preserve buffered playback rather than seeking nearer the edge after a
    // replay burst. The default infinite catch-up threshold avoids a seek that
    // discards the startup lead and emits a visible waiting event.
    liveMaxLatencyDurationCount: Infinity,
  });
  let disposed = false;
  hls.on(HlsPlayer.Events.BUFFER_APPENDED, () => {
    if (disposed || !isCurrent()) return;
    onBufferAppended?.();
  });
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
