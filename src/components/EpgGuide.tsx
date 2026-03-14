import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Channel } from '../types';
import { useChannelStore, SAME_ORIGIN } from '../stores/channelStore';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';

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
    return <div className="epg-guide"><div className="epg-guide__loading">Loading guide...</div></div>;
  }

  return (
    <div className="epg-guide">
      <div className="epg-guide__header">
        <h1 className="epg-guide__title">TV Guide</h1>
        <div className="epg-guide__nav">
          <button className="epg-guide__nav-btn" onClick={() => handleTimeShift(-3)}>-3h</button>
          <button className="epg-guide__nav-btn" onClick={() => handleTimeShift(-1)}>-1h</button>
          <button className="epg-guide__nav-btn epg-guide__nav-btn--now" onClick={() => { setTimeOffset(0); setSelectedProgram(null); }}>Now</button>
          <button className="epg-guide__nav-btn" onClick={() => handleTimeShift(1)}>+1h</button>
          <button className="epg-guide__nav-btn" onClick={() => handleTimeShift(3)}>+3h</button>
        </div>
        <div className="epg-guide__date">{formatDate(new Date(windowStart))}</div>
      </div>

      <div className="epg-guide__grid-wrapper" ref={gridRef}>
        {/* Timeline header */}
        <div className="epg-guide__timeline" style={{ marginLeft: CHANNEL_COL_WIDTH }}>
          {hourMarkers.map((m, i) => (
            <div key={i} className="epg-guide__hour" style={{ left: m.offset, width: HOUR_WIDTH }}>
              {formatTime(m.time)}
            </div>
          ))}
        </div>

        {/* Channel rows */}
        <div className="epg-guide__rows">
          {channels.map(ch => {
            const programs = epgData[ch.id] || [];
            return (
              <div key={ch.id} className="epg-guide__row" style={{ height: ROW_HEIGHT }}>
                <button
                  className="epg-guide__channel-name"
                  style={{ width: CHANNEL_COL_WIDTH }}
                  onClick={() => handleChannelClick(ch)}
                >
                  {ch.name}
                </button>
                <div className="epg-guide__programs" style={{ width: TIMELINE_WIDTH }}>
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
                        className={`epg-guide__program${isLive ? ' epg-guide__program--live' : ''}${isPast ? ' epg-guide__program--past' : ''}${isSelected ? ' epg-guide__program--selected' : ''}`}
                        style={{ left, width: Math.max(width - 2, 1) }}
                        onClick={() => setSelectedProgram(isSelected ? null : p)}
                        title={`${p.title}\n${formatTime(new Date(p.start))} - ${formatTime(new Date(p.stop))}`}
                      >
                        <span className="epg-guide__program-title">{p.title}</span>
                      </button>
                    );
                  })}
                  {/* Now line */}
                  {showNowLine && (
                    <div className="epg-guide__now-line" style={{ left: nowOffset }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Program detail panel */}
      {selectedProgram && (
        <div className="epg-guide__detail">
          <div className="epg-guide__detail-title">{selectedProgram.title}</div>
          <div className="epg-guide__detail-time">
            {formatTime(new Date(selectedProgram.start))} – {formatTime(new Date(selectedProgram.stop))}
          </div>
          {selectedProgram.description && (
            <div className="epg-guide__detail-desc">{selectedProgram.description}</div>
          )}
        </div>
      )}
    </div>
  );
}
