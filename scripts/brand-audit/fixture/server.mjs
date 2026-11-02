// Tiny static + API server for the crawler self-test. Counts POSTs so the test can prove the read-only guard works.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), 'site');
const PAGES = { '/': 'index.html', '/bad': 'bad.html', '/login': 'login.html', '/dashboard': 'dashboard.html' };

export function startFixture(port = 0) {
  const hits = { loginPosts: 0, writePosts: 0, badLogin: 0 };
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (req.method === 'POST' && path === '/api/login') {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
        const { email, password } = JSON.parse(b || '{}');
        if (email === 'audit@example.test' && password === 'correct horse') { hits.loginPosts++; res.writeHead(200).end('{}'); } else { hits.badLogin++; res.writeHead(401).end('{}'); }
      });
      return;
    }
    if (req.method === 'POST' && path === '/api/write') { hits.writePosts++; return res.writeHead(200).end('{}'); }
    const file = PAGES[path];
    if (req.method === 'GET' && file && existsSync(join(SITE, file))) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(join(SITE, file))); return; }
    res.writeHead(404).end('not found');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(r)) })));
}
