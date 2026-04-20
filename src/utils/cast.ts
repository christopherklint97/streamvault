/**
 * Chromecast sender integration.
 *
 * Loads the Google Cast sender framework and exposes helpers for casting the
 * currently playing media. Live MPEG-TS streams are not supported by the
 * default receiver — VOD (MP4/HLS) should work out of the box.
 */

// Minimal shape of the Cast SDK we actually use.
type CastState = 'NO_DEVICES_AVAILABLE' | 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED';
type CastContextEvent = { castState: CastState };
type CastMediaStatus = { currentTime?: number };
type CastSession = {
  loadMedia: (req: unknown) => Promise<void>;
  getMediaSession: () => { getEstimatedTime?: () => number; media?: CastMediaStatus } | null;
  endSession: (stopCasting: boolean) => void;
};
type CastContext = {
  setOptions: (opts: { receiverApplicationId: string; autoJoinPolicy: string }) => void;
  requestSession: () => Promise<void>;
  getCurrentSession: () => CastSession | null;
  getCastState: () => CastState;
  addEventListener: (type: string, cb: (e: CastContextEvent) => void) => void;
  removeEventListener: (type: string, cb: (e: CastContextEvent) => void) => void;
};

declare global {
  interface Window {
    __onGCastApiAvailable?: (available: boolean) => void;
    cast?: {
      framework: {
        CastContext: { getInstance: () => CastContext };
        CastContextEventType: { CAST_STATE_CHANGED: string };
        CastState: Record<CastState, CastState>;
      };
    };
    chrome?: {
      cast: {
        AutoJoinPolicy: { ORIGIN_SCOPED: string };
        media: {
          DEFAULT_MEDIA_RECEIVER_APP_ID: string;
          MediaInfo: new (url: string, contentType: string) => {
            metadata?: unknown;
            streamType?: string;
          };
          GenericMediaMetadata: new () => { title?: string; images?: { url: string }[] };
          LoadRequest: new (mediaInfo: unknown) => { currentTime?: number; autoplay?: boolean };
          StreamType: { BUFFERED: string; LIVE: string };
        };
      };
    };
  }
}

let initialized = false;
let currentState: CastState = 'NO_DEVICES_AVAILABLE';
const stateListeners = new Set<(s: CastState) => void>();

function supportsCast(): boolean {
  // Cast SDK runs in Chromium-based browsers. Safari (desktop + iOS) and
  // Samsung Tizen should skip loading the script.
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return false;
  if (typeof webapis !== 'undefined' && typeof webapis.avplay !== 'undefined') return false;
  // Heuristic: chrome global + v8 = Chromium. `chrome.cast` won't exist until
  // the sender SDK loads, but the `chrome` object itself indicates Chromium.
  return typeof (window as unknown as { chrome?: unknown }).chrome !== 'undefined';
}

/** Load the Cast sender framework. Safe to call multiple times. */
export function initCast(): void {
  if (initialized) return;
  initialized = true;
  if (!supportsCast()) return;

  window.__onGCastApiAvailable = (available: boolean) => {
    if (!available || !window.cast || !window.chrome?.cast) return;
    const { cast, chrome } = window;
    const context = cast.framework.CastContext.getInstance();
    context.setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    currentState = context.getCastState();
    stateListeners.forEach((fn) => fn(currentState));
    context.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, (e) => {
      currentState = e.castState;
      stateListeners.forEach((fn) => fn(currentState));
    });
  };

  const script = document.createElement('script');
  script.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
  script.async = true;
  document.head.appendChild(script);
}

/** Subscribe to cast state changes. Calls back immediately with the current state. */
export function watchCastState(cb: (state: CastState) => void): () => void {
  stateListeners.add(cb);
  cb(currentState);
  return () => { stateListeners.delete(cb); };
}

export function isCastAvailable(): boolean {
  return currentState !== 'NO_DEVICES_AVAILABLE';
}

export function isCastConnected(): boolean {
  return currentState === 'CONNECTED' || currentState === 'CONNECTING';
}

/** Pick a Cast-compatible MIME type for a given content type. */
export function pickCastMime(contentType: 'livetv' | 'movies' | 'series' | 'recording'): string {
  // Live TV from our proxy is MPEG-TS. Default receiver can't play it, but we
  // still send the correct type so the receiver surfaces a clear error.
  if (contentType === 'livetv') return 'video/mp2t';
  return 'video/mp4';
}

type CastMediaArgs = {
  url: string;
  title: string;
  mimeType: string;
  isLive?: boolean;
  startTime?: number;
  poster?: string;
};

/**
 * Request a cast session (shows the picker if none is active) and start
 * playing the given media.
 */
export async function castMedia(args: CastMediaArgs): Promise<void> {
  if (!window.cast || !window.chrome?.cast) throw new Error('Cast SDK not loaded');
  const { cast, chrome } = window;
  const context = cast.framework.CastContext.getInstance();

  if (!context.getCurrentSession()) {
    await context.requestSession();
  }
  const session = context.getCurrentSession();
  if (!session) throw new Error('No cast session');

  const mediaInfo = new chrome.cast.media.MediaInfo(args.url, args.mimeType);
  mediaInfo.streamType = args.isLive
    ? chrome.cast.media.StreamType.LIVE
    : chrome.cast.media.StreamType.BUFFERED;
  const metadata = new chrome.cast.media.GenericMediaMetadata();
  metadata.title = args.title;
  if (args.poster) metadata.images = [{ url: args.poster }];
  mediaInfo.metadata = metadata;

  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  if (args.startTime && !args.isLive) request.currentTime = args.startTime;
  request.autoplay = true;

  await session.loadMedia(request);
}

/** Stop any active cast session. */
export function stopCasting(): void {
  const session = window.cast?.framework.CastContext.getInstance().getCurrentSession();
  session?.endSession(true);
}
