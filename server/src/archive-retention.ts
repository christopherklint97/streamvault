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
  // Dependent successor pairs have a later end. Retire them first so a
  // predecessor's shifted session remains valid until every dependent is gone.
  for (const id of store.retirablePairs(channelId, cutoff, now).reverse()) {
    try { store.retirePlaybackPair(channelId, id, now); }
    catch (error) { logger.warn(`Archive ${channelId}: retaining pair ${id}: ${error}`); }
  }
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
  for (const detached of store.detachedPlayback()) {
    try {
      const absolute = path.resolve(root, detached.path);
      if (!absolute.startsWith(path.resolve(root) + path.sep) || !detached.path.endsWith('.playback.ts'))
        throw new Error('Unsafe detached playback path');
      let exists = false;
      try { fs.lstatSync(absolute); exists = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (exists) {
        if (!fs.realpathSync(absolute).startsWith(fs.realpathSync(root) + path.sep) ||
          !fs.statSync(absolute).isFile()) throw new Error('Unsafe detached playback file');
        fs.unlinkSync(absolute);
      }
      // Only ENOENT from lstat verifies unlink or prior absence. existsSync
      // also returns false for dangling links and some inaccessible paths.
      try { fs.lstatSync(absolute); throw new Error('Detached playback file still exists'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      store.releaseDetachedPlayback(detached.path);
    } catch (error) { logger.warn(`Archive ${channelId}: retaining detached copy ${detached.path}: ${error}`); }
  }
  return removed;
}
