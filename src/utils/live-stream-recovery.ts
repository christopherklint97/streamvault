export type LiveRecoveryReason = 'loading-complete' | 'media-ended' | 'mpegts-error' | 'stalled';

type TimerHandle = ReturnType<typeof setTimeout>;

type LiveStreamRecoveryOptions = {
  stallTimeoutMs?: number;
  retryDelaysMs?: number[];
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};

const DEFAULT_STALL_TIMEOUT_MS = 12_000;
const DEFAULT_RETRY_DELAYS_MS = [250, 1_000, 3_000, 5_000, 10_000, 20_000, 30_000];

/**
 * Tracks a browser live stream across reconnect attempts.
 *
 * A transport EOF is terminal and reconnects immediately. Browser `stalled`
 * events are only hints: recovery waits until neither media time nor decoded
 * frames have advanced for the full stall timeout, avoiding false restarts
 * during the short stalls common to MPEG-TS playback.
 */
export class LiveStreamRecovery {
  private readonly stallTimeoutMs: number;
  private readonly retryDelaysMs: number[];
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private active = false;
  private paused = false;
  private streamKey = '';
  private lastProgressAt = 0;
  private retryCount = 0;
  private watchdogTimer: TimerHandle | null = null;
  private retryTimer: TimerHandle | null = null;
  private readonly onRecover: (reason: LiveRecoveryReason, attempt: number) => void;

  constructor(
    onRecover: (reason: LiveRecoveryReason, attempt: number) => void,
    options: LiveStreamRecoveryOptions = {},
  ) {
    this.onRecover = onRecover;
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.retryDelaysMs = options.retryDelaysMs?.length
      ? options.retryDelaysMs
      : DEFAULT_RETRY_DELAYS_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  begin(streamKey: string): void {
    const isNewStream = !this.active || this.streamKey !== streamKey;
    this.active = true;
    this.paused = false;
    this.streamKey = streamKey;
    if (isNewStream) this.retryCount = 0;
    this.clearRetryTimer();
    this.lastProgressAt = this.now();
    this.armWatchdog(this.stallTimeoutMs);
  }

  progress(): void {
    if (!this.active || this.paused) return;
    this.lastProgressAt = this.now();
    this.retryCount = 0;
    this.armWatchdog(this.stallTimeoutMs);
  }

  stalled(): void {
    if (!this.active || this.paused || this.retryTimer) return;
    const remaining = Math.max(0, this.stallTimeoutMs - (this.now() - this.lastProgressAt));
    this.armWatchdog(remaining);
  }

  transportEnded(reason: Exclude<LiveRecoveryReason, 'stalled'>): void {
    if (!this.active || this.paused) return;
    this.scheduleRecovery(reason);
  }

  suspend(): void {
    if (!this.active) return;
    this.paused = true;
    this.clearWatchdog();
    this.clearRetryTimer();
  }

  resume(): void {
    if (!this.active) return;
    this.paused = false;
    this.lastProgressAt = this.now();
    this.armWatchdog(this.stallTimeoutMs);
  }

  stop(): void {
    this.active = false;
    this.paused = false;
    this.streamKey = '';
    this.retryCount = 0;
    this.clearWatchdog();
    this.clearRetryTimer();
  }

  private armWatchdog(delayMs: number): void {
    this.clearWatchdog();
    if (!this.active || this.paused || this.retryTimer) return;
    this.watchdogTimer = this.setTimer(() => {
      this.watchdogTimer = null;
      if (!this.active) return;
      const elapsed = this.now() - this.lastProgressAt;
      if (elapsed >= this.stallTimeoutMs) {
        this.scheduleRecovery('stalled');
      } else {
        this.armWatchdog(this.stallTimeoutMs - elapsed);
      }
    }, delayMs);
  }

  private scheduleRecovery(reason: LiveRecoveryReason): void {
    this.clearWatchdog();
    if (!this.active || this.paused || this.retryTimer) return;

    const attempt = this.retryCount + 1;
    const delay = this.retryDelaysMs[Math.min(this.retryCount, this.retryDelaysMs.length - 1)];
    this.retryCount = attempt;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (this.active) this.onRecover(reason, attempt);
    }, delay);
  }

  private clearWatchdog(): void {
    if (!this.watchdogTimer) return;
    this.clearTimer(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private clearRetryTimer(): void {
    if (!this.retryTimer) return;
    this.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }
}
