import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Channel } from '../types';
import { useChannelStore, SAME_ORIGIN } from '../stores/channelStore';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import { useRecordingStore } from '../stores/recordingStore';
import { cn } from '../utils/cn';

interface EpgProgram {
  channelId: string;
  title: string;
  description: string;
  start: string;
  stop: string;
}

type EpgByChannel = Record<string, EpgProgram[]>;

const HOUR_WIDTH = 240; // pixels per hour
const ROW_HEIGHT = 60;
const CHANNEL_COL_WIDTH = 140;
const VISIBLE_HOURS = 3;
const TIMELINE_WIDTH = HOUR_WIDTH * VISIBLE_HOURS;

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

async function fetchBrowseChannels(group?: string, limit = 30): Promise<{ channels: Channel[]; total: number }> {
  const base = getApiBase();
  const params = new URLSearchParams();
  params.set('type', 'livetv');
  if (group && group !== 'All') params.set('group', group);
  params.set('limit', String(limit));
  const resp = await fetch(`${base}/api/browse?${params}`);
  if (!resp.ok) return { channels: [], total: 0 };
  const data = await resp.json();
  return { channels: data.channels || [], total: data.total || 0 };
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(d: Date): string {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function EpgGuide() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [epgData, setEpgData] = useState<EpgByChannel>({});
  const [loading, setLoading] = useState(true); // starts true, set false in fetch callback
  const [timeOffset, setTimeOffset] = useState(0); // offset in hours from "now rounded to current hour"
  const [selectedProgram, setSelectedProgram] = useState<EpgProgram | null>(null);
  const fetchCategories = useChannelStore((s) => s.fetchCategories);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);
  const showToast = useAppStore((s) => s.showToastMessage);
  const createFromProgram = useRecordingStore((s) => s.createFromProgram);
  const gridRef = useRef<HTMLDivElement>(null);

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

  // Fetch channels
  useEffect(() => {
    fetchBrowseChannels(undefined, 30).then(data => {
      setChannels(data.channels);
      setLoading(false);
    });
  }, []);

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

  if (loading) {
    return <div className="p-3 lg:p-5 h-full flex flex-col overflow-hidden"><div className="text-[#888] text-center py-[60px]">Loading guide...</div></div>;
  }

  return (
    <div className="p-3 lg:p-5 h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2.5 lg:gap-5 mb-4 shrink-0 flex-wrap lg:flex-nowrap">
        <h1 className="text-20 lg:text-28 font-bold">TV Guide</h1>
        <div className="flex gap-1 lg:gap-1.5">
          <button className="py-2 px-3 lg:py-1.5 lg:px-3.5 rounded-md bg-white/[0.06] text-13 lg:text-sm text-[#aaa] transition-colors duration-150 tap-none hover:bg-white/[0.12] focus:bg-white/[0.12]" onClick={() => handleTimeShift(-3)}>-3h</button>
          <button className="py-2 px-3 lg:py-1.5 lg:px-3.5 rounded-md bg-white/[0.06] text-13 lg:text-sm text-[#aaa] transition-colors duration-150 tap-none hover:bg-white/[0.12] focus:bg-white/[0.12]" onClick={() => handleTimeShift(-1)}>-1h</button>
          <button className="py-2 px-3 lg:py-1.5 lg:px-3.5 rounded-md bg-epg-purple/20 text-epg-purple-light transition-colors duration-150 tap-none text-13 lg:text-sm hover:bg-epg-purple/[0.35] focus:bg-epg-purple/[0.35]" onClick={() => { setTimeOffset(0); setSelectedProgram(null); }}>Now</button>
          <button className="py-2 px-3 lg:py-1.5 lg:px-3.5 rounded-md bg-white/[0.06] text-13 lg:text-sm text-[#aaa] transition-colors duration-150 tap-none hover:bg-white/[0.12] focus:bg-white/[0.12]" onClick={() => handleTimeShift(1)}>+1h</button>
          <button className="py-2 px-3 lg:py-1.5 lg:px-3.5 rounded-md bg-white/[0.06] text-13 lg:text-sm text-[#aaa] transition-colors duration-150 tap-none hover:bg-white/[0.12] focus:bg-white/[0.12]" onClick={() => handleTimeShift(3)}>+3h</button>
        </div>
        <div className="text-sm text-[#666] ml-auto">{formatDate(new Date(windowStart))}</div>
      </div>

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
      </div>

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
              ⏺ Record
            </button>
          )}
        </div>
      )}
    </div>
  );
}
