// src/lib/brand/endorsement.ts
//
// Platform endorsement line ("Part of {parent}") — pure logic, ZERO imports, ZERO env access.
// Runs unchanged in the browser (Vite), in Node build scripts (esbuild) and in Supabase edge
// functions (Deno), so every platform-owned surface derives the line from one place.
//
// Scope rule: the endorsement is a PLATFORM-owned signal only. It must never appear on tenant
// documents or tenant-branded surfaces. Callers pass raw values from their own environment
// (see platformEndorsement.ts for the client, email-kit/endorsement.ts for edge functions).

export const ENDORSEMENT_TEMPLATE = 'Part of {parent}';
export const MAX_PARENT_NAME_LENGTH = 80;
export const MAX_PARENT_URL_LENGTH = 200;

export interface RawEndorsementInput {
  enabled?: string | null;
  parentName?: string | null;
  parentUrl?: string | null;
}

export interface BrandEndorsement {
  /** The platform flag, parsed strictly. */
  enabled: boolean;
  /** Sanitized parent name; null when unset or invalid. */
  parentName: string | null;
  /** https-only parent URL; null when unset or invalid. */
  parentUrl: string | null;
  /** The rendered line, or null when the feature is off OR no parent name is set. */
  line: string | null;
}

export const DISABLED_ENDORSEMENT: BrandEndorsement = Object.freeze({
  enabled: false,
  parentName: null,
  parentUrl: null,
  line: null,
});

/** Strict boolean: only "true" or "1" (any case, trimmed) enable it. Anything else is OFF. */
export function parseEnabled(raw: string | null | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

/**
 * Returns a clean display name, or null. Control characters, angle brackets and template
 * braces are rejected (not stripped) so a bad value can never render as half a name.
 */
export function sanitizeParentName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F-\u009F<>{}]/.test(raw.replace(/\s/g, ' '))) return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length === 0 || name.length > MAX_PARENT_NAME_LENGTH) return null;
  return name;
}

/** https URLs only, no embedded credentials. Returns the normalized href, or null. */
export function sanitizeParentUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_PARENT_URL_LENGTH) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

export function formatEndorsementLine(parentName: string): string {
  return ENDORSEMENT_TEMPLATE.replace('{parent}', parentName);
}

/** Flag OFF or parent unset/invalid -> `line` is null and nothing downstream renders. */
export function resolveEndorsement(raw: RawEndorsementInput): BrandEndorsement {
  const enabled = parseEnabled(raw.enabled);
  if (!enabled) return DISABLED_ENDORSEMENT;
  const parentName = sanitizeParentName(raw.parentName);
  if (!parentName) return { enabled: true, parentName: null, parentUrl: null, line: null };
  return {
    enabled: true,
    parentName,
    parentUrl: sanitizeParentUrl(raw.parentUrl),
    line: formatEndorsementLine(parentName),
  };
}

/**
 * schema.org Organization node with parentOrganization. Returns null unless the endorsement
 * actually renders, so flag OFF (or parent unset) adds nothing to any page.
 */
export function buildParentOrganizationJsonLd(
  endorsement: BrandEndorsement,
  brand: { name: string; url: string },
): Record<string, unknown> | null {
  if (!endorsement.line || !endorsement.parentName) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: brand.name,
    url: brand.url,
    parentOrganization: {
      '@type': 'Organization',
      name: endorsement.parentName,
      ...(endorsement.parentUrl ? { url: endorsement.parentUrl } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Surface allowlist (fail-closed)
// ---------------------------------------------------------------------------
// The shared <Footer> is also mounted by tenant/customer-facing pages (quote, booking, signing,
// portals...). Those must never show the endorsement, so the Footer asks this function instead of
// assuming. Anything not listed here — including every token route and any page added later — is
// denied. Mirror of STATIC_PUBLIC_PATHS in scripts/seo/routes.mjs; a test keeps them in sync.

export const ENDORSEMENT_EXACT_PATHS: readonly string[] = [
  '/', '/audit', '/privacy', '/cookies', '/terms', '/dpa', '/subprocessors', '/refund-policy', '/sla',
  '/acceptable-use-policy', '/responsible-ai', '/trademark-policy', '/vulnerability-disclosure',
  '/ccpa', '/accessibility-statement', '/gdpr-dpa', '/faq', '/help', '/about', '/manifesto',
  '/leadership', '/docs', '/blog', '/report', '/podcast', '/glossary', '/testimonials', '/contact',
  '/services', '/features', '/features/lead-qualification', '/features/sms-text-back',
  '/features/whatsapp-instagram-dm', '/features/live-escalation', '/platform', '/compare',
  '/compare/matrix', '/switch', '/ai-receptionist-vs-human-receptionist', '/open-voice-benchmark',
  '/industries', '/pricing', '/enterprise', '/marketplace', '/sdks', '/developers/changelog', '/demo',
  '/calculator', '/security', '/trust', '/integrations', '/status', '/case-studies', '/changelog',
  '/roadmap', '/accessibility', '/accessibility/conformance', '/careers', '/talent', '/culture',
  '/press', '/brand', '/partners', '/affiliate', '/referral', '/beta', '/webinars', '/roi',
  '/system-requirements', '/sitemap',
  // legal pages that are platform-owned but not in the sitemap list
  '/legal/company', '/impressum', '/msa', '/ai-disclosure', '/dmca', '/sms-terms', '/data-request',
];

export const ENDORSEMENT_PATH_PREFIXES: readonly string[] = [
  '/blog/', '/industries/', '/compare/', '/integrations/', '/switch/', '/locations/',
];

export function normalizePath(pathname: string): string {
  const bare = (pathname.split(/[?#]/)[0] ?? '').toLowerCase();
  return bare.length > 1 ? bare.replace(/\/+$/, '') : bare || '/';
}

export function isEndorsementSurfacePath(pathname: string): boolean {
  const p = normalizePath(pathname);
  return ENDORSEMENT_EXACT_PATHS.includes(p) || ENDORSEMENT_PATH_PREFIXES.some((x) => p.startsWith(x));
}
