export const FOCUSABLE_SELECTOR = [
  '[data-focusable]:not([disabled]):not([aria-hidden="true"])',
  'button:not([disabled]):not([aria-hidden="true"])',
  'input:not([disabled]):not([aria-hidden="true"])',
  'textarea:not([disabled]):not([aria-hidden="true"])',
  'select:not([disabled]):not([aria-hidden="true"])',
  'a[href]:not([aria-hidden="true"])',
].join(',');

/** Rendered with a box — false for display:none subtrees such as `lg:hidden` controls or kept-alive hidden views. */
export function isRendered(el: Element): boolean {
  return el.getClientRects().length > 0;
}

export function firstRenderedFocusable(root: ParentNode, selector = FOCUSABLE_SELECTOR): HTMLElement | null {
  const candidates = root.querySelectorAll<HTMLElement>(selector);
  for (let i = 0; i < candidates.length; i++) {
    if (isRendered(candidates[i])) return candidates[i];
  }
  return null;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

/**
 * Spatial navigation: find the nearest [data-focusable] element
 * in a given direction from the currently focused element.
 *
 * Uses a weighted scoring system:
 * - Primary axis distance (the direction of movement)
 * - Secondary axis distance (perpendicular, penalized heavily to prefer alignment)
 */
/**
 * Compute the gap between two ranges on one axis.
 * Returns 0 if they overlap, otherwise the distance between closest edges.
 */
function axisGap(aMin: number, aMax: number, bMin: number, bMax: number): number {
  if (aMax <= bMin) return bMin - aMax;
  if (bMax <= aMin) return aMin - bMax;
  return 0; // overlapping
}

export function findNearest(
  current: HTMLElement,
  direction: Direction,
  container: HTMLElement,
): HTMLElement | null {
  const rect = current.getBoundingClientRect();

  const candidates = container.querySelectorAll(FOCUSABLE_SELECTOR);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i] as HTMLElement;
    if (candidate === current) continue;
    // Skip hidden or zero-size elements
    if (!isRendered(candidate)) continue;

    const cRect = candidate.getBoundingClientRect();
    if (cRect.width === 0 && cRect.height === 0) continue;

    let primaryDist: number;
    let secondaryGap: number;
    let isInDirection: boolean;

    const cy = rect.top + rect.height / 2;
    const ccy = cRect.top + cRect.height / 2;
    const cx = rect.left + rect.width / 2;
    const ccx = cRect.left + cRect.width / 2;

    switch (direction) {
      case 'up':
        isInDirection = ccy < cy - 1;
        primaryDist = cy - ccy;
        // Use edge-gap instead of center distance — 0 if they overlap horizontally
        secondaryGap = axisGap(rect.left, rect.right, cRect.left, cRect.right);
        break;
      case 'down':
        isInDirection = ccy > cy + 1;
        primaryDist = ccy - cy;
        secondaryGap = axisGap(rect.left, rect.right, cRect.left, cRect.right);
        break;
      case 'left':
        isInDirection = ccx < cx - 1;
        primaryDist = cx - ccx;
        secondaryGap = axisGap(rect.top, rect.bottom, cRect.top, cRect.bottom);
        break;
      case 'right':
        isInDirection = ccx > cx + 1;
        primaryDist = ccx - cx;
        secondaryGap = axisGap(rect.top, rect.bottom, cRect.top, cRect.bottom);
        break;
    }

    if (!isInDirection) continue;

    // Score: primary distance + heavy penalty for non-overlapping elements.
    // If elements overlap on the perpendicular axis, secondaryGap is 0
    // so they're scored purely by distance in the movement direction.
    const score = primaryDist + secondaryGap * 5;

    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

/** Focus the entry point of the visible content area. Returns whether something took focus. */
export function focusContentEntry(): boolean {
  const content = document.querySelector('[data-app-content]');
  if (!content) return false;
  const target = firstRenderedFocusable(content, '[data-active-view] [data-content-entry]')
    ?? firstRenderedFocusable(content);
  if (!target) return false;
  target.focus();
  return document.activeElement === target;
}

export function focusActiveSidebarItem(): boolean {
  const item = firstRenderedFocusable(document, '[data-sidebar-item][data-active]')
    ?? firstRenderedFocusable(document, '[data-sidebar-item]');
  item?.focus();
  return !!item && document.activeElement === item;
}

/** True when keys would go nowhere: nothing focused, or the focused node was removed or hidden. */
export function isFocusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active === document.documentElement
    || !active.isConnected || !isRendered(active);
}

/** Put remote focus somewhere usable after the focused control vanished. */
export function recoverFocus(): void {
  if (!focusContentEntry()) focusActiveSidebarItem();
}
