// Pure helpers for the 404 page: "did you mean" + local link search. No React.

export interface PopularLink {
  to: string;
  labelKey: string;
  fallback: string;
  keywords: string;
}

/** Curated, always-valid public destinations (each path is a registered route). */
export const POPULAR_LINKS: readonly PopularLink[] = [
  { to: '/', labelKey: 'navflow.nf.home', fallback: 'Home', keywords: 'home start main' },
  { to: '/features', labelKey: 'navflow.nf.features', fallback: 'Features', keywords: 'features product capabilities' },
  { to: '/pricing', labelKey: 'navflow.nf.pricing', fallback: 'Pricing', keywords: 'pricing plans cost price' },
  { to: '/industries', labelKey: 'navflow.nf.industries', fallback: 'Industries', keywords: 'industries trades hvac plumbing electrical' },
  { to: '/integrations', labelKey: 'navflow.nf.integrations', fallback: 'Integrations', keywords: 'integrations connect apps quickbooks' },
  { to: '/blog', labelKey: 'navflow.nf.blog', fallback: 'Blog', keywords: 'blog articles news guides' },
  { to: '/help', labelKey: 'navflow.nf.help', fallback: 'Help center', keywords: 'help support docs how to' },
  { to: '/faq', labelKey: 'navflow.nf.faq', fallback: 'FAQ', keywords: 'faq questions answers' },
  { to: '/contact', labelKey: 'navflow.nf.contact', fallback: 'Contact us', keywords: 'contact sales talk email' },
  { to: '/security', labelKey: 'navflow.nf.security', fallback: 'Security', keywords: 'security privacy trust' },
  { to: '/status', labelKey: 'navflow.nf.status', fallback: 'System status', keywords: 'status uptime incident' },
  { to: '/login', labelKey: 'navflow.nf.login', fallback: 'Sign in', keywords: 'login sign in account' },
  { to: '/signup', labelKey: 'navflow.nf.signup', fallback: 'Start free', keywords: 'signup register trial start' },
];

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Closest known paths to a mistyped one (distance <= 40% of length, at most `max`). */
export function suggestSimilar(pathname: string, candidates: readonly string[], max = 3): string[] {
  const clean = pathname.toLowerCase().split(/[?#]/)[0]!.replace(/\/+$/, '') || '/';
  const scored = candidates
    .map((c) => ({ c, d: levenshtein(clean, c) }))
    .filter(({ c, d }) => c !== clean && d <= Math.max(2, Math.floor(Math.max(clean.length, c.length) * 0.4)))
    .sort((x, y) => x.d - y.d || x.c.localeCompare(y.c));
  return scored.slice(0, max).map((s) => s.c);
}

/** Case-insensitive AND-match of every query word against label + keywords. */
export function filterLinks(query: string, links: readonly PopularLink[], labelOf: (l: PopularLink) => string): PopularLink[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...links];
  return links.filter((l) => {
    const hay = `${labelOf(l)} ${l.keywords}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
