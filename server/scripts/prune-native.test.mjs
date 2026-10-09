import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const script = fileURLToPath(new URL('./prune-native.mjs', import.meta.url));
const source = fileURLToPath(new URL('../node_modules/better-sqlite3', import.meta.url));
test('retains only the loaded native target, runtime JS and licenses, with a fresh-process SQLite proof', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'streamvault-native-prune-'));
  try {
    const clone = path.join(root, 'better-sqlite3');
    await fs.cp(source, clone, { recursive: true });
    execFileSync(process.execPath, [script, clone]);
    assert.equal((await fs.readdir(path.join(clone, 'prebuilds'))).filter(file => file.endsWith('.node')).length, 1);
    await assert.rejects(fs.access(path.join(clone, 'deps')));
    await assert.rejects(fs.access(path.join(clone, 'src')));
    await fs.access(path.join(clone, 'LICENSE'));
    const probe = execFileSync(process.execPath, ['-e', `const db=require(${JSON.stringify(clone)})(':memory:');console.log(db.prepare('select 1 as ok').get().ok);db.close();`], { encoding: 'utf8' });
    assert.equal(probe.trim(), '1');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
