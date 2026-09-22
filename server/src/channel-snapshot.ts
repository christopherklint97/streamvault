import type Database from 'better-sqlite3';

export interface CategorySnapshotChannel {
  id: string;
  name: string;
  url: string;
  logo: string;
  grp: string;
  region: string;
  content_type: string;
  category_id?: string;
  sort_order?: number;
  added?: number;
  epg_channel_id?: string;
}

export function createCategorySnapshotWriter(db: InstanceType<typeof Database>) {
  const upsertSnapshot = db.prepare(`
    INSERT INTO channels
      (id, name, url, logo, grp, region, content_type, category_id, sort_order, added, epg_channel_id)
    SELECT
      json_extract(value, '$.id'),
      json_extract(value, '$.name'),
      json_extract(value, '$.url'),
      COALESCE(json_extract(value, '$.logo'), ''),
      COALESCE(json_extract(value, '$.grp'), ''),
      COALESCE(json_extract(value, '$.region'), ''),
      COALESCE(json_extract(value, '$.content_type'), 'livetv'),
      ?,
      COALESCE(json_extract(value, '$.sort_order'), 0),
      COALESCE(json_extract(value, '$.added'), 0),
      COALESCE(json_extract(value, '$.epg_channel_id'), '')
    FROM json_each(?)
    WHERE true
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      url = excluded.url,
      logo = excluded.logo,
      grp = excluded.grp,
      region = excluded.region,
      content_type = excluded.content_type,
      category_id = excluded.category_id,
      sort_order = excluded.sort_order,
      added = excluded.added,
      epg_channel_id = excluded.epg_channel_id
    WHERE channels.name IS NOT excluded.name
       OR channels.url IS NOT excluded.url
       OR channels.logo IS NOT excluded.logo
       OR channels.grp IS NOT excluded.grp
       OR channels.region IS NOT excluded.region
       OR channels.content_type IS NOT excluded.content_type
       OR channels.category_id IS NOT excluded.category_id
       OR channels.sort_order IS NOT excluded.sort_order
       OR channels.added IS NOT excluded.added
       OR channels.epg_channel_id IS NOT excluded.epg_channel_id
  `);
  const deleteStale = db.prepare(`
    DELETE FROM channels
    WHERE category_id = ?
      AND id NOT IN (
        SELECT json_extract(value, '$.id')
        FROM json_each(?)
      )
  `);

  return db.transaction((categoryId: string, channels: readonly CategorySnapshotChannel[]) => {
    const ids = new Set<string>();
    for (const channel of channels) {
      if (typeof channel.id !== 'string' || channel.id.trim() === '') {
        throw new Error('Category snapshot contains an invalid channel id');
      }
      if (ids.has(channel.id)) throw new Error(`Category snapshot contains duplicate channel id: ${channel.id}`);
      ids.add(channel.id);
    }
    const payload = JSON.stringify(channels);
    upsertSnapshot.run(categoryId, payload);
    deleteStale.run(categoryId, payload);
  });
}
