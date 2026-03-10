/** Platform detection utilities */

let _isMobile: boolean | null = null;

export function isMobile(): boolean {
  if (_isMobile !== null) return _isMobile;
  _isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 0 && window.innerWidth < 1024);
  return _isMobile;
}

export function isTizen(): boolean {
  return typeof webapis !== 'undefined' && typeof webapis.avplay !== 'undefined';
}

/**
 * Open a stream URL in the device's native video player.
 * On Android, this triggers an intent chooser (VLC, MX Player, etc.)
 * On iOS, Safari handles video natively.
 */
export function openInNativePlayer(url: string): void {
  // Android: use intent scheme for video apps
  if (/Android/i.test(navigator.userAgent)) {
    const intentUrl = `intent:${url}#Intent;type=video/*;end`;
    window.location.href = intentUrl;
    return;
  }

  // iOS / other: open directly — the OS will handle it
  window.location.href = url;
}
