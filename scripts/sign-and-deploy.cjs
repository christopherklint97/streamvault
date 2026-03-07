#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const crypto = require('crypto');

const TV_IP = process.env.TV_IP;
if (!TV_IP) {
  console.error('Usage: TV_IP=192.168.x.x node scripts/sign-and-deploy.cjs');
  process.exit(1);
}

const PROJECT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_DIR, 'dist');
const WGT_FILE = path.join(PROJECT_DIR, 'StreamVault.wgt');
const APP_ID = 'Streamvault.StreamVault';
const DEVICE = `${TV_IP}:26101`;
const REMOTE_PATH = '/home/owner/share/tmp/sdk_tools/StreamVault.wgt';

// Step 1: Build
console.log('Building StreamVault...');
execSync('npm run build', { cwd: PROJECT_DIR, stdio: 'inherit' });

// Step 2: Sign using tizen-tv-dev-cli's signPackage (skip the buggy buildPackage)
console.log('Signing package...');
const signPackage = require('tizen-tv-dev-cli/signPackage');
signPackage.signPackage(DIST_DIR);
console.log('Signing complete.');

// Step 3: Package as .wgt (zip with signatures included)
console.log('Creating .wgt...');
if (fs.existsSync(WGT_FILE)) fs.unlinkSync(WGT_FILE);

// Use zip command to create wgt from dist dir (includes author-signature.xml and signature1.xml)
execSync(`cd "${DIST_DIR}" && zip -r "${WGT_FILE}" . -x '*.map'`, { stdio: 'inherit' });

// Clean up signature files from dist
for (const f of ['author-signature.xml', 'signature1.xml', 'signature2.xml', '.manifest.tmp']) {
  const p = path.join(DIST_DIR, f);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

console.log(`Signed package: ${WGT_FILE}`);

// Step 4: Connect
console.log(`\nConnecting to TV at ${TV_IP}...`);
execSync(`sdb connect ${TV_IP}`, { stdio: 'inherit' });

function sdb(args) {
  const cmd = `sdb -s ${DEVICE} ${args}`;
  console.log(`> ${cmd}`);
  return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });
}

// Step 5: Push
console.log('Pushing .wgt to TV...');
const pushResult = sdb(`push "${WGT_FILE}" ${REMOTE_PATH}`);
console.log(pushResult.trim());

// Step 6: Install
console.log('Installing app...');
const installResult = sdb(`shell 0 vd_appinstall ${APP_ID} ${REMOTE_PATH}`);
console.log(installResult.trim());

// Step 7: Launch
console.log('Launching app...');
const launchResult = sdb(`shell 0 was_launch ${APP_ID}`);
console.log(launchResult.trim());

console.log('\nDone! StreamVault should be running on your TV.');
