import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, gzip, constants } from 'node:zlib';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/** Build-time only: leave original bytes and service-worker revisions unchanged. */
export async function precompressAssets(directory) {
  let count = 0;
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /\.(?:js|css)$/.test(entry.name)) {
        const bytes = await fs.readFile(file);
        await fs.writeFile(file + '.gz', await gzipAsync(bytes, { level: 9 }));
        await fs.writeFile(file + '.br', await brotliAsync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
        count++;
      }
    }
  }
  await visit(path.join(path.resolve(directory), 'assets'));
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const count = await precompressAssets(process.argv[2] || 'dist');
  console.log(`Precompressed ${count} JS/CSS assets (Brotli + gzip)`);
}
