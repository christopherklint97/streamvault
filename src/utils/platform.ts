/** Platform detection utilities */

let _isMobile: boolean | null = null;

export function isMobile(): boolean {
  if (_isMobile !== null) return _isMobile;
  _isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 0 && window.innerWidth < 1024);
  return _isMobile;
}

export function isIPhone(): boolean {
  return /iPhone|iPod/i.test(navigator.userAgent);
}

export function isTizen(): boolean {
  return typeof webapis !== 'undefined' && typeof webapis.avplay !== 'undefined';
}

// ---------------------------------------------------------------------------
// Picture-in-Picture helpers (standard + webkit/Safari fallback for iPhone)
// ---------------------------------------------------------------------------

type WebKitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
};

/** Check if PiP is supported for a given video element */
export function canPiP(video: HTMLVideoElement): boolean {
  // Standard API
  if (document.pictureInPictureEnabled && !video.disablePictureInPicture) return true;
  // WebKit / Safari API (iPhone, older Safari)
  const wv = video as WebKitVideo;
  if (typeof wv.webkitSupportsPresentationMode === 'function') {
    return wv.webkitSupportsPresentationMode('picture-in-picture');
  }
  return false;
}

/** Check if currently in PiP */
export function isInPiP(video: HTMLVideoElement): boolean {
  if (document.pictureInPictureElement === video) return true;
  const wv = video as WebKitVideo;
  if (wv.webkitPresentationMode === 'picture-in-picture') return true;
  return false;
}

/** Request PiP — tries standard API first, then webkit fallback */
export async function enterPiP(video: HTMLVideoElement): Promise<void> {
  // Standard API (Chrome, Edge, modern Safari)
  if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
    await video.requestPictureInPicture();
    return;
  }
  // WebKit / Safari fallback (iPhone)
  const wv = video as WebKitVideo;
  if (typeof wv.webkitSetPresentationMode === 'function') {
    wv.webkitSetPresentationMode('picture-in-picture');
    return;
  }
  throw new Error('PiP not supported');
}

/** Exit PiP */
export async function exitPiP(video: HTMLVideoElement): Promise<void> {
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
    return;
  }
  const wv = video as WebKitVideo;
  if (wv.webkitPresentationMode === 'picture-in-picture' && wv.webkitSetPresentationMode) {
    wv.webkitSetPresentationMode('inline');
  }
}