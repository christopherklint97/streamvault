import { useState, useEffect, useCallback, useRef } from 'react';
import { usePlayer, getStreamUrl } from '../hooks/usePlayer';
import { usePlayerStore } from '../stores/playerStore';
import { useChannelStore } from '../stores/channelStore';
import { useAppStore } from '../stores/appStore';
import { useRecordingStore } from '../stores/recordingStore';
import { getCurrentProgram } from '../services/epg-service';
import { KEY_CODES } from '../utils/keys';
import { isMobile, isIPhone } from '../utils/platform';
import { cn } from '../utils/cn';

const OSD_TIMEOUT = 5000;
const MOBILE = isMobile();

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
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
  const containerRef = useRef<HTMLDivElement | null>(null);

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
  useEffect(() => {
    if (!MOBILE || !document.pictureInPictureEnabled) return;
    const video = getVideoElement();
    if (!video) return;

    if ('autoPictureInPicture' in video) {
      (video as HTMLVideoElement & { autoPictureInPicture: boolean }).autoPictureInPicture = true;
      return () => {
        if (video && 'autoPictureInPicture' in video) {
          (video as HTMLVideoElement & { autoPictureInPicture: boolean }).autoPictureInPicture = false;
        }
      };
    }

    const handleVisibilityChange = () => {
      if (document.hidden && playerState.status === 'playing' && !document.pictureInPictureElement) {
        video.requestPictureInPicture().catch((err) => showToast(`Auto-PiP failed: ${err}`));
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [getVideoElement, playerState.status, showToast]);

  const handleBack = useCallback(() => {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch((err) => showToast(`Exit PiP failed: ${err}`));
    }
    stop();
    goBack();
  }, [stop, goBack, showToast]);

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

  const handleExternalPlayer = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentChannel) return;
    const streamUrl = getStreamUrl(currentChannel.id, currentChannel.url);
    // Absolute URL for external app
    const absoluteUrl = streamUrl.startsWith('http') ? streamUrl : `${window.location.origin}${streamUrl}`;
    // Android intent — opens in VLC, MX Player, or any video handler
    const intentUrl = `intent:${absoluteUrl}#Intent;type=video/*;end`;
    window.location.href = intentUrl;
  }, [currentChannel]);

  const [isFullscreen, setIsFullscreen] = useState(false);

  // Fullscreen: container-level on Android/iPad, native video fullscreen on iPhone
  const handleFullscreen = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();

    // iPhone doesn't support the Fullscreen API — use native video fullscreen
    if (isIPhone()) {
      const video = getVideoElement() as HTMLVideoElement & {
        webkitEnterFullscreen?: () => void;
        webkitExitFullscreen?: () => void;
      };
      if (!video) return;
      if ((video as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }).webkitDisplayingFullscreen) {
        video.webkitExitFullscreen?.();
      } else {
        video.webkitEnterFullscreen?.();
      }
      return;
    }

    // Android / iPad: fullscreen on the container to keep custom controls
    const container = containerRef.current;
    if (!container) return;

    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void>;
    };
    const el = container as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>;
    };

    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      if (doc.exitFullscreen) doc.exitFullscreen();
      else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
      try { screen.orientation.unlock(); } catch (err) { showToast(`Orientation unlock failed: ${err}`); }
    } else {
      const goFs = el.requestFullscreen
        ? el.requestFullscreen()
        : el.webkitRequestFullscreen
          ? el.webkitRequestFullscreen()
          : Promise.resolve();
      (goFs as Promise<void>).then(() => {
        try {
          const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
          orientation.lock?.('landscape')?.catch((err) => showToast(`Orientation lock failed: ${err}`));
        } catch (err) { showToast(`Orientation lock failed: ${err}`); }
      }).catch((err) => showToast(`Fullscreen failed: ${err}`));
    }
  }, [getVideoElement, showToast]);

  useEffect(() => {
    const video = getVideoElement();
    const onFsChange = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      const isFs = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
      setIsFullscreen(isFs);
      // Browsers may pause video when exiting fullscreen — resume it
      if (!isFs && video && video.paused) {
        video.play().catch((err) => showToast(`Resume failed: ${err}`));
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);

    // iPhone fires these events on the video element instead
    const onWebkitBegin = () => setIsFullscreen(true);
    const onWebkitEnd = () => {
      setIsFullscreen(false);
      if (video && video.paused) video.play().catch((err) => showToast(`Resume failed: ${err}`));
    };
    video?.addEventListener('webkitbeginfullscreen', onWebkitBegin);
    video?.addEventListener('webkitendfullscreen', onWebkitEnd);

    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
      video?.removeEventListener('webkitbeginfullscreen', onWebkitBegin);
      video?.removeEventListener('webkitendfullscreen', onWebkitEnd);
    };
  }, [getVideoElement, showToast]);

  const handleRecord = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentChannel || isRecording) return;
    const now = Date.now();
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

  // Tap empty area to toggle OSD (dedicated layer behind controls)
  const handleTapZone = useCallback(() => {
    if (showOSD) {
      setShowOSD(false);
      if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    } else {
      resetOSDTimer();
    }
  }, [showOSD, resetOSDTimer]);

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
  const isAndroid = /Android/i.test(navigator.userAgent);
  const remaining = hasDuration ? duration - seekDisplay : 0;

  return (
    <div
      ref={containerRef}
      className="w-full h-dvh lg:w-tv lg:h-tv relative bg-black fixed lg:static top-0 left-0 right-0 bottom-0"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* Video container */}
      <div className="w-full h-full">
        {typeof webapis !== 'undefined' && webapis.avplay ? (
          <div id="av-player" className="player__av-object" />
        ) : (
          <video id="av-player" className="w-full h-full bg-black object-contain object-center" autoPlay playsInline />
        )}
      </div>

      {/* Loading spinner */}
      {playerState.status === 'loading' && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-4 text-[#888] text-20 animate-fade-in">
          <div className="w-12 h-12 border-[3px] border-[#222] border-t-accent rounded-full animate-spin-fast" />
          <span>Loading...</span>
        </div>
      )}

      {/* Error display */}
      {playerState.status === 'error' && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center text-[#ff4757] animate-fade-in px-6 lg:px-0">
          <div className="text-48 mb-3">{'\u26A0'}</div>
          <h2 className="text-20 lg:text-26 font-bold mb-2">Playback Error</h2>
          <p className="text-15 lg:text-18 text-[#888] mb-2">{playerState.errorMessage}</p>
          {MOBILE ? (
            <button className="mt-4 py-3 px-8 bg-accent border-none rounded-lg text-black text-base font-bold tap-none active:opacity-80" onClick={retry}>Retry</button>
          ) : (
            <p className="text-base text-[#555]">Press ENTER to retry</p>
          )}
        </div>
      )}

      {/* Subtitle text overlay */}
      {subtitleText && (
        <div className="absolute bottom-[60px] lg:bottom-20 left-1/2 -translate-x-1/2 max-w-[80%] py-2 px-4 bg-black/75 rounded text-20 lg:text-28 text-center z-[2]">
          <span>{subtitleText}</span>
        </div>
      )}

      {/* Tap zone — sits above video, below controls; toggles OSD on tap */}
      {MOBILE && (
        <div className="absolute inset-0 z-[2]" onClick={handleTapZone} />
      )}

      {/* Controls OSD — wrapper is always pointer-events-none, individual bars opt in */}
      {currentChannel && playerState.status !== 'error' && (
        <div className={cn(
          'absolute inset-0 flex flex-col justify-between opacity-0 transition-opacity duration-300 pointer-events-none z-[3]',
          showOSD && 'opacity-100'
        )}>
          {/* Top bar */}
          <div className="pointer-events-auto flex items-center gap-3 pt-[calc(12px+env(safe-area-inset-top,0px))] pb-8 px-[calc(16px+env(safe-area-inset-left,0px))] pr-[calc(16px+env(safe-area-inset-right,0px))] bg-gradient-to-b from-black/[0.85] to-transparent lg:gap-3 lg:pt-6 lg:px-10 lg:pb-10">
            {MOBILE && (
              <button
                className="flex items-center justify-center w-10 h-10 bg-transparent border-none text-white shrink-0 tap-none active:opacity-60"
                onClick={(e) => { e.stopPropagation(); handleBack(); }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
            <div className="flex-1 min-w-0">
              <span className="text-base lg:text-28 font-bold block whitespace-nowrap overflow-hidden text-ellipsis">{currentChannel.name}</span>
              {currentProgram && (
                <span className="text-12 lg:text-18 text-[#aaa] mt-0.5 block">{currentProgram.title}</span>
              )}
            </div>
            {/* Top-right action buttons */}
            <div className="flex items-center gap-1" data-player-controls>
              {MOBILE && isLive && (
                <button
                  className={cn(
                    'flex items-center justify-center w-10 h-10 rounded-lg border-none bg-transparent text-white shrink-0 tap-none cursor-pointer active:opacity-60',
                    isRecording && 'text-[#ef4444] animate-pulse-record'
                  )}
                  onClick={handleRecord}
                  title={isRecording ? 'Recording...' : 'Record'}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="9" />
                    <circle cx="12" cy="12" r="4" fill={isRecording ? 'currentColor' : 'none'} />
                  </svg>
                </button>
              )}
              {MOBILE && isAndroid && (
                <button
                  className="flex items-center justify-center w-10 h-10 rounded-lg border-none bg-transparent text-white shrink-0 tap-none cursor-pointer active:opacity-60"
                  onClick={handleExternalPlayer}
                  title="Open in external player"
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </button>
              )}
              {MOBILE && (
                <button
                  className="flex items-center justify-center w-10 h-10 rounded-lg border-none bg-transparent text-white shrink-0 tap-none cursor-pointer active:opacity-60"
                  onClick={handleFullscreen}
                  title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                >
                  {isFullscreen ? (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                    </svg>
                  ) : (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
                      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
                      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
                    </svg>
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Center play/skip controls */}
          {MOBILE && (
            <div className="pointer-events-auto absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-10" data-player-controls>
              {!isLive && (
                <button
                  className="flex items-center justify-center w-12 h-12 rounded-full border-none bg-transparent text-white tap-none cursor-pointer active:opacity-60"
                  onClick={(e) => { e.stopPropagation(); handleSkip(-10); }}
                  title="Back 10s"
                >
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12.5 3C7.26 3 3.03 7.03 3 12.13L1 10.1 0 11.18l3.5 3.5 3.5-3.5-1-1.07L4 12.13C4.03 7.59 7.59 4 12.5 4c4.14 0 7.5 3.36 7.5 7.5S16.64 19 12.5 19c-2.95 0-5.5-1.71-6.71-4.19l-.91.39C6.17 17.89 9.09 20 12.5 20c4.69 0 8.5-3.81 8.5-8.5S17.19 3 12.5 3z" />
                    <text x="9" y="15" fontSize="7" fontWeight="bold" fill="currentColor">10</text>
                  </svg>
                </button>
              )}
              <button
                className="flex items-center justify-center w-16 h-16 rounded-full border-2 border-white/30 bg-black/30 text-white tap-none cursor-pointer active:opacity-60"
                onClick={handleTogglePlay}
              >
                {isPaused ? (
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                ) : (
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
                )}
              </button>
              {!isLive && (
                <button
                  className="flex items-center justify-center w-12 h-12 rounded-full border-none bg-transparent text-white tap-none cursor-pointer active:opacity-60"
                  onClick={(e) => { e.stopPropagation(); handleSkip(10); }}
                  title="Forward 10s"
                >
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M11.5 3C16.74 3 20.97 7.03 21 12.13L23 10.1l1 1.07-3.5 3.5-3.5-3.5 1-1.07 2 2.02C19.97 7.59 16.41 4 11.5 4 7.36 4 4 7.36 4 11.5S7.36 19 11.5 19c2.95 0 5.5-1.71 6.71-4.19l.91.39C17.83 17.89 14.91 20 11.5 20 6.81 20 3 16.19 3 11.5S6.81 3 11.5 3z" />
                    <text x="8" y="15" fontSize="7" fontWeight="bold" fill="currentColor">10</text>
                  </svg>
                </button>
              )}
            </div>
          )}

          {/* Bottom bar: progress + time */}
          <div className="pointer-events-auto relative px-[calc(16px+env(safe-area-inset-left,0px))] pr-[calc(16px+env(safe-area-inset-right,0px))] pt-8 pb-[calc(12px+env(safe-area-inset-bottom,0px))] lg:px-10 lg:pt-10 lg:pb-6 bg-gradient-to-t from-black/90 to-transparent">
            {/* Seek bar for VOD */}
            {!isLive && hasDuration && (
              <div data-player-controls>
                <input
                  ref={seekBarRef}
                  className="seek-bar w-full h-1 rounded-sm mb-2"
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
                <div className="flex items-center justify-between">
                  <span className="text-12 text-[#aaa] tabular-nums">{formatTime(seekDisplay)}</span>
                  <span className="text-12 text-[#aaa] tabular-nums">-{formatTime(remaining)}</span>
                </div>
              </div>
            )}

            {/* Live progress bar */}
            {isLive && currentProgram && (
              <div className="flex items-center gap-2.5 mb-2" data-player-controls>
                <span className="text-11 font-bold tracking-wider text-white bg-[#e53935] py-0.5 px-2 rounded-[3px] shrink-0">LIVE</span>
                <div className="flex-1 h-1 bg-white/[0.15] rounded-sm overflow-hidden">
                  <div className="h-full bg-accent rounded-sm transition-[width] duration-1000 linear" style={{ width: `${liveProgress}%` }} />
                </div>
                <span className="text-sm text-[#aaa] tabular-nums min-w-0 text-12 text-center">
                  {currentProgram.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  {' - '}
                  {currentProgram.stop.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            )}

            {/* Subtitle indicator (TV only) */}
            {!MOBILE && (
              <span className="text-sm text-[#555] mt-1 block">
                {currentSubtitleIndex === -1 ? 'Subs: Off' : `Subs: ${subtitleTracks[currentSubtitleIndex]?.label || 'On'}`}
              </span>
            )}

          </div>
        </div>
      )}
    </div>
  );
}
