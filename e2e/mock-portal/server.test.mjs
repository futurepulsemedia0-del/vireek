// node --test e2e/mock-portal/server.test.mjs   (no browser needed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockPortal } from './server.mjs';

async function login(base, pass = 'correct-horse') {
  const r = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ u: 'vendor', p: pass }) });
  return { r, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] };
}
test('mock portal: submit -> duplicate refused -> reject -> resubmit -> approve', async () => {
  const p = createMockPortal(); const port = await p.listen(); const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await login(base, 'wrong')).r.status, 401);
    const { cookie } = await login(base);
    const post = (inv) => fetch(`${base}/invoice`, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ inv, amt: '1500.00' }) });
    const first = await post('INV-1'); assert.equal(first.status, 302); const ref = first.headers.get('location').split('/').pop();
    assert.equal((await post('INV-1')).status, 409);
    await fetch(`${base}/__admin/status`, { method: 'POST', body: JSON.stringify({ ref, status: 'Rejected', reason: 'Missing PO' }) });
    assert.match(await (await fetch(`${base}/invoice/${ref}`, { headers: { Cookie: cookie } })).text(), /Missing PO/);
    const again = await post('INV-1'); assert.equal(again.status, 302);
    const ref2 = again.headers.get('location').split('/').pop(); assert.notEqual(ref2, ref);
    await fetch(`${base}/__admin/status`, { method: 'POST', body: JSON.stringify({ ref: ref2, status: 'Approved' }) });
    assert.match(await (await fetch(`${base}/invoice/${ref2}`, { headers: { Cookie: cookie } })).text(), /Approved/);
    assert.equal((await fetch(`${base}/invoice/new`, { redirect: 'manual' })).status, 302);          // unauthenticated -> login
  } finally { await p.close(); }
});
test('mock portal: MFA and CAPTCHA show the challenge markers the runner pauses on', async () => {
  const m = createMockPortal({ mfa: true }); const pm = await m.listen();
  try { assert.match(await (await login(`http://127.0.0.1:${pm}`)).r.text(), /data-challenge="mfa"/); } finally { await m.close(); }
  const c = createMockPortal({ captcha: true }); const pc = await c.listen();
  try { const { cookie } = await login(`http://127.0.0.1:${pc}`); assert.match(await (await fetch(`http://127.0.0.1:${pc}/invoice/new`, { headers: { Cookie: cookie } })).text(), /data-challenge="captcha"/); } finally { await c.close(); }
});
