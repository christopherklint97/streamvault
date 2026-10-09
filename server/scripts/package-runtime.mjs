import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['live_packet_worker.py', 'live_packet_stitch.py']) {
  await fs.copyFile(path.join(root, 'src', name), path.join(root, 'dist', name));
}
