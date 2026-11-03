// Agent Readiness — outbound-fetch safety. Pure (no imports, no Deno APIs) so it is unit-testable.
// The edge functions call these BEFORE every request and again for every redirect hop.

export type UrlRejection = 'empty' | 'too_long' | 'bad_url' | 'bad_scheme' | 'credentials' | 'bad_port' | 'ip_literal' | 'blocked_host';

const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home', '.corp', '.test', '.invalid', '.example'];

export function parsePublicUrl(input: string): { ok: true; url: URL } | { ok: false; code: UrlRejection } {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, code: 'empty' };
  if (raw.length > 2048) return { ok: false, code: 'too_long' };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { return { ok: false, code: 'bad_url' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, code: 'bad_scheme' };
  if (url.username || url.password) return { ok: false, code: 'credentials' };
  if (url.port && url.port !== '80' && url.port !== '443') return { ok: false, code: 'bad_port' };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host.startsWith('[') || host.includes(':') || /^[\d.]+$/.test(host)) return { ok: false, code: 'ip_literal' };
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, code: 'blocked_host' };
  url.hash = '';
  return { ok: true, url };
}

/** True only for globally routable unicast addresses. Anything unparseable is treated as NOT public. */
export function isPublicIp(ip: string): boolean {
  const s = ip.trim().toLowerCase();
  if (s.includes(':')) return isPublicIpv6(s);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if ([a, b, c, Number(m[4])].some((n) => n > 255)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(s: string): boolean {
  if (s === '::' || s === '::1') return false;
  if (s.startsWith('::ffff:') || s.startsWith('64:ff9b:')) return false; // v4-mapped / NAT64: never legitimate DNS answers here
  if (/^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff')) return false; // ULA, link-local, multicast
  if (s.startsWith('2001:db8') || s.startsWith('2001:0db8')) return false;
  return /^[0-9a-f:]+$/.test(s);
}

// ---- robots.txt (RFC 9309 subset: UA groups, Allow/Disallow, longest match, * and $) ----
export function robotsAllows(robotsTxt: string, userAgentToken: string, path: string): boolean {
  const token = userAgentToken.toLowerCase();
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const lineRaw of robotsTxt.split(/\r?\n/)) {
    const line = lineRaw.replace(/#.*$/, '').trim();
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
    } else lastWasAgent = false;
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const applicable = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  let best: { allow: boolean; len: number } | null = null;
  for (const g of applicable) {
    for (const rule of g.rules) {
      if (!patternMatches(rule.pattern, path)) continue;
      const len = rule.pattern.length;
      if (!best || len > best.len || (len === best.len && rule.allow)) best = { allow: rule.allow, len };
    }
  }
  return best ? best.allow : true;
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(`^${body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`);
  return re.test(path);
}
