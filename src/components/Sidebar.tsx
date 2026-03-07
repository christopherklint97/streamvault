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
  { icon: '\u25A6', label: 'Guide', view: 'guide' },
  { icon: '\u2736', label: 'Settings', view: 'settings' },
];

export default function Sidebar() {
  const currentView = useAppStore((s) => s.currentView);
  const navigate = useAppStore((s) => s.navigate);
  const sidebarRef = useRef<HTMLElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, view: View) => {
      if (e.keyCode === KEY_CODES.ENTER) {
        e.preventDefault();
        navigate(view);
      }
    },
    [navigate]
  );

  return (
    <nav className="sidebar" ref={sidebarRef}>
      <div className="sidebar-logo">SV</div>
      <ul className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <li key={item.view}>
            <button
              className={`sidebar-item${currentView === item.view ? ' sidebar-item--active' : ''}`}
              data-focusable
              tabIndex={0}
              onKeyDown={(e) => handleKeyDown(e, item.view)}
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
