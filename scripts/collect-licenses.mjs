// Copy the license and notice files of a project's production dependency tree.
// The frontend bundle (public/ in the image) inlines these packages, so their
// license texts must ship next to it; node_modules itself never reaches runtime.
//
//   node scripts/collect-licenses.mjs [PROJECT_DIR] [OUT_DIR]
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const out = resolve(process.argv[3] ?? 'third-party-licenses');
const noticeFile = /^(licen[cs]e|copying|notice|authors|patents)([.-].*)?$/i;

// npm ls exits non-zero for cosmetic tree problems; the parseable list is still complete.
const ls = spawnSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8' });
if (ls.error) throw ls.error;
const dirs = [...new Set(ls.stdout.split('\n').map(line => line.trim()).filter(Boolean))]
  .filter(dir => resolve(dir) !== root);
if (dirs.length === 0) throw new Error(`No production dependencies found under ${root}`);

mkdirSync(out, { recursive: true });
const index = ['package\tversion\tlicense\tfiles'];
for (const dir of dirs.sort()) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'UNKNOWN';
  const files = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && noticeFile.test(entry.name))
    .map(entry => entry.name)
    .sort();
  const target = join(out, `${pkg.name.replace('/', '__')}@${pkg.version}`);
  mkdirSync(target, { recursive: true });
  for (const file of files) copyFileSync(join(dir, file), join(target, file));
  index.push([pkg.name, pkg.version, license, files.join(',') || '(none shipped; see package.json license)'].join('\t'));
}
writeFileSync(join(out, 'INDEX.tsv'), index.join('\n') + '\n');
console.log(JSON.stringify({ packages: dirs.length, out }));
