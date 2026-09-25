import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fetchXtreamCategories } from './xtream';

let server: Server;
let origin: string;
let hits = 0;
beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    if (req.url?.startsWith('/ok/player_api.php')) res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
    else res.writeHead(302, { location: 'http://127.0.0.1:1/admin' }).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('Xtream API redirects', () => {
  it('fetches categories from a configured local source', async () => {
    const result = await fetchXtreamCategories({ server: `${origin}/ok`, username: 'user', password: 'pass' }, AbortSignal.timeout(2_000));
    expect(result).toEqual([]);
  });
  it('rejects a redirect to another private origin before contacting it', async () => {
    await expect(fetchXtreamCategories({ server: origin, username: 'user', password: 'pass' }, AbortSignal.timeout(2_000)))
      .rejects.toThrow('Redirect target is not allowed');
    expect(hits).toBeGreaterThan(0);
  });
});
