import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { performance } from 'node:perf_hooks';
import type { DBChannel } from './db.js';
import type { BrowseRequest, BrowseResult, ChannelPageRequest, ChannelPageResult, DirectoryStatusSnapshot } from './channel-read-worker.js';

type Request = { id: number; op: 'byIds'; ids: string[] } | { id: number; op: 'status' } | { id: number; op: 'browse'; options: BrowseRequest } | { id: number; op: 'page'; options: ChannelPageRequest };
type Reply = { id: number; rows?: DBChannel[]; status?: DirectoryStatusSnapshot; browse?: BrowseResult; page?: ChannelPageResult; error?: string; durationMs?: number };

const db = new Database(workerData.dbPath as string, { readonly: true, fileMustExist: true });
const statements = new Map<number, ReturnType<typeof db.prepare>>();
parentPort?.on('message', (request: Request) => {
  const start = performance.now();
  try {
    if (request.op === 'status') {
      const configRows = db.prepare("SELECT key, value FROM config WHERE key IN ('input_mode', 'last_sync_time', 'last_crawl_time', 'xtream_server', 'xtream_username', 'xtream_password')").all() as Array<{ key: string; value: string }>;
      const config = new Map(configRows.map(row => [row.key, row.value]));
      const inputMode = config.get('input_mode') || 'xtream';
      const channelCount = (db.prepare('SELECT COUNT(*) AS count FROM channels').get() as { count: number }).count;
      const categoryRows = db.prepare('SELECT content_type FROM categories').all() as Array<{ content_type: string }>;
      const contentTypeCounts: Record<string, number> = {};
      if (inputMode === 'xtream') {
        for (const row of categoryRows) contentTypeCounts[row.content_type] = (contentTypeCounts[row.content_type] || 0) + 1;
      } else {
        const typeRows = db.prepare('SELECT content_type, COUNT(*) AS count FROM channels GROUP BY content_type').all() as Array<{ content_type: string; count: number }>;
        for (const row of typeRows) contentTypeCounts[row.content_type] = row.count;
      }
      const status: DirectoryStatusSnapshot = {
        channelCount,
        categoryCount: categoryRows.length,
        lastSyncTime: parseInt(config.get('last_sync_time') || '0', 10),
        lastCrawlTime: parseInt(config.get('last_crawl_time') || '0', 10),
        contentTypeCounts,
        crawlConfigured: !!(config.get('xtream_server') && config.get('xtream_username') && config.get('xtream_password')),
      };
      parentPort?.postMessage({ id: request.id, status, durationMs: performance.now() - start } satisfies Reply);
      return;
    }
    if (request.op === 'browse') {
      const { group, type, limit, after } = request.options;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid browse limit');
      const column = group && group !== 'All' ? 'grp' : 'content_type';
      const value = column === 'grp' ? group : type;
      if (!value) {
        parentPort?.postMessage({ id: request.id, browse: { channels: [], total: 0 }, durationMs: performance.now() - start } satisfies Reply);
        return;
      }
      const newest = type === 'movies' || type === 'series';
      const sort = newest ? 'added' : 'sort_order';
      const comparison = newest ? '<' : '>';
      const direction = newest ? 'DESC' : 'ASC';
      const cursor = after ? JSON.parse(after) as { a?: number; s?: number; n?: string; i?: string } : null;
      const position = newest ? cursor?.a : cursor?.s;
      if (cursor && (typeof position !== 'number' || typeof cursor.n !== 'string' || (cursor.i !== undefined && typeof cursor.i !== 'string'))) throw new Error('Invalid browse cursor');
      const cursorClause = cursor ? cursor.i === undefined
        ? ` AND (${sort} ${comparison} ? OR (${sort} = ? AND name > ?))`
        : ` AND (${sort} ${comparison} ? OR (${sort} = ? AND (name > ? OR (name = ? AND id > ?))))`
        : '';
      const sql = `SELECT * FROM channels WHERE ${column} = ?${cursorClause} ORDER BY ${sort} ${direction}, name, id LIMIT ?`;
      const channels = (cursor
        ? cursor.i === undefined
          ? db.prepare(sql).all(value, position, position, cursor.n, limit)
          : db.prepare(sql).all(value, position, position, cursor.n, cursor.n, cursor.i, limit)
        : db.prepare(sql).all(value, limit)) as DBChannel[];
      const total = (db.prepare(`SELECT COUNT(*) AS count FROM channels WHERE ${column} = ?`).get(value) as { count: number }).count;
      parentPort?.postMessage({ id: request.id, browse: { channels, total }, durationMs: performance.now() - start } satisfies Reply);
      return;
    }
    if (request.op === 'page') {
      const { group, limit, cursorSort, cursorName, cursorId, inputMode } = request.options;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid page limit');
      if ((cursorSort === undefined) !== (cursorName === undefined)) throw new Error('Invalid channel cursor');
      if (cursorId !== undefined && cursorName === undefined) throw new Error('Invalid channel cursor id');
      const grouped = !!group && group !== 'All';
      const where = grouped ? 'WHERE grp = ?' : '';
      const cursor = cursorSort === undefined ? '' : cursorId === undefined
        ? `${grouped ? ' AND' : ' WHERE'} (sort_order > ? OR (sort_order = ? AND name > ?))`
        : `${grouped ? ' AND' : ' WHERE'} (sort_order > ? OR (sort_order = ? AND (name > ? OR (name = ? AND id > ?))))`;
      const sql = `SELECT * FROM channels ${where}${cursor} ORDER BY sort_order, name, id LIMIT ?`;
      const cursorParams = cursorSort === undefined ? [] : cursorId === undefined
        ? [cursorSort, cursorSort, cursorName]
        : [cursorSort, cursorSort, cursorName, cursorName, cursorId];
      const params = [...(grouped ? [group] : []), ...cursorParams, limit];
      const channels = db.prepare(sql).all(params) as DBChannel[];
      const total = (db.prepare(`SELECT COUNT(*) AS count FROM channels ${where}`).get(...(grouped ? [group] : [])) as { count: number }).count;
      let groups: string[];
      const contentTypeCounts: Record<string, number> = {};
      if (inputMode === 'xtream') {
        const categories = db.prepare('SELECT name, content_type FROM categories ORDER BY name').all() as Array<{ name: string; content_type: string }>;
        groups = ['All', ...categories.map(cat => cat.name)];
        for (const cat of categories) contentTypeCounts[cat.content_type] = (contentTypeCounts[cat.content_type] || 0) + 1;
      } else {
        groups = ['All', ...(db.prepare("SELECT DISTINCT grp FROM channels WHERE grp != '' ORDER BY grp").all() as Array<{ grp: string }>).map(row => row.grp)];
        for (const row of db.prepare('SELECT content_type, COUNT(*) AS count FROM channels GROUP BY content_type').all() as Array<{ content_type: string; count: number }>) {
          contentTypeCounts[row.content_type] = row.count;
        }
      }
      const regions = ['All', ...(db.prepare("SELECT DISTINCT region FROM channels WHERE region != '' ORDER BY region").all() as Array<{ region: string }>).map(row => row.region)];
      parentPort?.postMessage({ id: request.id, page: { channels, total, groups, regions, contentTypeCounts }, durationMs: performance.now() - start } satisfies Reply);
      return;
    }
    if (request.ids.length > 200) throw new Error('Too many channel IDs');
    let statement = statements.get(request.ids.length);
    if (!statement) {
      const placeholders = request.ids.map(() => '?').join(',');
      statement = db.prepare(`SELECT * FROM channels WHERE id IN (${placeholders})`);
      statements.set(request.ids.length, statement);
    }
    const rows = statement.all(request.ids) as DBChannel[];
    parentPort?.postMessage({ id: request.id, rows, durationMs: performance.now() - start } satisfies Reply);
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies Reply);
  }
});
