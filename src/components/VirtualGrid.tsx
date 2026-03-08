import { useState, useRef, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';

interface VirtualGridProps {
  itemCount: number;
  columnCount: number;
  rowHeight: number;
  containerHeight: number;
  renderItem: (index: number) => ReactNode;
  className?: string;
}

const ROW_BUFFER = 3;

export default function VirtualGrid({
  itemCount,
  columnCount,
  rowHeight,
  containerHeight,
  renderItem,
  className,
}: VirtualGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const rafRef = useRef<number>(0);

  const totalRows = Math.ceil(itemCount / columnCount);
  const totalHeight = totalRows * rowHeight;

  const visibleRows = Math.ceil(containerHeight / rowHeight);
  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - ROW_BUFFER);
  const endRow = Math.min(totalRows - 1, Math.floor(scrollTop / rowHeight) + visibleRows + ROW_BUFFER);

  const handleScroll = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = requestAnimationFrame(() => {
      if (containerRef.current) {
        setScrollTop(containerRef.current.scrollTop);
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  // Auto-scroll to keep focused item visible
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (!target.hasAttribute('data-focusable')) return;

      const targetRect = target.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();

      if (targetRect.top < containerRect.top) {
        container.scrollTop -= containerRect.top - targetRect.top + rowHeight;
      } else if (targetRect.bottom > containerRect.bottom) {
        container.scrollTop += targetRect.bottom - containerRect.bottom + rowHeight;
      }
    };

    container.addEventListener('focusin', handleFocusIn);
    return () => container.removeEventListener('focusin', handleFocusIn);
  }, [rowHeight]);

  const rows: ReactNode[] = [];
  for (let row = startRow; row <= endRow; row++) {
    const items: ReactNode[] = [];
    for (let col = 0; col < columnCount; col++) {
      const index = row * columnCount + col;
      if (index < itemCount) {
        items.push(renderItem(index));
      }
    }
    rows.push(
      <div
        key={row}
        className="virtual-grid__row"
        style={{
          transform: `translateY(${row * rowHeight}px)`,
          height: rowHeight,
          gridTemplateColumns: `repeat(${columnCount}, 1fr)`,
        }}
      >
        {items}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`virtual-grid${className ? ` ${className}` : ''}`}
      style={{ height: containerHeight }}
      onScroll={handleScroll}
    >
      <div className="virtual-grid__inner" style={{ height: totalHeight }}>
        {rows}
      </div>
    </div>
  );
}
