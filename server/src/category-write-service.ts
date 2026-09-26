import { randomUUID } from 'node:crypto';
import { DB_PATH, getConfig, setConfig } from './db.js';
import type { DBChannel } from './db.js';
import { logger } from './logger.js';
import { createCategoryWriteWorker } from './category-write-worker.js';

let writer: ReturnType<typeof createCategoryWriteWorker> | undefined;

export function getCatalogGeneration(): string {
  return getConfig('catalog_generation', '');
}

export function rotateCatalogGeneration(): void {
  setConfig('catalog_generation', randomUUID());
}

export function saveCategorySnapshot(categoryId: string, channels: readonly DBChannel[], generation: string): Promise<void> {
  writer ??= createCategoryWriteWorker(DB_PATH, message => logger.warn(message));
  return writer.save(categoryId, channels, generation);
}

export async function closeCategorySnapshotWorker(): Promise<void> {
  const current = writer;
  writer = undefined;
  await current?.close();
}
