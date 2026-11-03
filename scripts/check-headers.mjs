#!/usr/bin/env node
// Post-deploy header check:  node scripts/check-headers.mjs https://vireek.com
// Fails (exit 1) when a required security header is missing or weak. Then run securityheaders.com and
// Mozilla Observatory yourself for the letter grade; this script cannot grade for you.
const base = (process.argv[2] ?? 'https://vireek.com').replace(/\/$/, '');
const res = await fetch(base + '/', { redirect: 'follow' });
const h = (k) => res.headers.get(k) ?? '';
const problems = [];
const hsts = h('strict-transport-security');
if (!(Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0) >= 31536000)) problems.push('HSTS max-age < 1 year or missing');
if (!hsts.includes('includeSubDomains')) problems.push('HSTS lacks includeSubDomains');
const csp = h('content-security-policy');
if (!csp) problems.push('CSP missing');
else {
  if (/script-src[^;]*'unsafe-(inline|eval)'/.test(csp)) problems.push("CSP script-src allows 'unsafe-inline' or 'unsafe-eval'");
  if (/style-src[^;]*'unsafe-inline'/.test(csp)) console.warn("WARN  CSP style-src allows 'unsafe-inline' (blocks an A+ on Mozilla Observatory)");
  if (!/object-src 'none'/.test(csp)) problems.push("CSP lacks object-src 'none'");
  if (!/frame-ancestors|x-frame-options/i.test(csp + h('x-frame-options'))) problems.push('No clickjacking protection');
}
if (h('x-content-type-options').toLowerCase() !== 'nosniff') problems.push('X-Content-Type-Options not nosniff');
if (!h('referrer-policy')) problems.push('Referrer-Policy missing');
if (!h('permissions-policy')) problems.push('Permissions-Policy missing');
for (const p of ['/.well-known/security.txt', '/llms.txt', '/llms-full.txt', '/changelog-atom.xml']) {
  const r = await fetch(base + p);
  if (!r.ok) problems.push(`${p} -> HTTP ${r.status}`);
}
if (problems.length) {
  console.error(problems.map((p) => 'FAIL  ' + p).join('\n'));
  process.exit(1);
}
console.log('check-headers OK for ' + base);
