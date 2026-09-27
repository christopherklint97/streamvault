export function measureSlowOperation<T>(name: string, work: () => T, warn: (message: string) => void, thresholdMs = 250): T {
  const start = performance.now();
  try {
    return work();
  } finally {
    const duration = performance.now() - start;
    if (duration >= thresholdMs) warn(`Slow ${name}: ${Math.round(duration)}ms`);
  }
}
