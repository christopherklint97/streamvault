import { useRef, useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import type { View } from '../types';
import { KEY_CODES } from '../utils/keys';

interface NavItem {
  icon: string;
  label: string;
  view: View;
}

const NAV_ITEMS: NavItem[] = [
  { icon: '\u25C6', label: 'Home', view: 'home' },
  { icon: '\u25B8', label: 'Live TV', view: 'channels' },
  { icon: '\u25FB', label: 'Movies', view: 'movies' },
  { icon: '\u2261', label: 'Series', view: 'series' },
  { icon: '\u2736', label: 'Settings', view: 'settings' },
];

export default function Sidebar() {
  const currentView = useAppStore((s) => s.currentView);
  const navigate = useAppStore((s) => s.navigate);
  const sidebarRef = useRef<HTMLElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, view: View, index: number) => {
      if (e.keyCode === KEY_CODES.ENTER) {
        e.preventDefault();
        navigate(view);
      } else if (e.keyCode === KEY_CODES.UP) {
        e.preventDefault();
        const items = sidebarRef.current?.querySelectorAll('.sidebar-item') as NodeListOf<HTMLElement> | undefined;
        if (items && index > 0) {
          items[index - 1].focus();
        }
      } else if (e.keyCode === KEY_CODES.DOWN) {
        e.preventDefault();
        const items = sidebarRef.current?.querySelectorAll('.sidebar-item') as NodeListOf<HTMLElement> | undefined;
        if (items && index < items.length - 1) {
          items[index + 1].focus();
        }
      } else if (e.keyCode === KEY_CODES.RIGHT) {
        e.preventDefault();
        // Move focus to main content area
        const container = document.querySelector('.app__content > [tabindex]') as HTMLElement | null;
        const focusable = document.querySelector('.app__content [data-focusable]') as HTMLElement | null;
        (container ?? focusable)?.focus();
      }
    },
    [navigate]
  );

  return (
    <nav className="sidebar" ref={sidebarRef}>
      <div className="sidebar-logo">SV</div>
      <ul className="sidebar-nav">
        {NAV_ITEMS.map((item, index) => (
          <li key={item.view}>
            <button
              className={`sidebar-item${currentView === item.view ? ' sidebar-item--active' : ''}`}
              data-focusable
              tabIndex={0}
              onKeyDown={(e) => handleKeyDown(e, item.view, index)}
              onClick={() => navigate(item.view)}
            >
              <span className="sidebar-icon">{item.icon}</span>
              <span className="sidebar-label">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
