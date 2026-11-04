// Cloudflare Worker that replaces what Vercel did for Vireek:
//   1. proxies the rewrites in vercel.json that point at Supabase (feeds, sitemap, badge-api, agent-card)
//   2. serves the built site from ./dist (prerendered pages + hashed assets)
//   3. falls back to the pristine /_spa.html for unknown app routes (dashboard etc.)
//   4. applies every header rule from vercel.json (CSP, HSTS, ...) — vercel.json stays the single source of truth
import vercel from '../vercel.json'

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
}
interface Rewrite {
  source: string
  destination: string
}
interface HeaderRule {
  source: string
  headers: { key: string; value: string }[]
}

const rewrites = (vercel as { rewrites: Rewrite[] }).rewrites
const headerRules = (vercel as { headers: HeaderRule[] }).headers

// Rewrites whose destination is another site (Supabase). The catch-all "/(.*)" -> /_spa.html is handled below.
const proxies = rewrites.filter((r) => /^https?:\/\//.test(r.destination))

// Vercel "source" patterns are regular expressions (e.g. "/((?!badge|embed/).*)"), so we can compile them directly.
const compiledHeaderRules = headerRules.map((rule) => ({
  re: new RegExp(`^${rule.source}$`),
  headers: rule.headers,
}))

function matchProxy(pathname: string, search: string): string | null {
  for (const r of proxies) {
    const dest = new URL(r.destination)
    if (r.source.endsWith('/:path*')) {
      const prefix = r.source.slice(0, -'/:path*'.length)
      if (pathname === prefix || pathname.startsWith(prefix + '/')) {
        const rest = pathname.slice(prefix.length) // "" or "/something"
        dest.pathname = dest.pathname.replace(/\/:path\*$/, '') + rest
        dest.pathname = dest.pathname.replace('/:path*', rest)
        mergeQuery(dest, search)
        return dest.toString()
      }
    } else if (pathname === r.source) {
      mergeQuery(dest, search)
      return dest.toString()
    }
  }
  return null
}

function mergeQuery(dest: URL, search: string) {
  if (!search) return
  new URLSearchParams(search).forEach((v, k) => dest.searchParams.append(k, v))
}

function withVercelHeaders(res: Response, pathname: string): Response {
  const out = new Response(res.body, res)
  for (const rule of compiledHeaderRules) {
    if (!rule.re.test(pathname)) continue
    for (const h of rule.headers) out.headers.set(h.key, h.value)
  }
  // Vite fingerprints everything in /assets/, so it is safe to cache forever.
  if (pathname.startsWith('/assets/') && res.status === 200) {
    out.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
  }
  return out
}

async function serveStatic(request: Request, env: Env, pathname: string): Promise<Response> {
  const url = new URL(request.url)
  const tryPaths: string[] = []
  if (pathname === '/') tryPaths.push('/index.html')
  else if (pathname.endsWith('/')) tryPaths.push(pathname + 'index.html')
  else tryPaths.push(pathname, pathname + '/index.html')

  for (const p of tryPaths) {
    url.pathname = p
    const res = await env.ASSETS.fetch(new Request(url.toString(), request))
    if (res.status !== 404) return res
  }

  // Missing file with an extension (e.g. a stale /assets/old-chunk.js) -> real 404, never the HTML shell.
  const last = pathname.split('/').pop() ?? ''
  if (last.includes('.')) return new Response('Not found', { status: 404 })

  // Unknown route -> pristine SPA shell (React Router takes over in the browser).
  url.pathname = '/_spa.html'
  const shell = await env.ASSETS.fetch(new Request(url.toString(), request))
  return new Response(shell.body, { status: 200, headers: shell.headers })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const { pathname } = url

    const target = matchProxy(pathname, url.search)
    if (target) {
      const upstream = await fetch(new Request(target, request))
      return withVercelHeaders(upstream, pathname)
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 })
    }
    const res = await serveStatic(request, env, pathname)
    return withVercelHeaders(res, pathname)
  },
}
