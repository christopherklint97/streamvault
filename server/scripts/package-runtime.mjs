import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['live_packet_worker.py', 'live_packet_stitch.py']) {
  const target = path.join(root, 'dist', name);
  await fs.copyFile(path.join(root, 'src', name), target);
  // copyFile keeps the checkout's mode; a 0600 source is unreadable to the
  // unprivileged runtime user, so the packet-aware live worker cannot start.
  await fs.chmod(target, 0o644);
}
