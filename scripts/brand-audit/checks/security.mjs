// checks/security.mjs — security headers (read from vercel.json) + privacy UX surface.
// Reads CONFIG, not a live server: production/staging headers must also be verified with the crawler's --base-url mode.
import { tryRead, exists, finding, combine, round1 } from '../lib/util.mjs';

/** Pure: headers that would apply to `pathname` (later rules override earlier, like Vercel). */
export function effectiveHeaders(config, pathname) {
  const out = {};
  for (const rule of config.headers ?? []) {
    let re;
    try { re = new RegExp(`^${rule.source.replace(/\.(?!\*)/g, '\\.')}$`); } catch { continue; }
    if (!re.test(pathname)) continue;
    for (const h of rule.headers ?? []) out[h.key.toLowerCase()] = h.value;
  }
  return out;
}

export function parseCsp(csp) {
  return Object.fromEntries(String(csp ?? '').split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [n, ...v] = d.split(/\s+/); return [n, v]; }));
}

/** Pure: CSP quality 0-100 with the reasons for every deduction. */
export function cspQuality(csp) {
  if (!csp) return { score: 0, issues: ['No Content-Security-Policy on the app shell'] };
  const d = parseCsp(csp);
  const issues = [];
  let score = 100;
  const hit = (pts, msg) => { score -= pts; issues.push(msg); };
  const script = d['script-src'] ?? d['default-src'] ?? [];
  if (script.includes("'unsafe-eval'")) hit(25, "script-src allows 'unsafe-eval'");
  if (script.includes("'unsafe-inline'") && !script.some((v) => /^'(sha\d+-|nonce-)/.test(v))) hit(25, "script-src allows 'unsafe-inline' without hashes/nonces");
  if (script.includes('*') || script.includes('https:') || script.includes('http:')) hit(20, 'script-src allows any host');
  if (!d['object-src'] || !d['object-src'].includes("'none'")) hit(10, "object-src is not 'none'");
  if (!d['base-uri']) hit(8, 'base-uri missing');
  if (!d['frame-ancestors']) hit(10, 'frame-ancestors missing');
  if (!d['form-action']) hit(5, 'form-action missing');
  if (!('upgrade-insecure-requests' in d)) hit(5, 'upgrade-insecure-requests missing');
  return { score: Math.max(0, score), issues };
}

export async function run() {
  const findings = [];
  const components = [];
  const metrics = {};
  const raw = tryRead('vercel.json');
  let config = null;
  let parseError = null;
  if (raw === null) parseError = 'vercel.json not found';
  else try { config = JSON.parse(raw); } catch (e) { parseError = e.message; }

  if (parseError) {
    components.push({ name: 'vercel.json parses', weight: 25, score: 0, detail: parseError });
    components.push({ name: 'Required headers present on the app shell', weight: 30, score: 0, detail: 'unverifiable while the config is unparseable — none can be applied' });
    components.push({ name: 'CSP quality', weight: 20, score: 0, detail: 'unverifiable' });
    findings.push(finding({ id: 'security/vercel-json-invalid', category: 'security', severity: 'critical', title: 'vercel.json is not valid JSON — no security headers can be deployed', detail: parseError, refs: [{ file: 'vercel.json' }], count: 1 }));
  } else {
    components.push({ name: 'vercel.json parses', weight: 25, score: 100, detail: 'valid JSON' });
    const h = effectiveHeaders(config, '/');
    const checks = {
      'Strict-Transport-Security': (v) => /max-age=(\d+)/.test(v ?? '') && Number(/max-age=(\d+)/.exec(v)[1]) >= 15552000 && /includeSubDomains/i.test(v),
      'X-Content-Type-Options': (v) => /nosniff/i.test(v ?? ''),
      'Referrer-Policy': (v) => Boolean(v),
      'Content-Security-Policy': (v) => Boolean(v),
      'Permissions-Policy': (v) => Boolean(v),
      'Frame protection (X-Frame-Options or frame-ancestors)': () => Boolean(h['x-frame-options']) || Boolean(parseCsp(h['content-security-policy'])['frame-ancestors']),
    };
    const results = Object.entries(checks).map(([name, fn]) => [name, fn(h[name.toLowerCase()])]);
    const ok = results.filter(([, p]) => p).length;
    metrics.headersPresent = `${ok}/${results.length}`;
    components.push({ name: 'Required headers present on the app shell', weight: 30, score: round1((100 * ok) / results.length), detail: results.map(([n, p]) => `${p ? '✓' : '✗'} ${n}`).join(' · ') });
    for (const [n, p] of results) if (!p) findings.push(finding({ id: `security/missing-${n.split(' ')[0].toLowerCase()}`, category: 'security', severity: 'high', title: `Missing or weak header on the app shell: ${n}`, refs: [{ file: 'vercel.json' }], count: 1 }));
    const q = cspQuality(h['content-security-policy']);
    metrics.cspScore = q.score;
    components.push({ name: 'CSP quality', weight: 20, score: q.score, detail: q.issues.join('; ') || 'no weaknesses found' });
    for (const i of q.issues) findings.push(finding({ id: 'security/csp', category: 'security', severity: 'high', title: `CSP: ${i}`, refs: [{ file: 'vercel.json' }], count: 1 }));
  }

  // Disclosure + tooling
  const txt = tryRead('public/.well-known/security.txt');
  const exp = /^Expires:\s*(\S+)/m.exec(txt ?? '')?.[1];
  const expired = exp ? new Date(exp) < new Date() : true;
  const tools = [
    ['security.txt present and not expired', Boolean(txt) && !expired],
    ['.gitleaks.toml', exists('.gitleaks.toml')],
    ['security workflow', exists('.github/workflows/security.yml')],
    ['dependabot', exists('.github/dependabot.yml')],
  ];
  components.push({ name: 'Disclosure + security tooling', weight: 10, score: round1((100 * tools.filter(([, p]) => p).length) / tools.length), detail: tools.map(([n, p]) => `${p ? '✓' : '✗'} ${n}`).join(' · ') });
  if (txt && expired) findings.push(finding({ id: 'security/security-txt-expired', category: 'security', severity: 'medium', title: `security.txt Expires (${exp}) is in the past`, refs: [{ file: 'public/.well-known/security.txt' }], count: 1 }));

  // Privacy UX (static)
  const app = tryRead('src/App.tsx') ?? '';
  const priv = [
    ['consent engine', exists('src/lib/consent/engine.ts')],
    ['consent e2e (no tracker before consent)', exists('e2e/consent.spec.ts')],
    ['/privacy route', /path="\/privacy"/.test(app)],
    ['/cookies route', /path="\/cookies"/.test(app)],
    ['/ccpa route', /path="\/ccpa"/.test(app)],
    ['/data-request route', /path="\/data-request"/.test(app)],
  ];
  components.push({ name: 'Privacy UX surface (consent + privacy pages)', weight: 15, score: round1((100 * priv.filter(([, p]) => p).length) / priv.length), detail: priv.map(([n, p]) => `${p ? '✓' : '✗'} ${n}`).join(' · ') });
  for (const [n, p] of priv) if (!p) findings.push(finding({ id: 'security/privacy-missing', category: 'security', severity: 'medium', title: `Privacy UX gap: ${n}`, refs: [], count: 1 }));
  return { category: 'security', components, metrics, findings };
}
export { combine };
