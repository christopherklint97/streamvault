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
        const paths = [chunk.path, ...(chunk.playbackPath ? [chunk.playbackPath] : [])];
        const absolute = paths.map(relative => {
          const resolved = path.resolve(root, relative);
          if (!resolved.startsWith(path.resolve(root) + path.sep) || !relative.endsWith('.ts') ||
            !fs.realpathSync(resolved).startsWith(fs.realpathSync(root) + path.sep) || !fs.statSync(resolved).isFile()) {
            throw new Error('Unsafe or missing chunk file');
          }
          return resolved;
        });
        // Preflight both paths before removing either. A crash between unlinks
        // is reconciled on restart; an active pin never reaches this callback.
        for (const file of absolute.reverse()) {
          fs.unlinkSync(file);
          if (fs.existsSync(file)) throw new Error('File still exists');
        }
      })) removed++;
    } catch (error) { logger.warn(`Archive ${channelId}: retaining index for failed removal ${candidate.id}: ${error}`); }
  }
  return removed;
}
