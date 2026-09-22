// @vitest-environment node
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createCategorySnapshotWriter } from './channel-snapshot.js';

function createTestDatabase(verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void): InstanceType<typeof Database> {
  const db = new Database(':memory:', verbose ? { verbose } : undefined);
  db.exec(`
    CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      logo TEXT DEFAULT '',
      grp TEXT DEFAULT '',
      region TEXT DEFAULT '',
      content_type TEXT DEFAULT 'livetv',
      category_id TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      added INTEGER DEFAULT 0,
      epg_channel_id TEXT DEFAULT ''
    );
    CREATE INDEX idx_channels_category_id ON channels(category_id);
  `);
  return db;
}

describe('category channel snapshots', () => {
  it('atomically replaces one category without disturbing another category', () => {
    const db = createTestDatabase();
    db.prepare(`
      INSERT INTO channels
        (id, name, url, logo, grp, region, content_type, category_id, sort_order, added, epg_channel_id)
      VALUES
        ('keep-and-update', 'Old name', 'old-url', '', 'Old group', '', 'movies', 'vod_1', 1, 10, ''),
        ('remove', 'Stale', 'stale-url', '', 'Old group', '', 'movies', 'vod_1', 2, 20, ''),
        ('other-category', 'Other', 'other-url', '', 'Other group', '', 'movies', 'vod_2', 1, 30, '')
    `).run();

    const writeSnapshot = createCategorySnapshotWriter(db);
    writeSnapshot('vod_1', [
      {
        id: 'keep-and-update',
        name: 'New name',
        url: 'new-url',
        logo: 'new-logo',
        grp: 'New group',
        region: 'SE',
        content_type: 'movies',
        category_id: 'ignored-input-category',
        sort_order: 5,
        added: 50,
        epg_channel_id: 'guide-new',
      },
      {
        id: 'new',
        name: 'New movie',
        url: 'movie-url',
        logo: '',
        grp: 'New group',
        region: '',
        content_type: 'movies',
        category_id: 'vod_1',
        sort_order: 6,
        added: 60,
      },
    ]);

    const rows = db.prepare(`
      SELECT id, name, url, logo, grp, region, content_type, category_id, sort_order, added, epg_channel_id
      FROM channels ORDER BY id
    `).all();
    expect(rows).toEqual([
      {
        id: 'keep-and-update', name: 'New name', url: 'new-url', logo: 'new-logo', grp: 'New group', region: 'SE',
        content_type: 'movies', category_id: 'vod_1', sort_order: 5, added: 50, epg_channel_id: 'guide-new',
      },
      {
        id: 'new', name: 'New movie', url: 'movie-url', logo: '', grp: 'New group', region: '',
        content_type: 'movies', category_id: 'vod_1', sort_order: 6, added: 60, epg_channel_id: '',
      },
      {
        id: 'other-category', name: 'Other', url: 'other-url', logo: '', grp: 'Other group', region: '',
        content_type: 'movies', category_id: 'vod_2', sort_order: 1, added: 30, epg_channel_id: '',
      },
    ]);
    db.close();
  });

  it('rejects blank or duplicate channel ids without changing the category', () => {
    const db = createTestDatabase();
    db.prepare(`
      INSERT INTO channels
        (id, name, url, logo, grp, region, content_type, category_id, sort_order, added)
      VALUES ('existing', 'Existing', 'existing-url', '', 'Movies', '', 'movies', 'vod_1', 1, 10)
    `).run();
    const writeSnapshot = createCategorySnapshotWriter(db);
    const validChannel = {
      id: 'duplicate', name: 'Movie', url: 'movie-url', logo: '', grp: 'Movies', region: '',
      content_type: 'movies', category_id: 'vod_1', sort_order: 1, added: 10,
    };

    expect(() => writeSnapshot('vod_1', [{ ...validChannel, id: '' }])).toThrow(/channel id/i);
    expect(() => writeSnapshot('vod_1', [validChannel, { ...validChannel, name: 'Duplicate' }])).toThrow(/duplicate/i);
    expect(db.prepare('SELECT id FROM channels ORDER BY id').all()).toEqual([{ id: 'existing' }]);
    db.close();
  });

  it('writes a large snapshot with a bounded number of SQLite calls', () => {
    const statements: string[] = [];
    const db = createTestDatabase((message) => statements.push(String(message)));
    statements.length = 0;
    const channels = Array.from({ length: 3_000 }, (_, index) => ({
      id: `movie-${index}`,
      name: `Movie ${index}`,
      url: `https://provider.example/movie/${index}.mp4`,
      logo: '',
      grp: 'Movies',
      region: '',
      content_type: 'movies',
      category_id: 'vod_large',
      sort_order: index,
      added: index,
    }));

    createCategorySnapshotWriter(db)('vod_large', channels);

    const channelMutations = statements.filter(sql => (
      /^\s*INSERT INTO channels/i.test(sql) || /^\s*DELETE FROM channels/i.test(sql)
    ));
    expect(channelMutations).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS count FROM channels').get()).toEqual({ count: 3_000 });
    db.close();
  });
});
