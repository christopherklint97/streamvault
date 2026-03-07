/**
 * localStorage wrapper with JSON serialization.
 * All operations are wrapped in try/catch because Tizen can throw
 * when storage is full or when localStorage is unavailable.
 */

export function getItem<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setItem<T>(key: string, value: T): void {
  try {
    const serialized = JSON.stringify(value);
    localStorage.setItem(key, serialized);
  } catch {
    // Storage full or unavailable - silently fail.
    // Callers should not depend on persistence being guaranteed.
  }
}

export function removeItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // localStorage unavailable - silently fail.
  }
}
