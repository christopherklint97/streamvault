// Clean, non-root application startup is a separate gate from worker fixtures.
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

const image = process.argv[2];
if (!image) throw new Error('Usage: node scripts/smoke-docker-startup.mjs IMAGE');
const name = `streamvault-boot-${process.pid}-${randomUUID()}`;
const volumes = [];
let container;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  for (const suffix of ['data', 'recordings']) volumes.push(docker('volume', 'create', `${name}-${suffix}`));
  container = docker('run', '-d', '--name', name, '--init', '--cpus=1', '--memory=512m', '--memory-swap=512m', '--pids-limit=128', '--cap-drop=ALL', '--security-opt=no-new-privileges', '-e', 'LOG_LEVEL=warn', '--mount', `type=volume,src=${volumes[0]},dst=/app/data`, '--mount', `type=volume,src=${volumes[1]},dst=/app/data/recordings`, image);
  const deadline = Date.now() + 30_000;
  let ready = 0;
  let lastError;
  while (Date.now() < deadline) {
    if (docker('inspect', '--format', '{{.State.Running}}', container) !== 'true') {
      const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8', timeout: 15_000 });
      throw new Error('Application exited during clean startup:\n' + logs.stdout + logs.stderr);
    }
    try {
      docker('exec', container, 'node', '-e', "fetch('http://127.0.0.1:3001/api/health',{signal:AbortSignal.timeout(1000)}).then(async r=>{const body=await r.json();if(!r.ok||body.ok!==true)process.exit(1)}).catch(()=>process.exit(1))");
      ready++;
    } catch (error) { ready = 0; lastError = error; }
    if (ready >= 2) {
      const uid = docker('exec', container, 'node', '-e', 'console.log(process.getuid())');
      if (uid !== '1000') throw new Error(`Application probe unexpectedly runs as UID ${uid}`);
      docker('exec', container, 'node', '-e', "const fs=require('node:fs');for(const dir of ['/app/data','/app/data/recordings']){if(fs.statSync(dir).uid!==process.getuid())throw new Error('Unexpected volume owner: '+dir);const file=dir+'/.streamvault-write-probe';fs.writeFileSync(file,'writable',{flag:'wx'});fs.unlinkSync(file)}");
      console.log(JSON.stringify({ ok: true, image, uid: 1000, cleanStartup: true, freshNamedVolumes: 2, writableData: true, writableRecordings: true }));
      break;
    }
    await delay(300);
  }
  if (ready < 2) throw new Error('Application health did not become ready: ' + String(lastError));
} finally {
  try { if (container) docker('rm', '-f', container); }
  finally { for (const volume of volumes) docker('volume', 'rm', volume); }
}
