type Schedule = (callback: () => void) => () => void;

const INTERVAL_MS = 1000;

/** Observe missed timer deadlines without logging normal provider/network wait. */
export function startEventLoopMonitor(
  warn: (message: string) => void,
  now: () => number = () => performance.now(),
  schedule: Schedule = callback => {
    const timer = setInterval(callback, INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
  },
): () => void {
  let expected = now() + INTERVAL_MS;
  return schedule(() => {
    const actual = now();
    const lag = actual - expected;
    if (lag >= 500) warn(`Event loop stalled for at least ${Math.round(lag)}ms`);
    expected = actual + INTERVAL_MS;
  });
}
