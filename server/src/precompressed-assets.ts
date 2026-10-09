import type { RequestHandler } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';

async function isFile(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw error;
  }
}

/** Mount only at /assets; media routes and byte ranges retain identity semantics. */
export function servePrecompressedAssets(root: string): RequestHandler {
  const directory = path.resolve(root);
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let pathname: string;
    try { pathname = decodeURIComponent(req.path); } catch { return next(); }
    if (!/\.(?:js|css)$/.test(pathname)) return next();
    const original = path.resolve(directory, '.' + pathname);
    if (!original.startsWith(directory + path.sep)) return next();
    try {
      if (!await isFile(original)) return next();
      res.vary('Accept-Encoding');
      // A Range addresses the original bytes, never a compressed representation.
      if (req.headers.range) {
        if (!req.acceptsEncodings(['identity'])) return res.status(406).end();
        return next();
      }
      const available: string[] = [];
      if (await isFile(original + '.br')) available.push('br');
      if (await isFile(original + '.gz')) available.push('gzip');
      available.push('identity');
      const encoding = req.acceptsEncodings(available);
      if (!encoding) return res.status(406).end();
      if (encoding === 'identity') return next();
      res.type(path.extname(original));
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.sendFile(path.relative(directory, original + (encoding === 'br' ? '.br' : '.gz')), {
        root: directory, dotfiles: 'deny', acceptRanges: false, cacheControl: false,
      }, error => {
        if (!error) return;
        if (!res.headersSent) res.removeHeader('Content-Encoding');
        next(error);
      });
    } catch (error) {
      next(error);
    }
  };
}
