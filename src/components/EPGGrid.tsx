import { useRef, useState, useCallback, useMemo } from 'react';
import type { Program } from '../types';
import { useChannelStore } from '../stores/channelStore';
import { usePlayerStore } from '../stores/playerStore';
import { useAppStore } from '../stores/appStore';
import { KEY_CODES } from '../utils/keys';

const SLOT_WIDTH = 180;
const ROW_HEIGHT = 64;
const VISIBLE_ROWS = 15;
const HOUR_SLOTS = 2;
const TIMELINE_HOURS = 6;
const CHANNEL_COL_WIDTH = 180;

const CATEGORY_COLORS: Record<string, string> = {
  News: '#e74c3c',
  Sports: '#2ecc71',
  Movie: '#9b59b6',
  Series: '#3498db',
  Kids: '#f39c12',
  Music: '#1abc9c',
  Documentary: '#e67e22',
  Entertainment: '#e84393',
  General: '#636e72',
};

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] || CATEGORY_COLORS.General;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * EPGGrid keeps its own 2D focus management because it uses
 * virtual scrolling with absolutely-positioned program cells.
 * Spatial navigation doesn't work well here since off-screen
 * items don't have DOM elements.
 */
export default function EPGGrid() {
  const channels = useChannelStore((s) => s.channels);
  const programs = useChannelStore((s) => s.programs);
  const programsByChannel = useChannelStore((s) => s.programsByChannel);
  const setChannel = usePlayerStore((s) => s.setChannel);
  const navigate = useAppStore((s) => s.navigate);
  const containerRef = useRef<HTMLDivElement>(null);

  const [focusRow, setFocusRow] = useState(0);
  const [focusCol, setFocusCol] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  const now = useMemo(() => new Date(), []);

  const timelineStart = useMemo(() => {
    const d = new Date(now);
    d.setMinutes(0, 0, 0);
    return d;
  }, [now]);

  const timelineEnd = useMemo(() => {
    return new Date(timelineStart.getTime() + TIMELINE_HOURS * 60 * 60 * 1000);
  }, [timelineStart]);

  const timeSlots = useMemo(() => {
    const slots: Date[] = [];
    for (let i = 0; i < TIMELINE_HOURS * HOUR_SLOTS; i++) {
      slots.push(new Date(timelineStart.getTime() + i * 30 * 60 * 1000));
    }
    return slots;
  }, [timelineStart]);

  const getChannelPrograms = useCallback(
    (channelId: string): Program[] => {
      const channelProgs = programsByChannel.get(channelId) || [];
      return channelProgs.filter(
        (p) => p.stop > timelineStart && p.start < timelineEnd
      );
    },
    [programsByChannel, timelineStart, timelineEnd]
  );

  const visibleStart = scrollOffset;
  const visibleEnd = Math.min(scrollOffset + VISIBLE_ROWS, channels.length);
  const visibleChannels = channels.slice(visibleStart, visibleEnd);

  const nowOffset = useMemo(() => {
    const diffMs = now.getTime() - timelineStart.getTime();
    const totalMs = TIMELINE_HOURS * 60 * 60 * 1000;
    return (diffMs / totalMs) * (TIMELINE_HOURS * HOUR_SLOTS * SLOT_WIDTH);
  }, [now, timelineStart]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const channelPrograms = channels[focusRow]
        ? getChannelPrograms(channels[focusRow].id)
        : [];

      switch (e.keyCode) {
        case KEY_CODES.UP:
          if (focusRow > 0) {
            e.preventDefault();
            const newRow = focusRow - 1;
            setFocusRow(newRow);
            setFocusCol(0);
            if (newRow < scrollOffset) setScrollOffset(newRow);
          }
          break;
        case KEY_CODES.DOWN:
          if (focusRow < channels.length - 1) {
            e.preventDefault();
            const newRow = focusRow + 1;
            setFocusRow(newRow);
            setFocusCol(0);
            if (newRow >= scrollOffset + VISIBLE_ROWS) setScrollOffset(newRow - VISIBLE_ROWS + 1);
          }
          break;
        case KEY_CODES.LEFT:
          if (focusCol > 0) {
            e.preventDefault();
            setFocusCol(focusCol - 1);
          }
          // At left edge: let bubble to sidebar
          break;
        case KEY_CODES.RIGHT:
          if (focusCol < channelPrograms.length - 1) {
            e.preventDefault();
            setFocusCol(focusCol + 1);
          }
          break;
        case KEY_CODES.ENTER:
          e.preventDefault();
          if (channels[focusRow]) {
            setChannel(channels[focusRow]);
            navigate('player');
          }
          break;
      }
    },
    [focusRow, focusCol, channels, scrollOffset, getChannelPrograms, setChannel, navigate]
  );

  if (programs.length === 0) {
    return (
      <div className="epg-grid epg-grid--empty">
        <div className="epg-grid__no-data">
          <h2>No EPG Data</h2>
          <p>Load EPG data from Settings to see the TV guide.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="epg-grid" ref={containerRef} tabIndex={0} onKeyDown={handleKeyDown}>
      <div className="epg-grid__header">
        <div className="epg-grid__channel-header" style={{ width: CHANNEL_COL_WIDTH }}>
          Channel
        </div>
        <div className="epg-grid__timeline">
          {timeSlots.map((slot, idx) => (
            <div key={idx} className="epg-grid__time-slot" style={{ width: SLOT_WIDTH }}>
              {formatTime(slot)}
            </div>
          ))}
          {nowOffset > 0 && nowOffset < TIMELINE_HOURS * HOUR_SLOTS * SLOT_WIDTH && (
            <div className="epg-grid__now-indicator" style={{ left: CHANNEL_COL_WIDTH + nowOffset }} />
          )}
        </div>
      </div>
      <div className="epg-grid__body">
        {visibleChannels.map((channel, rowIdx) => {
          const actualRow = visibleStart + rowIdx;
          const channelPrograms = getChannelPrograms(channel.id);
          return (
            <div
              key={channel.id}
              className={`epg-grid__row${actualRow === focusRow ? ' epg-grid__row--focused' : ''}`}
              style={{ height: ROW_HEIGHT }}
            >
              <div className="epg-grid__channel-name" style={{ width: CHANNEL_COL_WIDTH }}>
                {channel.logo && (
                  <img
                    className="epg-grid__channel-logo"
                    src={channel.logo}
                    alt=""
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                )}
                <span>{channel.name}</span>
              </div>
              <div className="epg-grid__programs">
                {channelPrograms.map((prog, colIdx) => {
                  const progStart = Math.max(prog.start.getTime(), timelineStart.getTime());
                  const progEnd = Math.min(prog.stop.getTime(), timelineEnd.getTime());
                  const totalMs = TIMELINE_HOURS * 60 * 60 * 1000;
                  const leftPx = ((progStart - timelineStart.getTime()) / totalMs) * (TIMELINE_HOURS * HOUR_SLOTS * SLOT_WIDTH);
                  const widthPx = ((progEnd - progStart) / totalMs) * (TIMELINE_HOURS * HOUR_SLOTS * SLOT_WIDTH);
                  const isFocused = actualRow === focusRow && colIdx === focusCol;
                  return (
                    <div
                      key={`${prog.channelId}-${prog.start.getTime()}`}
                      className={`epg-grid__program${isFocused ? ' epg-grid__program--focused' : ''}`}
                      data-focusable
                      style={{
                        left: leftPx,
                        width: Math.max(widthPx - 2, 30),
                        height: ROW_HEIGHT - 8,
                        backgroundColor: getCategoryColor(prog.category),
                      }}
                      title={`${prog.title}\n${prog.description}`}
                    >
                      <span className="epg-grid__program-title">{prog.title}</span>
                      <span className="epg-grid__program-time">
                        {formatTime(prog.start)} - {formatTime(prog.stop)}
                      </span>
                    </div>
                  );
                })}
                {channelPrograms.length === 0 && (
                  <div className="epg-grid__no-program">No program info</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
