import { useRef, useCallback } from 'react';
import { useAppStore } from '../stores/appStore';
import type { View } from '../types';
import { KEY_CODES } from '../utils/keys';
import { cn } from '../utils/cn';

interface NavItem {
  icon: string;
  label: string;
  view: View;
}

const NAV_ITEMS: NavItem[] = [
  { icon: '🏠', label: 'Home', view: 'home' },
  { icon: '📺', label: 'Live TV', view: 'channels' },
  { icon: '📋', label: 'Guide', view: 'guide' },
  { icon: '🎬', label: 'Movies', view: 'movies' },
  { icon: '📂', label: 'Series', view: 'series' },
  { icon: '⏺', label: 'DVR', view: 'recordings' },
  { icon: '⚙️', label: 'Settings', view: 'settings' },
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
        const items = sidebarRef.current?.querySelectorAll('[data-sidebar-item]') as NodeListOf<HTMLElement> | undefined;
        if (items && index > 0) {
          items[index - 1].focus();
        }
      } else if (e.keyCode === KEY_CODES.DOWN) {
        e.preventDefault();
        const items = sidebarRef.current?.querySelectorAll('[data-sidebar-item]') as NodeListOf<HTMLElement> | undefined;
        if (items && index < items.length - 1) {
          items[index + 1].focus();
        }
      } else if (e.keyCode === KEY_CODES.RIGHT) {
        e.preventDefault();
        const container = document.querySelector('[data-app-content] > [tabindex]') as HTMLElement | null;
        const focusable = document.querySelector('[data-app-content] [data-focusable]') as HTMLElement | null;
        (container ?? focusable)?.focus();
      }
    },
    [navigate]
  );

  return (
    <nav className="flex w-full flex-row justify-around items-center border-t border-white/[0.08] bg-dark-sidebar pb-[env(safe-area-inset-bottom,0px)] lg:w-sidebar lg:h-tv lg:flex-col lg:items-center lg:pt-5 lg:flex-shrink-0 lg:z-[100] lg:border-r lg:border-white/[0.06] lg:border-t-0 lg:[contain:layout_style_paint]" ref={sidebarRef}>
      <div className="hidden lg:block text-24 font-bold text-accent mb-8">SV</div>
      <ul className="flex flex-row lg:flex-col gap-0 lg:gap-1 w-full justify-around lg:justify-start list-none">
        {NAV_ITEMS.map((item, index) => (
          <li key={item.view}>
            <button
              className={cn(
                'flex flex-col items-center gap-0.5 py-1.5 text-[10px] text-[#555] border-l-0 tap-none lg:flex-row lg:gap-3 lg:py-3.5 lg:justify-center lg:text-20 lg:border-l-[3px] lg:border-transparent lg:transition-all lg:duration-150 focus:text-white lg:focus:bg-gradient-to-r lg:focus:from-accent/[0.12] lg:focus:to-transparent lg:focus:border-l-accent',
                currentView === item.view && 'text-accent lg:text-[#aaa] lg:border-l-accent'
              )}
              data-sidebar-item
              {...(currentView === item.view ? { 'data-active': '' } : {})}
              data-focusable
              tabIndex={0}
              onKeyDown={(e) => handleKeyDown(e, item.view, index)}
              onClick={() => navigate(item.view)}
            >
              <span className="text-20 lg:text-22">{item.icon}</span>
              <span className="block lg:hidden text-[10px]">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
