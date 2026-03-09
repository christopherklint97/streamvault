/**
 * AVPlay wrapper with HTML5 video fallback.
 * TizenPlayer uses the webapis.avplay API available on Samsung Tizen TVs.
 * HTML5Player uses a standard HTMLVideoElement for browser-based development.
 */

export interface SubtitleTrack {
  index: number;
  language: string;
  label: string;
}

export interface PlayerBackend {
  open(url: string): void;
  play(): void;
  pause(): void;
  stop(): void;
  close(): void;
  seekTo(positionMs: number): void;
  getDuration(): number;
  getCurrentTime(): number;
  getSubtitleTracks(): SubtitleTrack[];
  setSubtitleTrack(index: number): void;
}

/**
 * Samsung Tizen AVPlay-based player implementation.
 * Handles the AVPlay lifecycle: open -> prepareAsync -> play.
 */
export class TizenPlayer implements PlayerBackend {
  private prepared: boolean = false;
  private subtitleTracks: SubtitleTrack[] = [];
  private subtitlesSuppressed: boolean = false;
  private static displayRectSet: boolean = false;
  onSubtitleText?: (text: string) => void;

  open(url: string): void {
    this.prepared = false;

    try {
      webapis.avplay.open(url);

      // Set display to full screen — only once, rect never changes
      if (!TizenPlayer.displayRectSet) {
        const screenWidth =
          window.innerWidth || document.documentElement.clientWidth;
        const screenHeight =
          window.innerHeight || document.documentElement.clientHeight;
        webapis.avplay.setDisplayRect(0, 0, screenWidth, screenHeight);
        TizenPlayer.displayRectSet = true;
      }

      // Set up event listeners
      webapis.avplay.setListener({
        onerror: () => {
          this.prepared = false;
        },
        onstreamcompleted: () => {
          this.prepared = false;
        },
        onsubtitlechange: (_duration: number, text: string) => {
          if (!this.subtitlesSuppressed) {
            this.onSubtitleText?.(text);
          }
        },
      });

      this.subtitleTracks = [{ index: 0, language: 'default', label: 'Subtitles' }];

      // Prepare asynchronously and auto-play on success
      webapis.avplay.prepareAsync(
        () => {
          this.prepared = true;
          this.preventScreenSaver(true);
        },
        (error: Error) => {
          this.prepared = false;
          throw new Error('AVPlay prepare failed: ' + error.message);
        }
      );
    } catch (e) {
      throw new Error(
        'AVPlay open failed: ' + (e instanceof Error ? e.message : String(e))
      );
    }
  }

  play(): void {
    try {
      const state = webapis.avplay.getState();
      if (state === 'READY' || state === 'PAUSED') {
        webapis.avplay.play();
        this.preventScreenSaver(true);
      }
    } catch (e) {
      throw new Error(
        'AVPlay play failed: ' + (e instanceof Error ? e.message : String(e))
      );
    }
  }

  pause(): void {
    try {
      const state = webapis.avplay.getState();
      if (state === 'PLAYING') {
        webapis.avplay.pause();
        this.preventScreenSaver(false);
      }
    } catch (e) {
      throw new Error(
        'AVPlay pause failed: ' + (e instanceof Error ? e.message : String(e))
      );
    }
  }

  stop(): void {
    try {
      const state = webapis.avplay.getState();
      if (
        state === 'PLAYING' ||
        state === 'PAUSED' ||
        state === 'READY'
      ) {
        webapis.avplay.stop();
        this.prepared = false;
        this.preventScreenSaver(false);
      }
    } catch (e) {
      throw new Error(
        'AVPlay stop failed: ' + (e instanceof Error ? e.message : String(e))
      );
    }
  }

  close(): void {
    try {
      this.stop();
    } catch {
      // Ignore stop errors during close
    }
    try {
      webapis.avplay.close();
      this.prepared = false;
      this.preventScreenSaver(false);
    } catch (e) {
      throw new Error(
        'AVPlay close failed: ' + (e instanceof Error ? e.message : String(e))
      );
    }
  }

  seekTo(positionMs: number): void {
    try {
      const state = webapis.avplay.getState();
      if (state === 'PLAYING' || state === 'PAUSED') {
        webapis.avplay.seekTo(positionMs);
      }
    } catch (e) {
      throw new Error(
        'AVPlay seekTo failed: ' + (e instanceof Error ? e.message : String(e))
      );
    }
  }

