/**
 * Performance Monitor - Netflix-inspired Key Input Responsiveness tracking.
 *
 * Measures the three core metrics Netflix uses for TV UI performance:
 * 1. Key Input Responsiveness (KIR) - time from keypress to visible change
 * 2. Time To Interactivity (TTI) - app startup time
 * 3. Frames Per Second (FPS) - animation smoothness
 */

interface PerfEntry {
  metric: string;
  value: number;
  timestamp: number;
}

const entries: PerfEntry[] = [];
const MAX_ENTRIES = 200;
let fpsFrameCount = 0;
let fpsLastTime = 0;
let fpsRafId = 0;
let currentFps = 60;
let kirStart = 0;

/** Start timing a key input response */
export function markKeyDown(): void {
  kirStart = performance.now();
}

/** End timing - call this after the DOM has been updated (in rAF callback) */
export function markKeyRendered(): void {
  if (kirStart === 0) return;
  const elapsed = performance.now() - kirStart;
  kirStart = 0;

  if (entries.length >= MAX_ENTRIES) entries.shift();
  entries.push({ metric: 'kir', value: elapsed, timestamp: Date.now() });

  // Log slow frames in development
  if (import.meta.env.DEV && elapsed > 32) {
    console.warn(`[perf] Slow key response: ${elapsed.toFixed(1)}ms`);
  }
}

/** Mark app startup complete */
export function markTTI(): void {
  const tti = performance.now();
  entries.push({ metric: 'tti', value: tti, timestamp: Date.now() });
  if (import.meta.env.DEV) {
    console.log(`[perf] Time to Interactive: ${tti.toFixed(0)}ms`);
  }
}

/** Start FPS monitoring */
export function startFPSMonitor(): void {
  if (fpsRafId) return;
  fpsLastTime = performance.now();
  fpsFrameCount = 0;

  const tick = (now: number) => {
    fpsFrameCount++;
    const elapsed = now - fpsLastTime;
    if (elapsed >= 1000) {
      currentFps = Math.round((fpsFrameCount * 1000) / elapsed);
      fpsFrameCount = 0;
      fpsLastTime = now;

      if (entries.length >= MAX_ENTRIES) entries.shift();
      entries.push({ metric: 'fps', value: currentFps, timestamp: Date.now() });
    }
    fpsRafId = requestAnimationFrame(tick);
  };

  fpsRafId = requestAnimationFrame(tick);
}

/** Stop FPS monitoring */
export function stopFPSMonitor(): void {
  if (fpsRafId) {
    cancelAnimationFrame(fpsRafId);
    fpsRafId = 0;
  }
}

/** Get current FPS */
export function getFPS(): number {
  return currentFps;
}

/** Get average Key Input Responsiveness (ms) over last N entries */
export function getAverageKIR(lastN = 20): number {
  const kirEntries = entries.filter((e) => e.metric === 'kir').slice(-lastN);
  if (kirEntries.length === 0) return 0;
  return kirEntries.reduce((sum, e) => sum + e.value, 0) / kirEntries.length;
}

/** Get performance summary for debugging */
export function getPerfSummary(): { avgKIR: number; fps: number; tti: number } {
  const ttiEntry = entries.find((e) => e.metric === 'tti');
  return {
    avgKIR: getAverageKIR(),
    fps: currentFps,
    tti: ttiEntry?.value ?? 0,
  };
}
