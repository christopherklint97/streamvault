import { useRef, useEffect, useCallback, type ReactNode } from 'react';
import { KEY_CODES } from '../utils/keys';
import { cn } from '../utils/cn';
import { findNearest, firstRenderedFocusable, isFocusLost, type Direction } from '../utils/focus';

function isTextInput(el: HTMLElement): boolean {
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return type !== 'button' && type !== 'submit' && type !== 'reset' &&
           type !== 'checkbox' && type !== 'radio' && type !== 'range' &&
           type !== 'color' && type !== 'file';
  }
  return el.isContentEditable;
}

interface FocusZoneProps {
  children: ReactNode;
  className?: string;
  /** Called on ENTER key with the focused element. Return true to prevent default handling. */
  onEnter?: (el: HTMLElement) => boolean | void;
  /** Called for the TV Back key or Escape. */
  onBack?: () => void;
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
export default function FocusZone({ children, className, onEnter, onBack }: FocusZoneProps) {
  const ref = useRef<HTMLDivElement>(null);

  // When the container itself receives focus, focus the first (or last focused) item
  const handleFocus = useCallback((e: React.FocusEvent) => {
    if (e.target !== ref.current) return;
    const container = ref.current;
    if (!container) return;

    // Keep focus if one of the zone's children is already active.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== container && container.contains(active)) return;

    firstRenderedFocusable(container)?.focus({ preventScroll: true });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const container = ref.current;
      if (!container) return;

      const active = document.activeElement as HTMLElement;
      if (!active || !container.contains(active)) return;
      // Don't handle if focus is on the container itself
      if (active === container) return;

      if ((e.keyCode === KEY_CODES.BACK || e.keyCode === 27) && onBack) {
        e.preventDefault();
        e.stopPropagation();
        onBack();
        return;
      }

      // Native selects own Enter and all arrow keys. Intercepting them here
      // prevents keyboard/touch-TV users from changing the selected option.
      if (active.tagName === 'SELECT') return;

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
      const direction: Direction | null = (() => {
        switch (e.keyCode) {
          case KEY_CODES.UP: return 'up';
          case KEY_CODES.DOWN: return 'down';
          case KEY_CODES.LEFT: return 'left';
          case KEY_CODES.RIGHT: return 'right';
          default: return null;
        }
      })();
      if (!direction) return;

      // Text inputs and sliders: let LEFT/RIGHT through for caret / value changes
      const ownsHorizontal = isTextInput(active) || (active as HTMLInputElement).type === 'range';
      if (ownsHorizontal && (direction === 'left' || direction === 'right')) {
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
    [onEnter, onBack],
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
      if (active === container || isFocusLost()) {
        firstRenderedFocusable(container)?.focus({ preventScroll: true });
      }
    });

    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={ref}
      data-focus-zone
      tabIndex={0}
      className={cn('outline-hidden', className)}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
}
