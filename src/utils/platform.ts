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