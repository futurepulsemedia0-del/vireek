// Local mock AP portal used ONLY by tests. In-memory, no network beyond localhost, no real vendor behaviour.
// Start:  node e2e/mock-portal/server.mjs   (PORT=4010; MOCK_MFA=1 shows an MFA challenge after login; MOCK_CAPTCHA=1 shows a CAPTCHA)
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export function createMockPortal({ mfa = false, captcha = false, user = 'vendor', pass = 'correct-horse' } = {}) {
  const sessions = new Set();
  const invoices = new Map();      // ref -> { invoice, status, reason }
  const byNumber = new Map();      // invoice number -> ref (duplicate guard, like a real AP portal)
  const log = [];                  // request log lets tests assert that credentials never travel anywhere unexpected
  const page = (body) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Mock AP</title><body>${body}</body></html>`;
  const read = (req) => new Promise((res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => res(d)); });
  const form = (s) => Object.fromEntries(new URLSearchParams(s));
  const authed = (req) => sessions.has(/sid=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    log.push(`${req.method} ${url.pathname}`);
    const send = (code, body, headers = {}) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...headers }); res.end(body); };
    if (req.method === 'GET' && url.pathname === '/login') {
      return send(200, page(`<form method="post" action="/login"><input id="u" name="u"><input id="p" name="p" type="password"><button id="login" type="submit">Sign in</button></form>`));
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      const f = form(await read(req));
      if (f.u !== user || f.p !== pass) return send(401, page('<p id="msg">Invalid credentials</p>'));
      const sid = randomUUID(); sessions.add(sid);
      if (mfa) return send(200, page('<div data-challenge="mfa">Enter the code we texted you</div>'), { 'Set-Cookie': `sid=${sid}; HttpOnly; Path=/` });
      return send(302, '', { Location: '/invoice/new', 'Set-Cookie': `sid=${sid}; HttpOnly; Path=/` });
    }
    if (captcha && url.pathname === '/invoice/new') return send(200, page('<div data-challenge="captcha">Prove you are human</div>'));
    if (!authed(req) && url.pathname.startsWith('/invoice')) return send(302, '', { Location: '/login' });
    if (req.method === 'GET' && url.pathname === '/invoice/new') {
      return send(200, page(`<form method="post" action="/invoice"><input id="inv" name="inv"><input id="amt" name="amt"><button id="send" type="submit">Submit invoice</button></form>`));
    }
    if (req.method === 'POST' && url.pathname === '/invoice') {
      const f = form(await read(req));
      if (!f.inv || !/^\d+(\.\d{2})?$/.test(f.amt ?? '')) return send(422, page('<p id="msg">Invalid invoice</p>'));
      if (byNumber.has(f.inv)) return send(409, page('<p id="msg">Duplicate invoice number</p>'));
      const ref = `MP-${invoices.size + 1001}`; invoices.set(ref, { invoice: f.inv, status: 'Received', reason: '' }); byNumber.set(f.inv, ref);
      return send(302, '', { Location: `/invoice/${ref}` });
    }
    const m = /^\/invoice\/(MP-\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const r = invoices.get(m[1]); if (!r) return send(404, page('Not found'));
      return send(200, page(`<span id="ref">${m[1]}</span><span id="status">${r.status}</span><span id="reason">${r.reason.replace(/[<>&]/g, '')}</span>`));
    }
    if (req.method === 'POST' && url.pathname === '/__admin/status') {          // test control only
      const b = JSON.parse(await read(req)); const r = invoices.get(b.ref);
      if (!r) return send(404, '{}'); r.status = b.status; r.reason = b.reason ?? '';
      if (b.status === 'Rejected') byNumber.delete(r.invoice);                   // a rejected invoice may be resubmitted
      return send(200, '{}');
    }
    if (req.method === 'GET' && url.pathname === '/__admin/log') return send(200, JSON.stringify(log));
    send(404, page('Not found'));
  });
  return { server, invoices, log, listen: (port = 0) => new Promise((r) => server.listen(port, '127.0.0.1', () => r(server.address().port))), close: () => new Promise((r) => server.close(r)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const p = createMockPortal({ mfa: process.env.MOCK_MFA === '1', captcha: process.env.MOCK_CAPTCHA === '1' });
  p.listen(Number(process.env.PORT ?? 4010)).then((port) => console.log(`mock portal on http://127.0.0.1:${port}`));
}
