import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const directory = fs.realpathSync(process.argv[2] || path.join(process.cwd(), 'node_modules', 'better-sqlite3'));
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'better-sqlite3', 'Refuse to prune a different package');
const db = require(directory)(':memory:');
assert.equal(db.prepare('select 1 as ok').get().ok, 1);
db.close();
const prebuilds = path.join(directory, 'prebuilds') + path.sep;
const selected = Object.keys(require.cache).find(file => file.startsWith(prebuilds) && file.endsWith('.node'));
assert.ok(selected, 'Expected a packaged native prebuild; do not prune an unknown binding layout');
for (const file of fs.readdirSync(path.join(directory, 'prebuilds'))) {
  const candidate = path.join(directory, 'prebuilds', file);
  if (file.endsWith('.node') && candidate !== selected) fs.unlinkSync(candidate);
}
for (const name of ['deps', 'src', 'build', 'binding.gyp']) {
  fs.rmSync(path.join(directory, name), { recursive: true, force: true });
}
console.log(`Retained SQLite native binding: ${path.basename(selected)}`);
