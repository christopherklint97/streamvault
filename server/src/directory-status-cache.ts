export function createDirectoryStatusCache<T>(read: () => Promise<T>, catalog: () => string,
  options: { now?: () => number; maxAgeMs?: number; onError?: (error: unknown) => void } = {}) {
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? 30_000;
  let cached: { catalog: string; value: T; at: number } | undefined;
  let pending: { catalog: string; promise: Promise<T> } | undefined;
  let retryAt = 0;
  const refresh = (generation: string) => {
    if (pending?.catalog === generation) return pending.promise;
    const promise = read().then(value => {
      if (catalog() !== generation) throw new Error('Directory status snapshot superseded');
      cached = { catalog: generation, value, at: now() };
      retryAt = 0;
      return value;
    }).finally(() => { if (pending?.promise === promise) pending = undefined; });
    pending = { catalog: generation, promise };
    return promise;
  };
  return {
    async get(): Promise<T> {
      const generation = catalog();
      if (!cached || cached.catalog !== generation) return refresh(generation);
      // Directory counts may lag a catalog write by one refresh interval.
      // Never block startup on a second HDD scan; dynamic sync/crawl state is
      // merged by the route after this real, generation-bound snapshot returns.
      if (now() - cached.at >= maxAgeMs && now() >= retryAt) {
        void refresh(generation).catch(error => {
          if (catalog() !== generation) return;
          retryAt = now() + maxAgeMs;
          options.onError?.(error);
        });
      }
      return cached.value;
    },
  };
}
