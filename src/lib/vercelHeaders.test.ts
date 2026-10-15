import { describe, expect, it } from 'vitest'
import vercelRaw from '../../vercel.json?raw'

interface HeaderRule {
  source: string
  headers: { key: string; value: string }[]
}
const config = JSON.parse(vercelRaw) as { headers: HeaderRule[] }

const headerValue = (key: string, sourceIncludes: string): string => {
  const rule = config.headers.find(
    (r) => r.source.includes(sourceIncludes) && r.headers.some((h) => h.key === key),
  )
  const value = rule?.headers.find((h) => h.key === key)?.value
  if (!value) throw new Error(`Header ${key} not found for source containing "${sourceIncludes}"`)
  return value
}

const parseCsp = (csp: string): Record<string, string[]> =>
  Object.fromEntries(
    csp
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...values] = d.split(/\s+/)
        return [name, values]
      }),
  )

const parsePermissions = (value: string): Record<string, string[]> =>
  Object.fromEntries(
    value.split(',').map((item) => {
      const [name, allow = ''] = item.trim().split('=')
      const inner = allow.replace(/^\(/, '').replace(/\)$/, '').trim()
      return [name, inner ? inner.match(/"[^"]*"|\S+/g)!.map((v) => v.replace(/"/g, '')) : []]
    }),
  )

const MAP_HOST = 'https://tiles.openfreemap.org'

describe('vercel.json security headers', () => {
  const csp = parseCsp(headerValue('Content-Security-Policy', '(?!badge)'))
  const perms = parsePermissions(headerValue('Permissions-Policy', '(?!badge)'))

  it('allows Stripe.js and Payment Request endpoints', () => {
    expect(csp['script-src']).toContain('https://js.stripe.com')
    expect(csp['frame-src']).toEqual(
      expect.arrayContaining(['https://js.stripe.com', 'https://hooks.stripe.com']),
    )
    expect(csp['connect-src']).toContain('https://api.stripe.com')
  })

  it('allows the map tile host and the font hosts', () => {
    expect(csp['connect-src']).toContain(MAP_HOST)
    expect(csp['img-src']).toEqual(expect.arrayContaining(['https:', 'blob:']))
    expect(csp['worker-src']).toContain('blob:')
    expect(csp['style-src']).toContain('https://fonts.googleapis.com')
    expect(csp['font-src']).toContain('https://fonts.gstatic.com')
  })

  it('keeps script-src hash/nonce based and never weakens it', () => {
    const scriptSrc = csp['script-src']
    expect(scriptSrc).not.toContain("'unsafe-inline'")
    expect(scriptSrc).not.toContain("'unsafe-eval'")
    expect(scriptSrc).not.toContain('*')
    expect(scriptSrc).not.toContain('https:')
    expect(scriptSrc.some((v) => /^'(sha(256|384|512)-|nonce-)/.test(v))).toBe(true)
    expect(scriptSrc.filter((v) => v.startsWith("'sha256-")).length).toBeGreaterThanOrEqual(3)
  })

  it('has only valid CSP directive names (no stray source tokens)', () => {
    const known = new Set([
      'default-src', 'script-src', 'style-src', 'font-src', 'img-src', 'manifest-src',
      'connect-src', 'frame-src', 'worker-src', 'object-src', 'base-uri', 'form-action',
      'frame-ancestors', 'upgrade-insecure-requests',
    ])
    for (const name of Object.keys(csp)) expect(known.has(name), name).toBe(true)
  })

  it('keeps the hardening directives intact', () => {
    expect(csp['default-src']).toEqual(["'self'"])
    expect(csp['object-src']).toEqual(["'none'"])
    expect(csp['base-uri']).toEqual(["'self'"])
    expect(csp['form-action']).toEqual(["'self'"])
    expect(csp['frame-ancestors']).toEqual(["'none'"])
    expect(csp['upgrade-insecure-requests']).toEqual([])
    expect(headerValue('X-Frame-Options', '(?!badge)')).toBe('DENY')
  })

  it('enables payment and geolocation only for self (plus Stripe for payment)', () => {
    expect(perms.geolocation).toEqual(['self'])
    expect(perms.payment).toEqual(expect.arrayContaining(['self', 'https://js.stripe.com']))
    expect(perms.payment).not.toContain('*')
    expect(perms.microphone).toEqual(['self'])
    expect(perms.camera).toEqual(['self'])
    for (const feature of ['usb', 'midi', 'magnetometer', 'gyroscope', 'interest-cohort']) {
      expect(perms[feature]).toEqual([])
    }
  })

  it('keeps the embeddable /badge policy separate and unchanged', () => {
    const badge = parseCsp(headerValue('Content-Security-Policy', '/badge'))
    expect(badge['frame-ancestors']).toEqual(['*'])
    expect(badge['script-src']).toBeUndefined()
  })
})
