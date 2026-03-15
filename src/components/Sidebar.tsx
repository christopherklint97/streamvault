import { useRef, useCallback, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import type { View } from '../types';
import { KEY_CODES } from '../utils/keys';
import { isMobile } from '../utils/platform';
import { cn } from '../utils/cn';

const MOBILE = isMobile();

interface NavItem {
  label: string;
  view: View;
  icon: React.ReactNode;
}

// SVG icons for nav items
const NAV_ITEMS: NavItem[] = [
  {
    label: 'Home', view: 'home',
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>,
  },
  {
    label: 'Live TV', view: 'channels',
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="15" rx="2" ry="2" /><polyline points="17 2 12 7 7 2" /></svg>,
  },
  {
    label: 'Guide', view: 'guide',
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>,
  },
  {
    label: 'Movies', view: 'movies',
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" /><line x1="2" y1="17" x2="7" y2="17" /><line x1="17" y1="17" x2="22" y2="17" /><line x1="17" y1="7" x2="22" y2="7" /></svg>,
  },
  {
    label: 'Series', view: 'series',
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>,
  },
  {
    label: 'DVR', view: 'recordings',
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" /></svg>,
  },
  {
    label: 'Settings', view: 'settings',
    icon: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
  },
];

/** Hamburger menu icon */
function MenuIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

export default function Sidebar() {
  const currentView = useAppStore((s) => s.currentView);
  const navigate = useAppStore((s) => s.navigate);
  const sidebarRef = useRef<HTMLElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  const handleMobileNav = useCallback((view: View) => {
    navigate(view);
    setDrawerOpen(false);
  }, [navigate]);

  // Mobile: hamburger button + slide-out drawer
  if (MOBILE) {
    return (
      <>
        {/* Hamburger button - fixed top-left */}
        <button
          className="fixed top-[calc(12px+env(safe-area-inset-top,0px))] left-3 z-[200] flex items-center justify-center w-10 h-10 rounded-full bg-dark-sidebar/80 backdrop-blur-sm border border-white/[0.08] text-white tap-none active:bg-white/[0.12]"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
        >
          <MenuIcon />
        </button>

        {/* Backdrop */}
        {drawerOpen && (
          <div
            className="fixed inset-0 z-[998] bg-black/60 animate-fade-in-fast"
            onClick={() => setDrawerOpen(false)}
          />
        )}

        {/* Drawer */}
        <nav
          className={cn(
            'fixed top-0 left-0 bottom-0 z-[999] w-64 bg-dark-sidebar border-r border-white/[0.08] pt-[calc(16px+env(safe-area-inset-top,0px))] pb-[env(safe-area-inset-bottom,0px)] transition-transform duration-250 ease-out',
            drawerOpen ? 'translate-x-0' : '-translate-x-full'
          )}
        >
          {/* Drawer header */}
          <div className="flex items-center gap-3 px-5 pb-5 mb-2 border-b border-white/[0.06]">
            <span className="text-20 font-bold text-accent">StreamVault</span>
            <button
              className="ml-auto flex items-center justify-center w-9 h-9 rounded-full text-white/60 tap-none active:text-white"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close menu"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Nav items */}
          <ul className="flex flex-col gap-0.5 px-3 list-none">
            {NAV_ITEMS.map((item) => (
              <li key={item.view}>
                <button
                  className={cn(
                    'flex items-center gap-3 w-full py-3 px-3 rounded-lg text-[15px] text-[#888] tap-none transition-colors duration-150 active:bg-white/[0.06]',
                    currentView === item.view && 'text-accent bg-accent/[0.08]'
                  )}
                  onClick={() => handleMobileNav(item.view)}
                >
                  <span className={cn('opacity-60', currentView === item.view && 'opacity-100 text-accent')}>{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </>
    );
  }

  // Desktop/TV: vertical sidebar (unchanged)
  return (
    <nav className="flex w-sidebar h-tv flex-col items-center pt-5 shrink-0 z-[100] border-r border-white/[0.06] bg-dark-sidebar [contain:layout_style_paint]" ref={sidebarRef}>
      <div className="text-24 font-bold text-accent mb-8">SV</div>
      <ul className="flex flex-col gap-1 w-full list-none">
        {NAV_ITEMS.map((item, index) => (
          <li key={item.view}>
            <button
              className={cn(
                'flex flex-row items-center gap-3 py-3.5 justify-center text-20 border-l-[3px] border-transparent transition-all duration-150 focus:text-white focus:bg-gradient-to-r focus:from-accent/[0.12] focus:to-transparent focus:border-l-accent w-full',
                currentView === item.view && 'text-[#aaa] border-l-accent'
              )}
              data-sidebar-item
              {...(currentView === item.view ? { 'data-active': '' } : {})}
              data-focusable
              tabIndex={0}
              onKeyDown={(e) => handleKeyDown(e, item.view, index)}
              onClick={() => navigate(item.view)}
            >
              <span className="text-22">{item.icon}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
