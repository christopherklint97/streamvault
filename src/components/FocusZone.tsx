import { useRef, useEffect, useCallback, type ReactNode } from 'react';
import { KEY_CODES } from '../utils/keys';
import { cn } from '../utils/cn';

type Direction = 'up' | 'down' | 'left' | 'right';

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

function findNearest(
  current: HTMLElement,
  direction: Direction,
  container: HTMLElement,
): HTMLElement | null {
  const rect = current.getBoundingClientRect();

  const candidates = container.querySelectorAll('[data-focusable]');
  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i] as HTMLElement;
    if (candidate === current) continue;
    // Skip hidden or zero-size elements
    if (candidate.offsetParent === null && candidate.offsetHeight === 0) continue;

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

function isTextInput(el: HTMLElement): boolean {
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return type === 'text' || type === 'search' || type === 'url' ||
           type === 'email' || type === 'password' || type === 'tel' ||
           type === 'number';
  }
  return el.isContentEditable;
}

interface FocusZoneProps {
  children: ReactNode;
  className?: string;
  /** Called on ENTER key with the focused element. Return true to prevent default handling. */
  onEnter?: (el: HTMLElement) => boolean | void;
}

/**
 * FocusZone — drop-in spatial navigation for any layout.
 *
 * Wrap any content in <FocusZone>. Mark focusable items with `data-focusable`.
 * Arrow keys navigate spatially between items. Works with any layout
 * (grids, rows, columns, mixed) without configuration.
 *
 * - UP/DOWN: find nearest element above/below
 * - LEFT/RIGHT: find nearest element to the left/right
 * - LEFT at leftmost edge: event bubbles up (so sidebar can catch it)
 * - Text inputs: LEFT/RIGHT are passed through for cursor movement
 * - ENTER: clicks the focused element
 */
export default function FocusZone({ children, className, onEnter }: FocusZoneProps) {
  const ref = useRef<HTMLDivElement>(null);

  // When the container itself receives focus, focus the first (or last focused) item
  const handleFocus = useCallback((e: React.FocusEvent) => {
    if (e.target !== ref.current) return;
    const container = ref.current;
    if (!container) return;

    // Try to find a previously focused item
    const lastFocused = container.querySelector('[data-focusable]:focus') as HTMLElement | null;
    if (lastFocused) return;

    const first = container.querySelector('[data-focusable]') as HTMLElement | null;
    if (first) {
      first.focus({ preventScroll: true });
    }
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const container = ref.current;
      if (!container) return;

      const active = document.activeElement as HTMLElement;
      if (!active || !container.contains(active)) return;
      // Don't handle if focus is on the container itself
      if (active === container) return;

      // ENTER: click the focused element
      if (e.keyCode === KEY_CODES.ENTER) {
        if (onEnter) {
          const handled = onEnter(active);
          if (handled) {
            e.preventDefault();
            return;
          }
        }
        // For non-input elements, trigger click
        if (!isTextInput(active)) {
          e.preventDefault();
          active.click();
          return;
        }
        return;
      }

      // Determine direction
      let direction: Direction | null = null;
      switch (e.keyCode) {
        case KEY_CODES.UP: direction = 'up'; break;
        case KEY_CODES.DOWN: direction = 'down'; break;
        case KEY_CODES.LEFT: direction = 'left'; break;
        case KEY_CODES.RIGHT: direction = 'right'; break;
        default: return;
      }

      // Text inputs: let LEFT/RIGHT through for cursor movement
      if (isTextInput(active) && (direction === 'left' || direction === 'right')) {
        return;
      }

      const next = findNearest(active, direction, container);
      if (next) {
        e.preventDefault();
        e.stopPropagation();
        next.focus({ preventScroll: true });
        next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      // If no element found, don't preventDefault — let it bubble.
      // LEFT at left edge → bubbles to App.tsx → focuses sidebar.
    },
    [onEnter],
  );

  // Auto-focus first item on mount if nothing else in the app has focus
  // (happens after view navigation e.g. Home → Settings)
  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    // Use rAF to run after React has finished rendering the new view
    const raf = requestAnimationFrame(() => {
      const active = document.activeElement;
      // If focus is on body, or on an element no longer in the DOM, or on our container itself
      // but NOT if focus is validly on a sidebar item (user navigated via sidebar)
      const focusLost = !active || active === document.body || active === container;
      const focusOnDeadElement = active && active !== document.body && !document.body.contains(active);
      if (focusLost || focusOnDeadElement) {
        const first = container.querySelector('[data-focusable]') as HTMLElement | null;
        first?.focus({ preventScroll: true });
      }
    });

    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={ref}
      tabIndex={0}
      className={cn('outline-none', className)}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
}
