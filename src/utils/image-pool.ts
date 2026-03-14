/**
 * Image Pool - Netflix-inspired image element recycling.
 *
 * Instead of creating/destroying img elements as cards scroll in/out of view,
 * we maintain a pool of reusable Image objects. When a card leaves the viewport,
 * its image is returned to the pool. When a new card enters, it grabs one from
 * the pool and swaps the src.
 *
 * This eliminates GC pressure from constant DOM node creation/destruction
 * and reduces layout thrashing from img element insertion.
 */

const pool: HTMLImageElement[] = [];
const POOL_MAX = 50;

/** Get a recycled img element or create a new one */
export function acquireImage(): HTMLImageElement {
  const img = pool.pop();
  if (img) {
    img.src = '';
    img.removeAttribute('alt');
    img.style.display = '';
    return img;
  }
  const el = document.createElement('img');
  el.decoding = 'async';
  el.loading = 'lazy';
  return el;
}

/** Return an img element to the pool for reuse */
export function releaseImage(img: HTMLImageElement): void {
  if (pool.length < POOL_MAX) {
    img.src = '';
    img.onload = null;
    img.onerror = null;
    pool.push(img);
  }
}

/**
 * Image prefetch cache - preload images that are about to come into view.
 * Uses a simple LRU-style cache of Image objects.
 */
const prefetchCache = new Map<string, HTMLImageElement>();
const PREFETCH_MAX = 100;

/** Prefetch a batch of image URLs so they're in the browser cache */
export function prefetchImages(urls: string[]): void {
  for (const url of urls) {
    if (!url || prefetchCache.has(url)) continue;

    // Evict oldest if at capacity
    if (prefetchCache.size >= PREFETCH_MAX) {
      const firstKey = prefetchCache.keys().next().value;
      if (firstKey !== undefined) {
        prefetchCache.delete(firstKey);
      }
    }

    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    prefetchCache.set(url, img);
  }
}

/** Check if an image URL is already cached/prefetched */
export function isImagePrefetched(url: string): boolean {
  return prefetchCache.has(url);
}
