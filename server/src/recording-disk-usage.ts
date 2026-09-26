import fs from 'node:fs/promises';
import path from 'node:path';

/** Traverse the recording volume via libuv so slow USB I/O cannot stall HTTP dispatch. */
export async function measureDiskUsage(root: string): Promise<number> {
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        try { total += (await fs.stat(full)).size; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  };
  await walk(root);
  return total;
}

/** Return the last measurement immediately, refreshing it only in the background. */
export function createDiskUsageCache(
  load: () => Promise<number>,
  now: () => number = Date.now,
  ttlMs = 10_000,
  warn: (error: unknown) => void = () => {},
) {
  let value = 0;
  let measuredAt = -Infinity;
  let pending = false;
  return {
    get(): number {
      if (!pending && now() - measuredAt >= ttlMs) {
        pending = true;
        setImmediate(() => {
          void Promise.resolve().then(load).then(size => {
            value = size;
            measuredAt = now();
          }).catch(warn).finally(() => { pending = false; });
        });
      }
      return value;
    },
  };
}
