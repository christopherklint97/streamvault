import { useState, useEffect, useCallback, useRef } from 'react';
import { usePlayer } from '../hooks/usePlayer';
import { usePlayerStore } from '../stores/playerStore';
import { useChannelStore } from '../stores/channelStore';
import { getCurrentProgram } from '../services/epg-service';
import { KEY_CODES } from '../utils/keys';

const OSD_TIMEOUT = 5000;

export default function Player() {
  const { play, stop, retry, playerState, subtitleTracks, currentSubtitleIndex, subtitleText, cycleSubtitles } = usePlayer();
  const currentChannel = usePlayerStore((s) => s.currentChannel);
  const programs = useChannelStore((s) => s.programs);
  const [showOSD, setShowOSD] = useState(true);
  const osdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentProgram = currentChannel
    ? getCurrentProgram(programs, currentChannel.id)
    : null;

  // Track progress with a timer
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!currentProgram) {
      setProgress(0);
      return;
    }
    const update = () => {
      const now = Date.now();
      const start = currentProgram.start.getTime();
      const end = currentProgram.stop.getTime();
      const total = end - start;
      if (total <= 0) { setProgress(0); return; }
      setProgress(Math.min(100, Math.max(0, ((now - start) / total) * 100)));
    };
    update();
    const interval = setInterval(update, 30000);
    return () => clearInterval(interval);
  }, [currentProgram]);

  const resetOSDTimer = useCallback(() => {
    setShowOSD(true);
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    osdTimerRef.current = setTimeout(() => setShowOSD(false), OSD_TIMEOUT);
  }, []);

  // Start playback when channel changes
  useEffect(() => {
    if (currentChannel) {
      play();
    }
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChannel?.id]);

  // Show OSD initially, auto-hide
  useEffect(() => {
    resetOSDTimer();
    return () => {
      if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    };
  }, [resetOSDTimer]);

  // Show OSD on any key press
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      resetOSDTimer();

      switch (e.keyCode) {
        case KEY_CODES.ENTER:
        case KEY_CODES.PLAY:
          e.preventDefault();
          if (playerState.status === 'error') {
            retry();
          }
          break;
        case KEY_CODES.STOP:
          e.preventDefault();
          stop();
          break;
        case KEY_CODES.GREEN:
          e.preventDefault();
          cycleSubtitles();
          break;
      }
    },
    [resetOSDTimer, playerState.status, retry, stop, cycleSubtitles]
  );

  return (
    <div className="player" tabIndex={0} onKeyDown={handleKeyDown}>
      {/* Video container */}
      <div className="player__video-container">
        {typeof webapis !== 'undefined' && webapis.avplay ? (
          <div id="av-player" className="player__av-object" />
        ) : (
          <video id="av-player" className="player__video" autoPlay playsInline />
        )}
      </div>

      {/* Loading spinner */}
      {playerState.status === 'loading' && (
        <div className="player__loading">
          <div className="player__spinner" />
          <span>Loading...</span>
        </div>
      )}

      {/* Error display */}
      {playerState.status === 'error' && (
        <div className="player__error">
          <div className="player__error-icon">{'\u26A0'}</div>
          <h2>Playback Error</h2>
          <p>{playerState.errorMessage}</p>
          <p className="player__error-hint">Press ENTER to retry</p>
        </div>
      )}

      {/* Subtitle text overlay */}
      {subtitleText && (
        <div className="player__subtitles">
          <span className="player__subtitle-text">{subtitleText}</span>
        </div>
      )}

      {/* OSD bar - always rendered, fades in/out */}
      {currentChannel && playerState.status !== 'error' && (
        <div className={`player__osd${showOSD ? ' player__osd--visible' : ''}`}>
          <div className="player__osd-info">
            <span className="player__osd-channel-name">{currentChannel.name}</span>
            {currentProgram && (
              <span className="player__osd-program">{currentProgram.title}</span>
            )}
            <span className="player__osd-subtitle-indicator">
              {currentSubtitleIndex === -1 ? 'Subs: Off' : `Subs: ${subtitleTracks[currentSubtitleIndex]?.label || 'On'}`}
            </span>
          </div>
          {currentProgram && (
            <div className="player__osd-progress">
              <div className="player__osd-progress-bar">
                <div
                  className="player__osd-progress-fill"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="player__osd-time">
                {currentProgram.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {' - '}
                {currentProgram.stop.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
