// Pure, dependency-free routing helpers for worker/index.ts (unit-tested in scripts/seo/worker-routing.test.mjs).
// Kept free of Cloudflare types so it can run under plain Node.

export const APEX_HOST = 'vireek.com'
export const WWW_HOST = `www.${APEX_HOST}`

/** www.vireek.com -> https://vireek.com (same path + query). Returns null when no redirect is needed. */
export function wwwRedirect(url: URL): string | null {
  if (url.hostname !== WWW_HOST) return null
  return `https://${APEX_HOST}${url.pathname}${url.search}`
}

/** /pricing/ -> /pricing (the canonical URLs have no trailing slash). "/" itself is never redirected. */
export function trailingSlashRedirect(url: URL): string | null {
  const { pathname } = url
  if (pathname === '/' || !pathname.endsWith('/')) return null
  const clean = pathname.replace(/\/+$/, '')
  if (clean === '') return null
  return `${url.origin}${clean}${url.search}`
}

export interface AppRoutesManifest {
  /** Every route pattern declared in src/App.tsx, e.g. "/blog/:slug", "/home/*". */
  patterns: string[]
  /** SPA-only areas whose sub-routes are never judged here (e.g. "/dashboard"). */
  passthroughPrefixes: string[]
  /**
   * Data-driven patterns whose every valid URL is prerendered to a static file (e.g. "/blog/:slug"). A request that
   * matches one of these but reached the fallback has no file, so the slug does not exist -> real 404.
   */
  prerenderedPatterns?: string[]
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function patternToRegExp(pattern: string): RegExp | null {
  if (pattern === '*' || pattern === '/*') return null
  const wildcard = pattern.endsWith('/*')
  const base = wildcard ? pattern.slice(0, -2) : pattern
  const body = base
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : escapeRe(seg)))
    .join('/')
  return new RegExp(`^${body}${wildcard ? '(?:/.*)?' : ''}/?$`)
}

/** Returns a predicate: does this pathname belong to a real route of the app? */
export function compileAppRoutes(manifest: AppRoutesManifest): (pathname: string) => boolean {
  const res = manifest.patterns.map(patternToRegExp).filter((r): r is RegExp => r !== null)
  const strict = (manifest.prerenderedPatterns ?? []).map(patternToRegExp).filter((r): r is RegExp => r !== null)
  const prefixes = manifest.passthroughPrefixes
  return (pathname: string) => {
    if (prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return true
    if (strict.some((re) => re.test(pathname))) return false
    return res.some((re) => re.test(pathname))
  }
}

/** Defensive parse of dist/app-routes.json — returns null on any shape problem so callers fall back safely. */
export function parseAppRoutes(raw: unknown): AppRoutesManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const { patterns, passthroughPrefixes, prerenderedPatterns } = raw as Record<string, unknown>
  const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')
  if (!isStrArr(patterns) || patterns.length < 10 || !isStrArr(passthroughPrefixes)) return null
  if (prerenderedPatterns !== undefined && !isStrArr(prerenderedPatterns)) return null
  return { patterns, passthroughPrefixes, ...(prerenderedPatterns ? { prerenderedPatterns } : {}) }
}
