import type Database from 'better-sqlite3';

// Match browse filters AND ordering so a page never sorts the whole catalogue.
export function ensureBrowseIndexes(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_channels_type_newest ON channels(content_type, added DESC, name);
    CREATE INDEX IF NOT EXISTS idx_channels_group_newest ON channels(grp, added DESC, name);
    CREATE INDEX IF NOT EXISTS idx_channels_type_order ON channels(content_type, sort_order, name);
    CREATE INDEX IF NOT EXISTS idx_channels_group_order ON channels(grp, sort_order, name);
    CREATE INDEX IF NOT EXISTS idx_channels_order ON channels(sort_order, name);
  `);
}

/** Keep substring search on the catalog fast as it grows. */
export function ensureChannelSearchIndex(db: InstanceType<typeof Database>): void {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channels_fts'").get();
  db.transaction(() => {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS channels_fts
      USING fts5(name, content='channels', content_rowid='rowid', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS channels_fts_insert AFTER INSERT ON channels BEGIN
        INSERT INTO channels_fts(rowid, name) VALUES (new.rowid, new.name);
      END;
      CREATE TRIGGER IF NOT EXISTS channels_fts_delete AFTER DELETE ON channels BEGIN
        INSERT INTO channels_fts(channels_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
      END;
      CREATE TRIGGER IF NOT EXISTS channels_fts_update AFTER UPDATE OF name ON channels BEGIN
        INSERT INTO channels_fts(channels_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
        INSERT INTO channels_fts(rowid, name) VALUES (new.rowid, new.name);
      END;
    `);
    if (!exists) db.exec("INSERT INTO channels_fts(channels_fts) VALUES ('rebuild')");
  })();
}
