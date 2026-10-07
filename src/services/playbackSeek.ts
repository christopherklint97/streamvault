interface SeekableAvPlay {
  seekTo(
    positionMs: number,
    successCallback?: () => void,
    errorCallback?: (error: Error) => void,
  ): void | Promise<void>;
}

function timeoutError(kind: string): Error {
  return new Error(`${kind} seek timed out`);
}

interface RetryPlaybackSeekOptions {
  maxAttempts?: number;
  backoffMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
  signal?: AbortSignal;
}

const waitFor = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs));

export function getInitialResumeTarget(requestedSeconds: number, mediaDurationSeconds: number): number {
  const requested = Number.isFinite(requestedSeconds) && requestedSeconds > 0 ? requestedSeconds : 0;
  const duration = Number.isFinite(mediaDurationSeconds) && mediaDurationSeconds > 0
    ? mediaDurationSeconds
    : 0;
  return duration ? Math.min(requested, duration) : requested;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Playback seek aborted', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

export async function retryPlaybackSeek(
  operation: () => Promise<void>,
  options: RetryPlaybackSeekOptions = {},
): Promise<void> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const backoffMs = options.backoffMs ?? [100, 250];
  const wait = options.wait ?? waitFor;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      await operation();
      throwIfAborted(options.signal);
      return;
    } catch (error) {
      throwIfAborted(options.signal);
      lastError = error;
      if (attempt + 1 >= maxAttempts) break;
      await wait(backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 0);
      throwIfAborted(options.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function seekHtml5(
  video: HTMLVideoElement,
  targetSeconds: number,
  timeoutMs = 3_000,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onSeeked = () => {
      if (Math.abs(video.currentTime - targetSeconds) > 0.25) {
        finish(new Error(`HTML5 seek did not reach target ${targetSeconds}`));
        return;
      }
      finish();
    };
    const onError = () => finish(new Error('HTML5 seek failed'));
    const onAbort = () => finish(signal ? abortError(signal) : undefined);
    const timer = setTimeout(() => finish(timeoutError('HTML5')), timeoutMs);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      video.currentTime = targetSeconds;
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function seekAvPlay(
  manager: SeekableAvPlay,
  targetSeconds: number,
  timeoutMs = 3_000,
  signal?: AbortSignal,
  onStaleCompletion?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let staleCompletionHandled = false;
    const timer = setTimeout(() => finish(timeoutError('AVPlay')), timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(signal ? abortError(signal) : undefined);
    const onSuccess = () => {
      if (signal?.aborted) {
        if (!staleCompletionHandled) {
          staleCompletionHandled = true;
          onStaleCompletion?.();
        }
        return;
      }
      finish();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    try {
      const result = manager.seekTo(
        targetSeconds * 1000,
        onSuccess,
        (error) => finish(error instanceof Error ? error : new Error(String(error))),
      );
      if (result && typeof result.then === 'function') {
        void result.then(onSuccess, (error: unknown) =>
          finish(error instanceof Error ? error : new Error(String(error))),
        );
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
