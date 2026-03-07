import { useState, useEffect, useCallback, type RefObject } from 'react';
import { KEY_CODES } from '../utils/keys';

export function useFocusNavigation(
  containerRef: RefObject<HTMLElement | null>,
  columnCount: number
): { focusIndex: number; setFocusIndex: React.Dispatch<React.SetStateAction<number>> } {
  const [focusIndex, setFocusIndex] = useState(0);

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
          break;
        case KEY_CODES.DOWN:
          if (focusIndex + columnCount < count) {
            nextIndex = focusIndex + columnCount;
            e.preventDefault();
          }
          break;
        default:
          return;
      }

      if (nextIndex !== focusIndex) {
        setFocusIndex(nextIndex);
        const el = focusableElements[nextIndex] as HTMLElement;
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    },
    [containerRef, columnCount, focusIndex]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('keydown', handleKeyDown);
    return () => container.removeEventListener('keydown', handleKeyDown);
  }, [containerRef, handleKeyDown]);

  return { focusIndex, setFocusIndex };
}
