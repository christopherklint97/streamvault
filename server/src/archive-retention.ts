import fs from 'node:fs';
import path from 'node:path';
import type { ArchiveStore } from './archive-store.js';
import { logger } from './logger.js';

/** Synchronous eligibility recheck/unlink/DB mutation: no event-loop interleaving
 * between reference check and unlink. Call only after stopping a channel writer. */
export function pruneArchive(store: ArchiveStore, root: string, channelId: string, now = Date.now()): number {
  store.clearExpired(now);
  const archive = store.getArchive(channelId);
  if (!archive) return 0;
  const cutoff = now - archive.retentionHours * 3_600_000;
  let removed = 0;
  for (const candidate of store.prunable(channelId, cutoff, now)) {
    try {
      if (store.pruneChunk(channelId, candidate.id, now, chunk => {
        const absolute = path.resolve(root, chunk.path);
        if (!absolute.startsWith(path.resolve(root) + path.sep) || !chunk.path.endsWith('.ts') ||
          !fs.realpathSync(absolute).startsWith(fs.realpathSync(root) + path.sep) || !fs.statSync(absolute).isFile()) {
          throw new Error('Unsafe or missing chunk file');
        }
        fs.unlinkSync(absolute);
        if (fs.existsSync(absolute)) throw new Error('File still exists');
      })) removed++;
    } catch (error) { logger.warn(`Archive ${channelId}: retaining index for failed removal ${candidate.id}: ${error}`); }
  }
  return removed;
}
