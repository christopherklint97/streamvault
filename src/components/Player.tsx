import { useState, useEffect, useCallback, useRef } from 'react';
import { usePlayer, getStreamUrl } from '../hooks/usePlayer';
import { usePlayerStore } from '../stores/playerStore';
import { useChannelStore } from '../stores/channelStore';
import { useAppStore } from '../stores/appStore';
import { useRecordingStore } from '../stores/recordingStore';
import { getCurrentProgram } from '../services/epg-service';
import { KEY_CODES } from '../utils/keys';
import { isMobile, openInNativePlayer } from '../utils/platform';

const OSD_TIMEOUT = 5000;
const MOBILE = isMobile();
/** Pixels of horizontal movement before a swipe is recognized */
const SWIPE_THRESHOLD = 15;
/** How many seconds per pixel of horizontal swipe */
const SECONDS_PER_PIXEL = 0.5;
/** Max ms between taps to count as double-tap */
const DOUBLE_TAP_MS = 300;

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Check if a touch event target is inside a clickable OSD element */
function isOsdControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest('button, input, .player__btn-row, .player__seek-row, .player__live-row');
}

export default function Player() {
  const { play, stop, retry, togglePlay, seek, getVideoElement, playerState, subtitleTracks, currentSubtitleIndex, subtitleText, cycleSubtitles } = usePlayer();
  const currentChannel = usePlayerStore((s) => s.currentChannel);
  const channelId = currentChannel?.id;
  const programs = useChannelStore((s) => s.programs);
  const goBack = useAppStore((s) => s.goBack);
  const showToast = useAppStore((s) => s.showToastMessage);
  const createRecording = useRecordingStore((s) => s.createRecording);
  const [isRecording, setIsRecording] = useState(false);
  const [showOSD, setShowOSD] = useState(true);
  const osdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);
  const seekBarRef = useRef<HTMLInputElement | null>(null);
  const timeUpdateRef = useRef<number>(0);

  // Swipe-to-scrub state
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const [swipeSeeking, setSwipeSeeking] = useState(false);
  const [swipePreview, setSwipePreview] = useState(0);
  const swipeActiveRef = useRef(false);

  // Double-tap state
  const lastTapRef = useRef<{ time: number; x: number }>({ time: 0, x: 0 });
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [doubleTapSide, setDoubleTapSide] = useState<'left' | 'right' | null>(null);
  const doubleTapFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isLive = currentChannel?.contentType === 'livetv';
  const hasDuration = isFinite(duration) && duration > 0;

  const currentProgram = currentChannel
    ? getCurrentProgram(programs, currentChannel.id)
    : null;

  // Track video time for seek bar
  useEffect(() => {
    const video = getVideoElement();
    if (!video) return;

    const onTimeUpdate = () => {
      if (!isSeeking) {
        setCurrentTime(video.currentTime);
        setDuration(video.duration || 0);
      }
    };
    const onPlay = () => setIsPaused(false);
    const onPause = () => setIsPaused(true);
    const onDurationChange = () => setDuration(video.duration || 0);

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('durationchange', onDurationChange);

    // Poll as fallback for mpegts.js streams (timeupdate may not fire)
    timeUpdateRef.current = window.setInterval(() => {
      if (!isSeeking && video.currentTime > 0) {
        setCurrentTime(video.currentTime);
        if (video.duration) setDuration(video.duration);
      }
    }, 500);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('durationchange', onDurationChange);
      clearInterval(timeUpdateRef.current);
    };
  }, [getVideoElement, isSeeking, playerState.status]);

  // EPG progress for live (only used when currentProgram is rendered)
  const [liveProgress, setLiveProgress] = useState(0);
  const programStartMs = currentProgram?.start.getTime() ?? 0;
  const programStopMs = currentProgram?.stop.getTime() ?? 0;
  useEffect(() => {
    if (!programStartMs || !programStopMs) return;
    const total = programStopMs - programStartMs;
    if (total <= 0) return;
    const update = () => {
      const pct = Math.min(100, Math.max(0, ((Date.now() - programStartMs) / total) * 100));
      setLiveProgress(pct);
    };
    update();
    const interval = setInterval(update, 30000);
    return () => clearInterval(interval);
  }, [programStartMs, programStopMs]);

  const resetOSDTimer = useCallback(() => {
    setShowOSD(true);
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    osdTimerRef.current = setTimeout(() => setShowOSD(false), OSD_TIMEOUT);
  }, []);

  // Start playback when channel changes
  useEffect(() => {
    if (channelId) {
      play();
    }
    return () => {
      stop();
    };
  }, [channelId, play, stop]);

  // Show OSD initially, auto-hide after timeout
  useEffect(() => {
    osdTimerRef.current = setTimeout(() => setShowOSD(false), OSD_TIMEOUT);
    return () => {
      if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    };
  }, []);

  // Auto-PIP when leaving the app
  // Chrome: use autoPictureInPicture attribute (requestPictureInPicture blocked without gesture)
  // Safari: use visibilitychange + requestPictureInPicture (Safari allows it without gesture)
  useEffect(() => {
    if (!MOBILE || !document.pictureInPictureEnabled) return;
    const video = getVideoElement();
    if (!video) return;

    // Chrome/Android: native auto-PiP attribute
    if ('autoPictureInPicture' in video) {
      (video as HTMLVideoElement & { autoPictureInPicture: boolean }).autoPictureInPicture = true;
      return () => {
        if (video && 'autoPictureInPicture' in video) {
          (video as HTMLVideoElement & { autoPictureInPicture: boolean }).autoPictureInPicture = false;
        }
      };
    }

    // Safari fallback: requestPictureInPicture from visibilitychange works
    const handleVisibilityChange = () => {
      if (document.hidden && playerState.status === 'playing' && !document.pictureInPictureElement) {
        video.requestPictureInPicture().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [getVideoElement, playerState.status]);

  const handleBack = useCallback(() => {
    // Exit PIP if active
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    }
    stop();
    goBack();
  }, [stop, goBack]);

  const handleTogglePlay = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    togglePlay();
    resetOSDTimer();
  }, [togglePlay, resetOSDTimer]);

  const handleSeekStart = useCallback(() => {
    setIsSeeking(true);
  }, []);

  const handleSeekChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSeekValue(parseFloat(e.target.value));
  }, []);

  const handleSeekEnd = useCallback(() => {
    seek(seekValue);
    setIsSeeking(false);
    resetOSDTimer();
  }, [seek, seekValue, resetOSDTimer]);

  const handleSkip = useCallback((delta: number) => {
    const video = getVideoElement();
    if (video) {
      seek(Math.max(0, Math.min(video.duration || 0, video.currentTime + delta)));
      resetOSDTimer();
    }
  }, [getVideoElement, seek, resetOSDTimer]);

  const handlePiP = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = getVideoElement();
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch { /* PiP not supported */ }
  }, [getVideoElement]);

  const handleNativePlayer = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentChannel) return;
    const streamUrl = getStreamUrl(currentChannel.id, currentChannel.url);
    // Make URL absolute for native player
    const absoluteUrl = streamUrl.startsWith('http')
      ? streamUrl
      : `${window.location.origin}${streamUrl}`;
    // Stop the web player first so it doesn't hold the stream
    stop();
    openInNativePlayer(absoluteUrl);
  }, [currentChannel, stop]);

  const handleRecord = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentChannel || isRecording) return;
    const now = Date.now();
    // If we have a current program, record until it ends; otherwise record for 2 hours
    const endTime = currentProgram
      ? currentProgram.stop.getTime()
      : now + 2 * 60 * 60 * 1000;
    const title = currentProgram?.title || currentChannel.name;
    const rec = await createRecording(currentChannel.id, title, now, endTime);
    if (rec) {
      setIsRecording(true);
      showToast(`Recording: ${title}`);
    } else {
      showToast('Failed to start recording');
    }
    resetOSDTimer();
  }, [currentChannel, currentProgram, isRecording, createRecording, showToast, resetOSDTimer]);

  // Touch: tap to toggle OSD (single tap only, after ruling out swipe/double-tap)
  const handleSingleTap = useCallback(() => {
    if (showOSD) {
      setShowOSD(false);
      if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    } else {
      resetOSDTimer();
    }
  }, [showOSD, resetOSDTimer]);

  // Double-tap to skip 10s
  const handleDoubleTap = useCallback((side: 'left' | 'right') => {
    const delta = side === 'right' ? 10 : -10;
    handleSkip(delta);
    resetOSDTimer();
    setDoubleTapSide(side);
    if (doubleTapFadeRef.current) clearTimeout(doubleTapFadeRef.current);
    doubleTapFadeRef.current = setTimeout(() => setDoubleTapSide(null), 600);
  }, [handleSkip, resetOSDTimer]);

  // Touch gesture handlers — skip if target is an OSD button/control
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (isOsdControl(e.target)) return;
    if (isLive || !hasDuration) return;
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: currentTime };
    swipeActiveRef.current = false;
  }, [isLive, hasDuration, currentTime]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current || isLive || !hasDuration) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;

    // Ignore vertical swipes
    if (!swipeActiveRef.current && Math.abs(dy) > Math.abs(dx)) {
      touchStartRef.current = null;
      return;
    }

    if (Math.abs(dx) > SWIPE_THRESHOLD) {
      swipeActiveRef.current = true;
      if (!swipeSeeking) setSwipeSeeking(true);
      const timeDelta = dx * SECONDS_PER_PIXEL;
      const newTime = Math.max(0, Math.min(duration, touchStartRef.current.time + timeDelta));
      setSwipePreview(newTime);
      resetOSDTimer();
    }
  }, [isLive, hasDuration, duration, swipeSeeking, resetOSDTimer]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    // Skip if touch was on an OSD control (let click handler handle it)
    if (isOsdControl(e.target)) return;

    if (swipeActiveRef.current && swipeSeeking) {
      // Commit the scrub
      seek(swipePreview);
      setSwipeSeeking(false);
      swipeActiveRef.current = false;
      touchStartRef.current = null;
      return;
    }

    // Not a swipe — check for tap / double-tap
    touchStartRef.current = null;
    swipeActiveRef.current = false;
    if (swipeSeeking) { setSwipeSeeking(false); return; }

    const now = Date.now();
    const tapX = e.changedTouches[0]?.clientX ?? 0;
    const lastTap = lastTapRef.current;

    if (now - lastTap.time < DOUBLE_TAP_MS && Math.abs(tapX - lastTap.x) < 100) {
      // Double-tap detected
      if (tapTimerRef.current) { clearTimeout(tapTimerRef.current); tapTimerRef.current = null; }
      const screenMid = window.innerWidth / 2;
      handleDoubleTap(tapX > screenMid ? 'right' : 'left');
      lastTapRef.current = { time: 0, x: 0 };
    } else {
      // Potential single tap — wait to see if another tap comes
      lastTapRef.current = { time: now, x: tapX };
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
      tapTimerRef.current = setTimeout(() => {
        handleSingleTap();
        tapTimerRef.current = null;
      }, DOUBLE_TAP_MS);
    }
  }, [swipeSeeking, swipePreview, seek, handleDoubleTap, handleSingleTap]);

  // TV remote keys
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      resetOSDTimer();
      switch (e.keyCode) {
        case KEY_CODES.ENTER:
        case KEY_CODES.PLAY:
          e.preventDefault();
          if (playerState.status === 'error') retry();
          else togglePlay();
          break;
        case KEY_CODES.PAUSE:
          e.preventDefault();
          togglePlay();
          break;
        case KEY_CODES.STOP:
          e.preventDefault();
          stop();
          break;
        case KEY_CODES.FF:
          e.preventDefault();
          handleSkip(10);
          break;
        case KEY_CODES.REW:
          e.preventDefault();
          handleSkip(-10);
          break;
        case KEY_CODES.GREEN:
          e.preventDefault();
          cycleSubtitles();
          break;
      }
    },
    [resetOSDTimer, playerState.status, retry, stop, togglePlay, handleSkip, cycleSubtitles]
  );

  const seekDisplay = isSeeking ? seekValue : currentTime;
  const pipSupported = typeof document !== 'undefined' && document.pictureInPictureEnabled === true;

  return (
    <div
      className="player"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onTouchStart={MOBILE ? handleTouchStart : undefined}
      onTouchMove={MOBILE ? handleTouchMove : undefined}
      onTouchEnd={MOBILE ? handleTouchEnd : undefined}
    >
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
          {MOBILE ? (
            <button className="player__error-btn" onClick={retry}>Retry</button>
          ) : (
            <p className="player__error-hint">Press ENTER to retry</p>
          )}
        </div>
      )}

      {/* Subtitle text overlay */}
      {subtitleText && (
        <div className="player__subtitles">
          <span className="player__subtitle-text">{subtitleText}</span>
        </div>
      )}

      {/* Swipe-to-scrub preview */}
      {MOBILE && swipeSeeking && (
        <div className="player__scrub-preview">
          <span className="player__scrub-time">{formatTime(swipePreview)}</span>
          <span className="player__scrub-delta">
            {swipePreview >= currentTime ? '+' : ''}{formatTime(Math.abs(swipePreview - currentTime))}
          </span>
        </div>
      )}

      {/* Double-tap skip indicator */}
      {MOBILE && doubleTapSide && (
        <div className={`player__double-tap player__double-tap--${doubleTapSide}`}>
          <span className="player__double-tap-text">10s</span>
        </div>
      )}

      {/* Controls OSD */}
      {currentChannel && playerState.status !== 'error' && (
        <div className={`player__osd${showOSD ? ' player__osd--visible' : ''}`}>
          {/* Top bar: back + title */}
          <div className="player__osd-top">
            {MOBILE && (
              <button className="player__back-btn" onClick={(e) => { e.stopPropagation(); handleBack(); }}>
                {'\u2190'}
              </button>
            )}
            <div className="player__osd-info">
              <span className="player__osd-channel-name">{currentChannel.name}</span>
              {currentProgram && (
                <span className="player__osd-program">{currentProgram.title}</span>
              )}
            </div>
            {MOBILE && isLive && (
              <button
                className={`player__record-btn${isRecording ? ' player__record-btn--active' : ''}`}
                onClick={handleRecord}
                title={isRecording ? 'Recording...' : 'Record'}
              >
                ⏺
              </button>
            )}
            {MOBILE && (
              <button className="player__native-btn" onClick={handleNativePlayer} title="Open in native player">
                {/* External player icon */}
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </button>
            )}
            {MOBILE && pipSupported && (
              <button className="player__pip-btn" onClick={handlePiP} title="Picture-in-Picture">
                {/* PiP icon */}
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="3" width="20" height="14" rx="2" />
                  <rect x="12" y="9" width="8" height="6" rx="1" fill="currentColor" opacity="0.4" />
                </svg>
              </button>
            )}
          </div>

          {/* Bottom bar: controls */}
          <div className="player__controls">
            {/* Seek bar for VOD */}
            {!isLive && hasDuration && (
              <div className="player__seek-row">
                <span className="player__time">{formatTime(seekDisplay)}</span>
                <input
                  ref={seekBarRef}
                  className="player__seek-bar"
                  type="range"
                  min={0}
                  max={duration}
                  step={0.5}
                  value={seekDisplay}
                  onMouseDown={handleSeekStart}
                  onTouchStart={handleSeekStart}
                  onChange={handleSeekChange}
                  onMouseUp={handleSeekEnd}
                  onTouchEnd={handleSeekEnd}
                  onClick={(e) => e.stopPropagation()}
                />
                <span className="player__time">{formatTime(duration)}</span>
              </div>
            )}

            {/* Live progress bar */}
            {isLive && currentProgram && (
              <div className="player__live-row">
                <span className="player__live-badge">LIVE</span>
                <div className="player__osd-progress-bar">
                  <div className="player__osd-progress-fill" style={{ width: `${liveProgress}%` }} />
                </div>
                <span className="player__time player__time--small">
                  {currentProgram.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {' - '}
                  {currentProgram.stop.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            )}

            {/* Playback buttons */}
            {MOBILE && (
              <div className="player__btn-row">
                {!isLive && (
                  <button className="player__ctrl-btn" onClick={(e) => { e.stopPropagation(); handleSkip(-10); }} title="Back 10s">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12.5 3C7.26 3 3.03 7.03 3 12.13L1 10.1 0 11.18l3.5 3.5 3.5-3.5-1-1.07L4 12.13C4.03 7.59 7.59 4 12.5 4c4.14 0 7.5 3.36 7.5 7.5S16.64 19 12.5 19c-2.95 0-5.5-1.71-6.71-4.19l-.91.39C6.17 17.89 9.09 20 12.5 20c4.69 0 8.5-3.81 8.5-8.5S17.19 3 12.5 3z" />
                      <text x="9" y="15" fontSize="7" fontWeight="bold" fill="currentColor">10</text>
                    </svg>
                  </button>
                )}
                <button className="player__ctrl-btn player__ctrl-btn--play" onClick={handleTogglePlay}>
                  {isPaused ? (
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                  ) : (
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                  )}
                </button>
                {!isLive && (
                  <button className="player__ctrl-btn" onClick={(e) => { e.stopPropagation(); handleSkip(10); }} title="Forward 10s">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M11.5 3C16.74 3 20.97 7.03 21 12.13L23 10.1l1 1.07-3.5 3.5-3.5-3.5 1-1.07 2 2.02C19.97 7.59 16.41 4 11.5 4 7.36 4 4 7.36 4 11.5S7.36 19 11.5 19c2.95 0 5.5-1.71 6.71-4.19l.91.39C17.83 17.89 14.91 20 11.5 20 6.81 20 3 16.19 3 11.5S6.81 3 11.5 3z" />
                      <text x="8" y="15" fontSize="7" fontWeight="bold" fill="currentColor">10</text>
                    </svg>
                  </button>
                )}
              </div>
            )}

            {/* Subtitle indicator (TV only) */}
            {!MOBILE && (
              <span className="player__osd-subtitle-indicator">
                {currentSubtitleIndex === -1 ? 'Subs: Off' : `Subs: ${subtitleTracks[currentSubtitleIndex]?.label || 'On'}`}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
