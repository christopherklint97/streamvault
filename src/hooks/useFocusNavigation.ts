import { useState, useEffect, useCallback, type RefObject } from 'react';
import { KEY_CODES } from '../utils/keys';

export function useFocusNavigation(
  containerRef: RefObject<HTMLElement | null>,
  columnCount: number
): { focusIndex: number; setFocusIndex: React.Dispatch<React.SetStateAction<number>> } {
  const [focusIndex, setFocusIndex] = useState(0);

  // Focus the element at the given index
  const focusElement = useCallback((container: HTMLElement, index: number) => {
    const elements = container.querySelectorAll('[data-focusable]');
    const el = elements[index] as HTMLElement | undefined;
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest' });
    }
  }, []);

  // Set initial focus when container mounts or receives focus
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleContainerFocus = (e: FocusEvent) => {
      // Only act when the container itself gets focus (not its children)
      if (e.target === container) {
        focusElement(container, focusIndex);
      }
    };

    container.addEventListener('focus', handleContainerFocus);
    return () => container.removeEventListener('focus', handleContainerFocus);
  }, [containerRef, focusIndex, focusElement]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container) return;

      const focusableElements = container.querySelectorAll('[data-focusable]');
      const count = focusableElements.length;
      if (count === 0) return;

      let nextIndex = focusIndex;

      switch (e.keyCode) {
        case KEY_CODES.LEFT:
          if (focusIndex % columnCount > 0) {
            nextIndex = focusIndex - 1;
            e.preventDefault();
          }
          // At left edge: don't preventDefault, let it bubble to sidebar handler
          break;
        case KEY_CODES.RIGHT:
          if (focusIndex % columnCount < columnCount - 1 && focusIndex + 1 < count) {
            nextIndex = focusIndex + 1;
            e.preventDefault();
          }
          break;
        case KEY_CODES.UP:
          if (focusIndex - columnCount >= 0) {
            nextIndex = focusIndex - columnCount;
            e.preventDefault();
          }
          // At top edge: don't preventDefault, let it bubble
          break;
        case KEY_CODES.DOWN:
          if (focusIndex + columnCount < count) {
            nextIndex = focusIndex + columnCount;
            e.preventDefault();
          }
          // At bottom edge: don't preventDefault, let it bubble
          break;
        default:
          return;
      }

      if (nextIndex !== focusIndex) {
        setFocusIndex(nextIndex);
        focusElement(container, nextIndex);
      }
    },
    [containerRef, columnCount, focusIndex, focusElement]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }, [containerRef, handleKeyDown]);

  return { focusIndex, setFocusIndex };
}
