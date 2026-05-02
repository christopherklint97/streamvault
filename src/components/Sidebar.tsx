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

// Smaller icons for bottom tab bar
function icon(size: number, children: React.ReactNode) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}

// SVG icons for nav items
const NAV_ITEMS: NavItem[] = [
  {
    label: 'Home', view: 'home',
    icon: icon(22, <><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></>),
  },
  {
    label: 'Live TV', view: 'channels',
    icon: icon(22, <><rect x="2" y="7" width="20" height="15" rx="2" ry="2" /><polyline points="17 2 12 7 7 2" /></>),
  },
  {
    label: 'Guide', view: 'guide',
    icon: icon(22, <><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></>),
  },
  {
    label: 'Movies', view: 'movies',
    icon: icon(22, <><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" /><line x1="7" y1="2" x2="7" y2="22" /><line x1="17" y1="2" x2="17" y2="22" /><line x1="2" y1="12" x2="22" y2="12" /><line x1="2" y1="7" x2="7" y2="7" /><line x1="2" y1="17" x2="7" y2="17" /><line x1="17" y1="17" x2="22" y2="17" /><line x1="17" y1="7" x2="22" y2="7" /></>),
  },
  {
    label: 'Series', view: 'series',
    icon: icon(22, <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>),
  },
  {
    label: 'DVR', view: 'recordings',
    icon: icon(22, <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="4" /></>),
  },
  {
    label: 'Settings', view: 'settings',
    icon: icon(22, <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></>),
  },
];

/** Primary tabs shown in bottom bar */
const PRIMARY_TABS: View[] = ['home', 'channels', 'movies', 'series'];
/** Items behind the "More" menu */
const MORE_VIEWS: View[] = ['guide', 'recordings', 'settings'];

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

  // Mobile: fixed bottom tab bar
  if (MOBILE) {
    const moreItems = NAV_ITEMS.filter((item) => MORE_VIEWS.includes(item.view));
    const primaryItems = NAV_ITEMS.filter((item) => PRIMARY_TABS.includes(item.view));
    const isMoreActive = MORE_VIEWS.includes(currentView);

    return (
      <>
        {/* More menu popup */}
        {drawerOpen && (
          <>
            <div
              className="fixed inset-0 z-[997] tap-none"
              onClick={() => setDrawerOpen(false)}
            />
            <div className="fixed bottom-[56px] right-2 z-[998] bg-dark-sidebar border border-white/[0.1] rounded-xl shadow-2xl overflow-hidden animate-fade-in-fast">
              {moreItems.map((item) => (
                <button
                  key={item.view}
                  className={cn(
                    'flex items-center gap-3 w-full py-3 px-5 text-[15px] text-[#999] tap-none transition-colors duration-150 active:bg-white/[0.06]',
                    currentView === item.view && 'text-accent'
                  )}
                  onClick={() => handleMobileNav(item.view)}
                >
                  <span className={cn('opacity-50', currentView === item.view && 'opacity-100')}>{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {/* Bottom tab bar */}
        <nav className="fixed bottom-0 left-0 right-0 z-[200] bg-dark-sidebar/95 backdrop-blur-md border-t border-white/[0.08]">
          <div className="flex items-stretch justify-around h-14">
            {primaryItems.map((item) => {
              const active = currentView === item.view;
              return (
                <button
                  key={item.view}
                  className={cn(
                    'flex-1 flex flex-col items-center justify-center gap-0.5 tap-none transition-colors duration-150',
                    active ? 'text-accent' : 'text-[#666] active:text-[#999]'
                  )}
                  onClick={() => { navigate(item.view); setDrawerOpen(false); }}
                >
                  <span className={cn('transition-opacity', active ? 'opacity-100' : 'opacity-50')}>{item.icon}</span>
                  <span className="text-[10px] font-medium">{item.label}</span>
                </button>
              );
            })}
            {/* More button */}
            <button
              className={cn(
                'flex-1 flex flex-col items-center justify-center gap-0.5 tap-none transition-colors duration-150',
                isMoreActive ? 'text-accent' : 'text-[#666] active:text-[#999]'
              )}
              onClick={() => setDrawerOpen((o) => !o)}
            >
              <span className={cn('transition-opacity', isMoreActive ? 'opacity-100' : 'opacity-50')}>
                {icon(22, <><circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" /><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none" /></>)}
              </span>
              <span className="text-[10px] font-medium">More</span>
            </button>
          </div>
        </nav>
      </>
    );
  }

  // Desktop/TV: vertical sidebar (unchanged)
  return (
    <nav className="flex w-sidebar h-full flex-col items-center pt-5 shrink-0 z-[100] border-r border-white/[0.06] bg-dark-sidebar [contain:layout_style_paint]" ref={sidebarRef}>
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
