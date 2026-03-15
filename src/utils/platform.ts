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
 * Uses window.open to avoid navigating away from the SPA.
 * On Android, tries intent scheme first (for VLC/MX Player), falls back to new tab.
 * On iOS/other, opens a lightweight HTML player page so Safari uses its native <video> controls.
 * (Opening a raw MPEG-TS URL directly in Safari shows garbled binary data.)
 */
export function openInNativePlayer(url: string, playerPageUrl?: string): void {
  // Android: try intent scheme via a temporary link (more reliable than window.location in PWAs)
  if (/Android/i.test(navigator.userAgent)) {
    const intentUrl = `intent:${url}#Intent;type=video/*;end`;
    const link = document.createElement('a');
    link.href = intentUrl;
    link.click();
    // If intent didn't fire (no handler), fall back to opening URL directly
    setTimeout(() => {
      window.open(url, '_blank');
    }, 500);
    return;
  }

  // iOS / other: open the HTML player page which embeds a <video> element
  window.open(playerPageUrl || url, '_blank');
}
