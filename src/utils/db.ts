/**
 * IndexedDB storage for large datasets (channels, programs).
 * Falls back to localStorage if IndexedDB is unavailable.
 */

import type { Channel, Program } from '../types';
import { getItem, setItem } from './storage';

const DB_NAME = 'streamvault';
const DB_VERSION = 1;
const CHANNELS_STORE = 'channels';
const PROGRAMS_STORE = 'programs';

let dbInstance: IDBDatabase | null = null;
let dbFailed = false;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (dbFailed) return Promise.reject(new Error('IndexedDB unavailable'));

  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CHANNELS_STORE)) {
          db.createObjectStore(CHANNELS_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(PROGRAMS_STORE)) {
          db.createObjectStore(PROGRAMS_STORE, { autoIncrement: true });
        }
      };

      request.onsuccess = () => {
        dbInstance = request.result;
        resolve(dbInstance);
      };

      request.onerror = () => {
        dbFailed = true;
        reject(request.error);
      };
    } catch {
      dbFailed = true;
      reject(new Error('IndexedDB not supported'));
    }
  });
}

export async function saveChannels(channels: Channel[]): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(CHANNELS_STORE, 'readwrite');
    const store = tx.objectStore(CHANNELS_STORE);
    store.clear();
    for (const ch of channels) {
      store.put(ch);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Fallback to localStorage
    setItem('streamvault_cached_channels', channels);
  }
}

export async function loadChannels(): Promise<Channel[]> {
  try {
    const db = await openDB();
    const tx = db.transaction(CHANNELS_STORE, 'readonly');
    const store = tx.objectStore(CHANNELS_STORE);
    const request = store.getAll();
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as Channel[]);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return getItem<Channel[]>('streamvault_cached_channels', []);
  }
}

export async function savePrograms(programs: Program[]): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(PROGRAMS_STORE, 'readwrite');
    const store = tx.objectStore(PROGRAMS_STORE);
    store.clear();
    // Write in batches to avoid blocking
    const BATCH = 5000;
    for (let i = 0; i < programs.length; i += BATCH) {
      const batch = programs.slice(i, i + BATCH);
      for (const p of batch) {
        // Serialize dates for storage
        store.put({
          channelId: p.channelId,
          title: p.title,
          description: p.description,
          start: p.start.toISOString(),
          stop: p.stop.toISOString(),
          category: p.category,
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    setItem('streamvault_cached_programs', programs);
  }
}

export async function loadPrograms(): Promise<Program[]> {
  try {
    const db = await openDB();
    const tx = db.transaction(PROGRAMS_STORE, 'readonly');
    const store = tx.objectStore(PROGRAMS_STORE);
    const request = store.getAll();
    const raw = await new Promise<Array<Record<string, string>>>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return raw.map((p) => ({
      channelId: p.channelId,
      title: p.title,
      description: p.description,
      start: new Date(p.start),
      stop: new Date(p.stop),
      category: p.category,
    }));
  } catch {
    const raw = getItem<Array<{ channelId: string; title: string; description: string; start: string; stop: string; category: string }>>('streamvault_cached_programs', []);
    return raw.map((p) => ({
      ...p,
      start: new Date(p.start),
      stop: new Date(p.stop),
    }));
  }
}
