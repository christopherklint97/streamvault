import { it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArchiveStore, ensureArchiveSchema } from './archive-store.js';
import { ArchiveCapture } from './archive-capture.js';
import { buildArchiveVod } from './archive-hls.js';

it('captures a real TS stream into indexed independently decodable VOD chunks and seeks across them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-media-'));
  const fixture = path.join(root, 'fixture.ts');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '45', '-c:v', 'mpeg2video', '-g', '10',
    '-c:a', 'mp2', '-f', 'mpegts', fixture], { timeout: 30_000 });
  const server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer test-archive-token') { res.writeHead(401).end(); return; }
    res.setHeader('Content-Type', 'video/mp2t'); fs.createReadStream(fixture).pipe(res);
  });
  const previousToken = process.env.STREAMVAULT_AUTH_TOKEN;
  process.env.STREAMVAULT_AUTH_TOKEN = 'test-archive-token';
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address');
  const db = new Database(':memory:'); ensureArchiveSchema(db);
  const store = createArchiveStore(db); store.configure('one', 'One', true, 24);
  const capture = new ArchiveCapture(store, root, address.port);
  try {
    capture.start('one');
    const deadline = Date.now() + 12_000;
    while (store.overlap('one', 0, Date.now() + 100_000).length < 3 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const chunks = store.overlap('one', 0, Date.now() + 100_000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(fs.statSync(path.join(root, chunk.path)).size).toBeGreaterThan(188);
      execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path.join(root, chunk.path)], { timeout: 15_000 });
    }
    const playlist = path.join(root, 'finite.m3u8');
    fs.writeFileSync(playlist, buildArchiveVod(chunks, id => path.join(root, chunks.find(c => c.id === id)!.path)));
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '25', '-i', playlist, '-frames:v', '1', '-f', 'null', '-'], { timeout: 15_000 });
  } finally {
    await capture.stopAll();
    if (previousToken === undefined) delete process.env.STREAMVAULT_AUTH_TOKEN;
    else process.env.STREAMVAULT_AUTH_TOKEN = previousToken;
    await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
