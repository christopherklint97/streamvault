import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { precompressAssets } from './precompress-assets.mjs';

test('precompresses only JS/CSS assets, preserves originals and is deterministic', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'streamvault-precompress-'));
  try {
    await fs.mkdir(path.join(root, 'assets', 'nested'), { recursive: true });
    const content = Buffer.from('console.log("asset");'.repeat(100));
    await fs.writeFile(path.join(root, 'assets', 'main.js'), content);
    await fs.writeFile(path.join(root, 'assets', 'nested', 'style.css'), content);
    await fs.writeFile(path.join(root, 'assets', 'media.ts'), content);
    await fs.writeFile(path.join(root, 'sw.js'), content);
    await fs.symlink(path.join(root, 'sw.js'), path.join(root, 'assets', 'linked.js'));
    assert.equal(await precompressAssets(root), 2);
    const first = await fs.readFile(path.join(root, 'assets', 'main.js.gz'));
    assert.deepEqual(gunzipSync(first), content);
    assert.deepEqual(brotliDecompressSync(await fs.readFile(path.join(root, 'assets', 'main.js.br'))), content);
    assert.deepEqual(await fs.readFile(path.join(root, 'assets', 'main.js')), content);
    await assert.rejects(fs.access(path.join(root, 'sw.js.br')));
    await assert.rejects(fs.access(path.join(root, 'assets', 'media.ts.gz')));
    await assert.rejects(fs.access(path.join(root, 'assets', 'linked.js.br')));
    assert.equal(await precompressAssets(root), 2);
    assert.deepEqual(await fs.readFile(path.join(root, 'assets', 'main.js.gz')), first);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