  getDuration(): number {
    try {
      if (this.prepared) {
        return webapis.avplay.getDuration();
      }
      return 0;
    } catch {
      return 0;
    }
  }

  getCurrentTime(): number {
    try {
      if (this.prepared) {
        return webapis.avplay.getCurrentTime();
      }
      return 0;
    } catch {
      return 0;
    }
  }

  getSubtitleTracks(): SubtitleTrack[] {
    return this.subtitleTracks;
  }

  setSubtitleTrack(index: number): void {
    this.subtitlesSuppressed = index === -1;
    if (this.subtitlesSuppressed) {
      this.onSubtitleText?.('');
    }
  }

  /**
   * Enable or disable screen saver prevention on Tizen.
   */
  private preventScreenSaver(prevent: boolean): void {
    try {
      if (typeof webapis !== 'undefined' && webapis.appcommon) {
        const state = prevent
          ? webapis.appcommon.AppCommonScreenSaverState
              .SCREEN_SAVER_OFF
          : webapis.appcommon.AppCommonScreenSaverState
              .SCREEN_SAVER_ON;
        webapis.appcommon.setScreenSaverState(state);
      }
    } catch {
      // Screen saver API may not be available in all environments
    }
  }
}

/**
 * HTML5 video element player for browser-based development and testing.
 */
export class HTML5Player implements PlayerBackend {
  private video: HTMLVideoElement;
  onSubtitleText?: (text: string) => void;

  constructor() {
    // Reuse existing video element or create a new one
    let existing = document.getElementById(
      'streamvault-player'
    ) as HTMLVideoElement | null;
    if (!existing) {
      existing = document.createElement('video');
      existing.id = 'streamvault-player';
      existing.style.position = 'fixed';
      existing.style.top = '0';
      existing.style.left = '0';
      existing.style.width = '100%';
      existing.style.height = '100%';
      existing.style.backgroundColor = '#000';
      existing.style.zIndex = '1000';
      document.body.appendChild(existing);
    }
    this.video = existing;
  }

  open(url: string): void {
    this.video.src = url;
    this.video.style.display = 'block';
    this.video.load();

    // Listen for cuechange events on text tracks
    this.video.textTracks.addEventListener('addtrack', () => {
      for (let i = 0; i < this.video.textTracks.length; i++) {
        const track = this.video.textTracks[i];
        track.addEventListener('cuechange', () => {
          if (track.mode === 'showing' && track.activeCues && track.activeCues.length > 0) {
            const cue = track.activeCues[0] as VTTCue;
            this.onSubtitleText?.(cue.text);
          } else if (track.mode === 'showing') {
            this.onSubtitleText?.('');
          }
        });
      }
    });
  }

  play(): void {
    this.video.play().catch(() => {
      // Autoplay may be blocked by browser policy
    });
  }

  pause(): void {
    this.video.pause();
  }

  stop(): void {
    this.video.pause();
    this.video.currentTime = 0;
  }

  close(): void {
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load(); // Reset the video element
    this.video.style.display = 'none';
  }

  seekTo(positionMs: number): void {
    this.video.currentTime = positionMs / 1000;
  }

  getDuration(): number {
    const duration = this.video.duration;
    if (isNaN(duration) || !isFinite(duration)) {
      return 0;
    }
    return duration * 1000; // Convert seconds to milliseconds
  }

  getCurrentTime(): number {
    return this.video.currentTime * 1000; // Convert seconds to milliseconds
  }

  getSubtitleTracks(): SubtitleTrack[] {
    const tracks: SubtitleTrack[] = [];
    for (let i = 0; i < this.video.textTracks.length; i++) {
      const track = this.video.textTracks[i];
      tracks.push({
        index: i,
        language: track.language || 'unknown',
        label: track.label || `Track ${i + 1}`,
      });
    }
    return tracks;
  }

  setSubtitleTrack(index: number): void {
    for (let i = 0; i < this.video.textTracks.length; i++) {
      this.video.textTracks[i].mode = i === index ? 'showing' : 'hidden';
    }
    if (index === -1) {
      this.onSubtitleText?.('');
    }
  }
}

/**
 * Factory function that creates the appropriate player backend
 * based on the current runtime environment.
 * Returns TizenPlayer on Samsung Tizen TVs, HTML5Player elsewhere.
 */
export function createPlayer(): PlayerBackend {
  if (
    typeof webapis !== 'undefined' &&
    typeof webapis.avplay !== 'undefined'
  ) {
    return new TizenPlayer();
  }
  return new HTML5Player();
}
