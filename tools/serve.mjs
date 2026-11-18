#!/usr/bin/env node
// Dependency-free static server for the GUI. Serves the project root so
// /web/index.html can reach /assets and /src with correct MIME types.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function resolveSafe(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const path = decoded === '/' ? '/web/index.html' : decoded;
  const full = normalize(join(ROOT, path));
  if (!full.startsWith(ROOT + sep) && full !== ROOT) return null;
  if (path === '/') return join(ROOT, 'web', 'index.html');
  return full;
}

const server = createServer(async (req, res) => {
  const path = resolveSafe(req.url || '/');
  if (!path) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      res.writeHead(302, { location: path.replace(ROOT, '') .replace(/\\/g, '/') + '/' }).end();
      return;
    }
    const type = TYPES[extname(path)] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), info.size - 1) : info.size - 1;
        res.writeHead(206, {
          'content-type': type,
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${info.size}`,
          'accept-ranges': 'bytes',
        });
        res.end((await readFile(path)).subarray(start, end + 1));
        return;
      }
    }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'accept-ranges': 'bytes' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Sampling keyboard: http://${HOST}:${PORT}/`);
  console.log(`GUI:               http://${HOST}:${PORT}/web/index.html`);
});
