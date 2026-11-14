#!/usr/bin/env node
// Dev static server for web/ (Node built-ins only). The scope display is at /scope/.
// Use this until `swarm serve` (server/server.js) runs; that server's CSP needs the Matterport additions in
// docs/PROTOTYPE.md §9b before the 3D tour works there.
//
//   npm run web            → http://localhost:4174/scope/
//   PORT=5000 npm run web
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const PORT = Number(process.env.PORT) || 4174;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon'
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') { res.writeHead(302, { Location: '/scope/' }); return res.end(); }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = resolve(ROOT, '.' + rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end(`Not found: ${url.pathname}`); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(400); res.end('Bad request');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Scope display: http://localhost:${PORT}/scope/`);
});
