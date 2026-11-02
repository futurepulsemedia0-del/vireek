// scripts/brand-audit/lib/routes.mjs
//
// Route table for the crawler and link checker. Built on scripts/seo/routes.mjs so the audit can never
// drift from the sitemap/prerender classification (App.tsx stays the source of truth).

const PARAM = /:[A-Za-z0-9_]+/g;

/** '/blog/:slug' -> /^\/blog\/[^/]+\/?$/ ; '/home/*' -> /^\/home\/.*$/ ; '*' is the 404 and never matches. */
export function patternToRegex(pattern) {
  if (pattern === '*') return null;
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const withStar = esc.replace(/\/\*$/, '/.*');
  return new RegExp(`^${withStar.replace(PARAM, '[^/]+')}/?$`);
}

export function buildMatcher(paths) {
  const regexes = paths.filter((p) => p.startsWith('/')).map(patternToRegex).filter(Boolean);
  return (pathname) => regexes.some((r) => r.test(pathname));
}

/** Normalise an href to an internal pathname, or null when external / non-navigational. */
export function internalPath(href, origin) {
  if (!href) return null;
  const h = href.trim();
  if (/^(mailto:|tel:|sms:|javascript:|data:|blob:)/i.test(h)) return null;
  if (h.startsWith('#')) return null;
  try {
    const u = new URL(h, origin);
    if (u.origin !== new URL(origin).origin) return null;
    return u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
  } catch {
    return null;
  }
}

export async function loadRouteTable() {
  const r = await import('../../seo/routes.mjs'); // needs esbuild (installed with vite)
  const all = r.appRoutePaths();
  const privateStatic = all.filter((p) => r.classifyRoute(p) === 'private' && !p.includes(':') && p !== '*');
  const authPrefixes = ['/dashboard', '/tech', '/partner-portal', '/onboarding'];
  const authRoutes = privateStatic.filter((p) => authPrefixes.some((x) => p === x || p.startsWith(`${x}/`)));
  const staffRoutes = privateStatic.filter((p) => p === '/staff' || p.startsWith('/staff/'));
  return {
    all,
    isKnownPath: buildMatcher(all),
    publicStatic: r.STATIC_PUBLIC_PATHS.filter((p) => all.includes(p)),
    dataPatterns: r.DATA_ROUTE_PATTERNS.filter((p) => all.includes(p)),
    authRoutes,
    staffRoutes,
    classify: r.classifyRoute,
    siteUrl: r.SITE_URL,
    canonicalFor: r.canonicalFor,
    unclassified: all.filter((p) => r.classifyRoute(p) === null),
  };
}
