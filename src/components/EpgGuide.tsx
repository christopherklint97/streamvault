import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Channel, Category } from '../types';
import { useChannelStore, SAME_ORIGIN } from '../stores/channelStore';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import { useRecordingStore } from '../stores/recordingStore';
import { isMobile } from '../utils/platform';
import { cn } from '../utils/cn';

interface EpgProgram {
  channelId: string;
  title: string;
  description: string;
  start: string;
  stop: string;
}

type EpgByChannel = Record<string, EpgProgram[]>;

const MOBILE = isMobile();
const HOUR_WIDTH = MOBILE ? 180 : 240; // pixels per hour
const ROW_HEIGHT = 60;
const CHANNEL_COL_WIDTH = MOBILE ? 110 : 140;
const VISIBLE_HOURS = 3;
const TIMELINE_WIDTH = HOUR_WIDTH * VISIBLE_HOURS;
const PAGE_SIZE = 30;

function getApiBase(): string {
  return SAME_ORIGIN ? '' : useChannelStore.getState().apiBaseUrl;
}

async function fetchChannelEpg(channelId: string, from: number, to: number): Promise<EpgProgram[]> {
  const base = getApiBase();
  const resp = await fetch(`${base}/api/epg/channel/${encodeURIComponent(channelId)}?from=${from}&to=${to}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.programs || [];
}

async function fetchBrowseChannels(group?: string, limit = PAGE_SIZE, afterCursor?: string): Promise<{ channels: Channel[]; total: number; nextCursor: string | null }> {
  const base = getApiBase();
  const params = new URLSearchParams();
  params.set('type', 'livetv');
  if (group && group !== 'All') params.set('group', group);
  params.set('limit', String(limit));
  if (afterCursor) params.set('after', afterCursor);
  const resp = await fetch(`${base}/api/browse?${params}`);
  if (!resp.ok) return { channels: [], total: 0, nextCursor: null };
  const data = await resp.json();
  return { channels: data.channels || [], total: data.total || 0, nextCursor: data.nextCursor || null };
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(d: Date): string {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// ---------- Category Filter Dropdown ----------

function GuideFilterDropdown({ categories, selectedGroup, onSelect }: { categories: Category[]; selectedGroup: string | null; onSelect: (group: string) => void }) {
  const [open, setOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    if (!filterQuery.trim()) return categories;
    const q = filterQuery.toLowerCase();
    return categories.filter(c => c.name.toLowerCase().includes(q));
  }, [categories, filterQuery]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const handleToggle = useCallback(() => {
    setOpen(prev => {
      if (!prev) {
        setFilterQuery('');
      }
      return !prev;
    });
  }, []);

  const handleSelect = useCallback((name: string) => {
    onSelect(name);
    setOpen(false);
  }, [onSelect]);

  const label = selectedGroup && selectedGroup !== 'All' ? selectedGroup : 'All categories';

  return (
    <div className="relative shrink-0" ref={containerRef}>
      <button
        className={cn(
          'flex items-center gap-2 py-2 px-3 lg:py-2.5 lg:px-3.5 bg-surface border-2 border-surface-border rounded-lg text-sm font-semibold text-[#ccc] whitespace-nowrap transition-all duration-150 max-w-[220px] lg:max-w-[320px] tap-none',
          open && 'border-accent text-white'
        )}
        onClick={handleToggle}
      >
        <span className="overflow-hidden text-ellipsis">{label}</span>
        <span className="text-12 text-[#555] shrink-0">{open ? '\u25B2' : '\u25BC'}</span>
      </button>

      {open && (
        <div className="absolute top-[calc(100%+6px)] left-0 min-w-[220px] lg:min-w-[320px] lg:max-w-[460px] bg-surface border-2 border-surface-border rounded-[10px] z-[100] flex flex-col animate-fade-in-fast shadow-[0_12px_40px_rgba(0,0,0,0.6)] max-h-[60dvh]">
          <input
            ref={inputRef}
            className="py-2.5 px-3 text-sm bg-dark-deep border-none border-b border-surface-border rounded-t-[10px] text-[#e8eaed] outline-hidden placeholder:text-[#444]"
            type="text"
            placeholder="Search categories..."
            value={filterQuery}
            onChange={e => setFilterQuery(e.target.value)}
          />
          <div className="max-h-[50dvh] overflow-y-auto p-1 [-webkit-overflow-scrolling:touch]">
            <button
              className={cn(
                'flex items-center gap-2 w-full py-3 px-3.5 bg-transparent border-none rounded-md text-left text-sm text-[#aaa] cursor-pointer transition-colors duration-100 tap-none hover:bg-surface-hover hover:text-white',
                (selectedGroup === 'All' || !selectedGroup) && 'text-accent'
              )}
              onClick={() => handleSelect('All')}
            >
              All categories
            </button>
            {filtered.map(cat => (
              <button
                key={cat.id}
                className={cn(
                  'flex items-center gap-2 w-full py-3 px-3.5 bg-transparent border-none rounded-md text-left text-sm text-[#aaa] cursor-pointer transition-colors duration-100 tap-none hover:bg-surface-hover hover:text-white',
                  selectedGroup === cat.name && 'text-accent'
                )}
                onClick={() => handleSelect(cat.name)}
              >
                <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{cat.name}</span>
                {cat.stream_count > 0 && (
                  <span className="text-13 text-[#555] shrink-0">{cat.stream_count}</span>
                )}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="p-5 text-center text-15 text-[#444]">No matching categories</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- EPG Guide ----------

export default function EpgGuide() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [epgData, setEpgData] = useState<EpgByChannel>({});
  const [loading, setLoading] = useState(true);
  const [timeOffset, setTimeOffset] = useState(0);
  const [selectedProgram, setSelectedProgram] = useState<EpgProgram | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string | null>('All');
  const categories = useChannelStore((s) => s.categories);
  const fetchCategories = useChannelStore((s) => s.fetchCategories);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);
  const showToast = useAppStore((s) => s.showToastMessage);
  const createFromProgram = useRecordingStore((s) => s.createFromProgram);
  const gridRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const fetchIdRef = useRef(0);

  // The base time: current hour rounded down
  const baseTime = useMemo(() => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    return now.getTime();
  }, []);

  const windowStart = baseTime + timeOffset * 60 * 60 * 1000;
  const windowEnd = windowStart + VISIBLE_HOURS * 60 * 60 * 1000;

  // Fetch categories
  useEffect(() => {
    fetchCategories('livetv');
  }, [fetchCategories]);

  // Fetch first page when group changes
  useEffect(() => {
    const id = ++fetchIdRef.current;
    let cancelled = false;
    const group = selectedGroup && selectedGroup !== 'All' ? selectedGroup : undefined;

    fetchBrowseChannels(group, PAGE_SIZE).then(data => {
      if (cancelled || fetchIdRef.current !== id) return;
      setChannels(data.channels);
      setNextCursor(data.nextCursor);
      setLoading(false);
    }).catch((err) => {
      if (cancelled || fetchIdRef.current !== id) return;
      showToast(`Failed to load channels: ${err}`);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [selectedGroup, showToast]);

  // Load the next page (triggered by scroll proximity)
  const loadNextPage = useCallback(async () => {
    if (loadingMore || !nextCursor) return;
    const id = fetchIdRef.current;
    const group = selectedGroup && selectedGroup !== 'All' ? selectedGroup : undefined;
    setLoadingMore(true);
    try {
      const data = await fetchBrowseChannels(group, PAGE_SIZE, nextCursor);
      if (fetchIdRef.current !== id) return;
      setChannels(prev => [...prev, ...data.channels]);
      setNextCursor(data.nextCursor);
    } catch (err) {
      showToast(`Failed to load more: ${err}`);
    } finally {
      if (fetchIdRef.current === id) setLoadingMore(false);
    }
  }, [loadingMore, nextCursor, selectedGroup, showToast]);

  // Infinite scroll: observe a sentinel near the bottom of the grid
  useEffect(() => {
    if (!nextCursor) return;
    const el = sentinelRef.current;
    const root = gridRef.current;
    if (!el || !root) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) loadNextPage();
      },
      { root, rootMargin: '600px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [nextCursor, loadNextPage]);

  // Fetch EPG when channels or time window changes
  useEffect(() => {
    if (channels.length === 0) return;
    let cancelled = false;
    const promises = channels.map(ch =>
      fetchChannelEpg(ch.id, windowStart, windowEnd).then(programs => ({
        channelId: ch.id,
        programs,
      }))
    );
    Promise.all(promises).then(results => {
      if (cancelled) return;
      const map: EpgByChannel = {};
      for (const r of results) {
        map[r.channelId] = r.programs;
      }
      setEpgData(map);
    });
    return () => { cancelled = true; };
  }, [channels, windowStart, windowEnd]);

  const handleTimeShift = useCallback((delta: number) => {
    setTimeOffset(prev => prev + delta);
    setSelectedProgram(null);
  }, []);

  const handleChannelClick = useCallback((channel: Channel) => {
    setChannel(channel);
    navigate('player');
  }, [setChannel, navigate]);

  const handleRecord = useCallback(async (channelId: string, program: EpgProgram) => {
    const start = new Date(program.start).getTime();
    const stop = new Date(program.stop).getTime();
    const rec = await createFromProgram(channelId, start, stop, program.title);
    if (rec) {
      showToast(`Recording scheduled: ${program.title}`);
    } else {
      showToast('Failed to schedule recording');
    }
  }, [createFromProgram, showToast]);

  const handleGroupSelect = useCallback((groupName: string) => {
    setSelectedGroup(groupName);
    setLoading(true);
    setEpgData({});
    setSelectedProgram(null);
  }, []);

  const [now, setNow] = useState(() => Date.now());
  // Update "now" every 60 seconds for the now-line
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const nowOffset = ((now - windowStart) / (60 * 60 * 1000)) * HOUR_WIDTH;
  const showNowLine = now >= windowStart && now <= windowEnd;

  // Generate timeline hour markers
  const hourMarkers = useMemo(() => {
    const markers = [];
    for (let h = 0; h < VISIBLE_HOURS; h++) {
      const time = new Date(windowStart + h * 60 * 60 * 1000);
      markers.push({ time, offset: h * HOUR_WIDTH });
    }
    return markers;
  }, [windowStart]);

  // Check if any channel has EPG data
  const hasAnyEpg = useMemo(() => {
    return Object.values(epgData).some(programs => programs.length > 0);
  }, [epgData]);

  if (loading) {
    return <div className="p-3 lg:p-5 h-full flex flex-col overflow-hidden"><div className="text-[#888] text-center py-[60px]">Loading guide...</div></div>;
  }

  return (
    <div className="p-3 lg:p-5 h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2.5 lg:gap-5 mb-4 shrink-0 flex-wrap lg:flex-nowrap">
        <h1 className="text-20 lg:text-28 font-bold">TV Guide</h1>
        <GuideFilterDropdown
          categories={categories}
          selectedGroup={selectedGroup}
          onSelect={handleGroupSelect}
        />
        <div className="flex gap-1 lg:gap-1.5">
          <button className="py-2 px-3 lg:py-1.5 lg:px-3.5 rounded-md bg-white/[0.06] text-13 lg:text-sm text-[#aaa] transition-colors duration-150 tap-none hover:bg-white/[0.12] focus:bg-white/[0.12]" onClick={() => handleTimeShift(-3)}>-3h</button>
          <button className="py-2 px-3 lg:py-1.5 lg:px-3.5 rounded-md bg-white/[0.06] text-13 lg:text-sm text-[#aaa] transition-colors duration-150 tap-none hover:bg-white/[0.12] focus:bg-white/[0.12]" onClick={() => handleTimeShift(-1)}>-1h</button>
          <button className="py-2 px-3 lg:py-1.5 lg:px-3.5 rounded-md bg-epg-purple/20 text-epg-purple-light transition-colors duration-150 tap-none text-13 lg:text-sm hover:bg-epg-purple/[0.35] focus:bg-epg-purple/[0.35]" onClick={() => { setTimeOffset(0); setSelectedProgram(null); }}>Now</button>
          <button className="py-2 px-3 lg:py-1.5 lg:px-3.5 rounded-md bg-white/[0.06] text-13 lg:text-sm text-[#aaa] transition-colors duration-150 tap-none hover:bg-white/[0.12] focus:bg-white/[0.12]" onClick={() => handleTimeShift(1)}>+1h</button>
          <button className="py-2 px-3 lg:py-1.5 lg:px-3.5 rounded-md bg-white/[0.06] text-13 lg:text-sm text-[#aaa] transition-colors duration-150 tap-none hover:bg-white/[0.12] focus:bg-white/[0.12]" onClick={() => handleTimeShift(3)}>+3h</button>
        </div>
        <div className="text-sm text-[#666] ml-auto">{formatDate(new Date(windowStart))}</div>
      </div>

      {channels.length === 0 ? (
        <div className="text-center py-[60px] text-[#444]">
          {selectedGroup && selectedGroup !== 'All' ? 'No channels in this category.' : 'Select a category to browse.'}
        </div>
      ) : (
        <>
          {!hasAnyEpg && !loading && (
            <div className="text-13 text-[#555] mb-2 px-1">No program guide data available. Click a channel name to play.</div>
          )}
          <div className="flex-1 overflow-auto relative [-webkit-overflow-scrolling:touch]" ref={gridRef}>
            {/* Timeline header */}
            <div className="flex sticky top-0 z-[2] bg-dark h-8" style={{ marginLeft: CHANNEL_COL_WIDTH }}>
              {hourMarkers.map((m, i) => (
                <div key={i} className="absolute top-0 h-8 flex items-center pl-2 text-13 text-[#666] border-l border-white/[0.06]" style={{ left: m.offset, width: HOUR_WIDTH }}>
                  {formatTime(m.time)}
                </div>
              ))}
            </div>

            {/* Channel rows */}
            <div className="relative">
              {channels.map(ch => {
                const programs = epgData[ch.id] || [];
                return (
                  <div key={ch.id} className="flex border-b border-white/[0.04]" style={{ height: ROW_HEIGHT }}>
                    <button
                      className="shrink-0 flex items-center px-2 lg:px-2.5 text-12 lg:text-13 font-medium text-[#ccc] bg-[#0d0d16] overflow-hidden text-ellipsis whitespace-nowrap text-left sticky left-0 z-[1] hover:bg-[#151520]"
                      style={{ width: CHANNEL_COL_WIDTH }}
                      onClick={() => handleChannelClick(ch)}
                    >
                      {ch.name}
                    </button>
                    <div className="relative shrink-0" style={{ width: TIMELINE_WIDTH }}>
                      {programs.length === 0 && (
                        <div className="absolute inset-0 flex items-center px-3 text-12 text-[#333]">No guide data</div>
                      )}
                      {programs.map((p, i) => {
                        const start = new Date(p.start).getTime();
                        const stop = new Date(p.stop).getTime();
                        const clampStart = Math.max(start, windowStart);
                        const clampStop = Math.min(stop, windowEnd);
                        const left = ((clampStart - windowStart) / (60 * 60 * 1000)) * HOUR_WIDTH;
                        const width = ((clampStop - clampStart) / (60 * 60 * 1000)) * HOUR_WIDTH;
                        if (width <= 0) return null;
                        const isLive = start <= now && stop > now;
                        const isPast = stop <= now;
                        const isSelected = selectedProgram === p;
                        return (
                          <button
                            key={i}
                            className={cn(
                              'absolute top-1 bottom-1 rounded px-2 flex items-center overflow-hidden cursor-pointer transition-colors duration-150',
                              isLive ? 'bg-epg-purple/[0.15] border-l-[3px] border-epg-purple hover:bg-epg-purple/25' : 'bg-white/[0.06] hover:bg-white/[0.12]',
                              isPast && 'opacity-50',
                              isSelected && 'epg-program-selected'
                            )}
                            style={{ left, width: Math.max(width - 2, 1) }}
                            onClick={() => setSelectedProgram(isSelected ? null : p)}
                            title={`${p.title}\n${formatTime(new Date(p.start))} - ${formatTime(new Date(p.stop))}`}
                          >
                            <span className="text-11 lg:text-12 text-[#ddd] whitespace-nowrap overflow-hidden text-ellipsis">{p.title}</span>
                          </button>
                        );
                      })}
                      {/* Now line */}
                      {showNowLine && (
                        <div className="absolute top-0 bottom-0 w-0.5 bg-brand-red z-[1] pointer-events-none" style={{ left: nowOffset }} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {nextCursor && (
              <div ref={sentinelRef} className="py-4 text-center text-13 text-[#555]">
                {loadingMore ? 'Loading more...' : ''}
              </div>
            )}
          </div>
        </>
      )}

      {/* Program detail panel */}
      {selectedProgram && (
        <div className="shrink-0 p-3.5 lg:p-4 mt-2 bg-white/[0.04] rounded-lg max-h-[100px] lg:max-h-[120px] overflow-y-auto">
          <div className="text-base font-semibold mb-1">{selectedProgram.title}</div>
          <div className="text-13 text-[#888] mb-1.5">
            {formatTime(new Date(selectedProgram.start))} – {formatTime(new Date(selectedProgram.stop))}
          </div>
          {selectedProgram.description && (
            <div className="text-13 text-[#aaa] leading-snug">{selectedProgram.description}</div>
          )}
          {new Date(selectedProgram.stop).getTime() > now && (
            <button
              className="inline-block mt-2 py-1.5 px-[18px] bg-[#dc2626] text-white rounded-md text-sm font-semibold cursor-pointer transition-colors duration-150 hover:bg-[#b91c1c] focus:bg-[#b91c1c]"
              onClick={() => handleRecord(selectedProgram.channelId, selectedProgram)}
            >
              Record
            </button>
          )}
        </div>
      )}
    </div>
  );
}
