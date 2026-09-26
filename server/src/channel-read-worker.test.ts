// @vitest-environment node
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChannelReadWorker } from './channel-read-worker.js';

describe('channel read worker', () => {
  it('looks up selected channels without blocking the HTTP event loop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-channel-read-'));
    const dbPath = path.join(dir, 'channels.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT, grp TEXT, content_type TEXT, sort_order INTEGER, added INTEGER)');
    db.prepare('INSERT INTO channels VALUES (?, ?, ?, ?, ?, ?)').run('one', 'BBC One', 'EU | UK | GENERAL', 'livetv', 1, 0);
    db.prepare('INSERT INTO channels VALUES (?, ?, ?, ?, ?, ?)').run('two', 'BBC Two', 'EU | UK | GENERAL', 'livetv', 2, 0);
    db.close();
    const reader = createChannelReadWorker(dbPath);
    try {
      const pending = reader.byIds(['two']);
      let timerFired = false;
      await new Promise<void>(resolve => setTimeout(() => { timerFired = true; resolve(); }, 0));
      expect(timerFired).toBe(true);
      expect((await pending).map(channel => channel.name)).toEqual(['BBC Two']);
      expect(await reader.byIds([])).toEqual([]);
    } finally {
      await reader.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads sync dashboard totals away from the HTTP event loop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-channel-status-'));
    const dbPath = path.join(dir, 'channels.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE channels (id TEXT PRIMARY KEY, content_type TEXT); CREATE TABLE categories (content_type TEXT); CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO channels VALUES (?, ?)').run('one', 'livetv');
    db.prepare('INSERT INTO categories VALUES (?)').run('livetv');
    db.prepare('INSERT INTO config VALUES (?, ?)').run('last_sync_time', '123');
    db.close();
    const reader = createChannelReadWorker(dbPath);
    try {
      expect(await reader.status()).toEqual({
        channelCount: 1, categoryCount: 1, lastSyncTime: 123, lastCrawlTime: 0,
        contentTypeCounts: { livetv: 1 }, crawlConfigured: false,
      });
    } finally {
      await reader.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('paginates a UK group without reading the whole channel catalog on the HTTP thread', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-channel-browse-'));
    const dbPath = path.join(dir, 'channels.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT, grp TEXT, content_type TEXT, sort_order INTEGER, added INTEGER)');
    const insert = db.prepare('INSERT INTO channels VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('first', 'BBC One', 'EU | UK | GENERAL', 'livetv', 1, 0);
    insert.run('second', 'BBC Two', 'EU | UK | GENERAL', 'livetv', 2, 0);
    insert.run('other', 'Other', 'EU | UK | SPORTS', 'livetv', 1, 0);
    db.close();
    const reader = createChannelReadWorker(dbPath);
    try {
      const page = await reader.browse({ group: 'EU | UK | GENERAL', type: 'livetv', limit: 1 });
      expect(page.total).toBe(2);
      expect(page.channels.map(channel => channel.id)).toEqual(['first']);
      expect((await reader.browse({ group: 'EU | UK | GENERAL', type: 'livetv', limit: 1, after: JSON.stringify({ s: 1, n: 'BBC One' }) })).channels.map(channel => channel.id)).toEqual(['second']);
    } finally {
      await reader.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('continues a channel page across equal sort orders and names', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-tie-page-'));
    const dbPath = path.join(dir, 'channels.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT, grp TEXT, region TEXT, content_type TEXT, sort_order INTEGER, added INTEGER); CREATE TABLE categories (name TEXT, content_type TEXT)');
    const insert = db.prepare('INSERT INTO channels VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run('a', 'BBC One', 'UK', 'UK', 'livetv', 1, 0);
    insert.run('b', 'BBC One', 'UK', 'UK', 'livetv', 1, 0);
    db.close();
    const reader = createChannelReadWorker(dbPath);
    try {
      const first = await reader.page({ limit: 1, inputMode: 'manual' });
      expect(first.channels.map(channel => channel.id)).toEqual(['a']);
      const next = await reader.page({ limit: 1, inputMode: 'manual', cursorSort: 1, cursorName: 'BBC One', cursorId: 'a' });
      expect(next.channels.map(channel => channel.id)).toEqual(['b']);
      const browse = await reader.browse({ group: 'UK', type: 'livetv', limit: 1, after: JSON.stringify({ s: 1, n: 'BBC One', i: 'a' }) });
      expect(browse.channels.map(channel => channel.id)).toEqual(['b']);
    } finally {
      await reader.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps the legacy channel list while preserving metadata and a cursor', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamvault-channel-page-'));
    const dbPath = path.join(dir, 'channels.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT, grp TEXT, region TEXT, content_type TEXT, sort_order INTEGER, added INTEGER); CREATE TABLE categories (name TEXT, content_type TEXT)');
    const insert = db.prepare('INSERT INTO channels VALUES (?, ?, ?, ?, ?, ?, ?)');
    insert.run('first', 'BBC One', 'EU | UK | GENERAL', 'UK', 'livetv', 1, 0);
    insert.run('second', 'BBC Two', 'EU | UK | GENERAL', 'UK', 'livetv', 2, 0);
    db.close();
    const reader = createChannelReadWorker(dbPath);
    try {
      const page = await reader.page({ limit: 1, inputMode: 'manual' });
      expect(page.channels.map(channel => channel.id)).toEqual(['first']);
      expect(page).toMatchObject({ total: 2, groups: ['All', 'EU | UK | GENERAL'], regions: ['All', 'UK'], contentTypeCounts: { livetv: 2 } });
      expect((await reader.page({ limit: 1, inputMode: 'manual', cursorSort: 1, cursorName: 'BBC One', cursorId: 'first' })).channels.map(channel => channel.id)).toEqual(['second']);
    } finally {
      await reader.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
