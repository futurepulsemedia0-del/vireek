// src/lib/landingPageUtils.ts
//
// Pure helpers for the landing-page builder. No I/O and no Supabase import on
// purpose, so everything here is trivially unit-testable.

export type LandingStatus = 'draft' | 'published' | 'archived';
export type CtaMode = 'lead_form' | 'booking' | 'both';
export type DomainStatus = 'pending' | 'verified' | 'failed';

export interface LandingSection {
  title: string;
  body: string;
}

export interface LandingPage {
  id: string;
  user_id: string;
  slug: string;
  title: string;
  headline: string;
  subheadline: string | null;
  body: string | null;
  sections: LandingSection[];
  cta_label: string;
  cta_mode: CtaMode;
  accent_color: string;
  seo_title: string | null;
  seo_description: string | null;
  status: LandingStatus;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LandingDomain {
  id: string;
  user_id: string;
  domain: string;
  landing_page_id: string | null;
  verification_token: string;
  status: DomainStatus;
  verified_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface LandingPageDraft {
  title: string;
  slug: string;
  headline: string;
  subheadline: string;
  body: string;
  sections: LandingSection[];
  cta_label: string;
  cta_mode: CtaMode;
  accent_color: string;
  seo_title: string;
  seo_description: string;
}

export type DraftErrors = Partial<Record<keyof LandingPageDraft, string>>;

// Mirrors the CHECK constraints in the migration.
export const DRAFT_LIMITS = {
  title: 120,
  headline: 160,
  subheadline: 300,
  body: 5000,
  ctaLabel: 40,
  seoTitle: 70,
  seoDescription: 170,
  sectionTitle: 80,
  sectionBody: 400,
  maxSections: 6,
} as const;

// ------------------------------------------------------------------
// Slug / domain
// ------------------------------------------------------------------

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

export function isValidSlug(slug: string): boolean {
  return slug.length >= 3 && slug.length <= 60 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const BLOCKED_DOMAIN_SUFFIXES = ['.vercel.app', '.supabase.co', '.local', '.localhost', '.internal'];

export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  d = d.split(/[/?#]/)[0] ?? '';
  d = d.replace(/:\d+$/, '').replace(/\.$/, '');
  return d;
}

export function isValidDomain(domain: string): boolean {
  return domain.length <= 253 && DOMAIN_RE.test(domain);
}

export type DomainCheck = { ok: true; domain: string } | { ok: false; reason: 'invalid' | 'reserved' };

export function validateCustomDomain(input: string, appHosts: string[]): DomainCheck {
  const domain = normalizeDomain(input);
  if (!isValidDomain(domain)) return { ok: false, reason: 'invalid' };
  if (BLOCKED_DOMAIN_SUFFIXES.some((s) => domain.endsWith(s))) return { ok: false, reason: 'reserved' };
  if (appHosts.some((h) => domain === h || domain.endsWith(`.${h}`))) return { ok: false, reason: 'reserved' };
  return { ok: true, domain };
}

// Must match supabase/functions/landing-domain-verify/index.ts
export const TXT_CHALLENGE_PREFIX = '_vireek-challenge';
export const TXT_VALUE_PREFIX = 'vireek-verify=';
export const txtRecordName = (domain: string): string => `${TXT_CHALLENGE_PREFIX}.${domain}`;
export const txtRecordValue = (token: string): string => `${TXT_VALUE_PREFIX}${token}`;

export function parseAppHosts(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * True when this hostname is a customer's custom domain (NOT the Vireek app).
 * Fail-safe: with no VITE_APP_HOSTS configured the gate is disabled, so a
 * missing env var can never hijack the main app.
 */
export function isCustomLandingHost(hostname: string, appHosts: string[]): boolean {
  const h = hostname.toLowerCase();
  if (appHosts.length === 0) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.localhost') || h.endsWith('.vercel.app')) return false;
  return !appHosts.some((a) => h === a || h === `www.${a}` || h.endsWith(`.${a}`));
}

export function getPageUrl(
  page: { id: string; slug: string },
  domains: Pick<LandingDomain, 'domain' | 'status' | 'landing_page_id'>[],
  origin: string,
): string {
  const custom = domains.find((d) => d.status === 'verified' && d.landing_page_id === page.id);
  return custom ? `https://${custom.domain}` : `${origin}/lp/${page.slug}`;
}

// ------------------------------------------------------------------
// Attribution (UTM / click-id / referrer)
// ------------------------------------------------------------------

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
const CLICK_ID_KEYS = ['gclid', 'fbclid', 'msclkid', 'ttclid'] as const;
const ATTRIBUTION_KEYS = [...UTM_KEYS, 'click_id', 'referrer'] as const;
const MAX_ATTR_LEN = 200;
const ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface Attribution {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  click_id?: string;
  referrer?: string;
}

function stripControlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) out += ch;
  }
  return out;
}

export function sanitizeAttrValue(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = stripControlChars(value).trim().slice(0, MAX_ATTR_LEN);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function parseAttributionFromSearch(search: string): Attribution {
  const params = new URLSearchParams(search);
  const out: Attribution = {};
  for (const key of UTM_KEYS) {
    const v = sanitizeAttrValue(params.get(key))?.toLowerCase();
    if (v) out[key] = v;
  }
  for (const key of CLICK_ID_KEYS) {
    const v = sanitizeAttrValue(params.get(key));
    if (v) {
      out.click_id = sanitizeAttrValue(`${key}:${v}`);
      break;
    }
  }
  return out;
}

/** Referrer reduced to `host/path` (no query string, no own-site traffic). */
export function sanitizeReferrer(referrer: string | null | undefined, ownHost: string): string | undefined {
  if (!referrer) return undefined;
  try {
    const url = new URL(referrer);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === ownHost.toLowerCase().replace(/^www\./, '')) return undefined;
    return sanitizeAttrValue(`${host}${url.pathname === '/' ? '' : url.pathname}`);
  } catch {
    return undefined;
  }
}

export function hasAttribution(a: Attribution | null | undefined): boolean {
  return !!a && Object.values(a).some((v) => typeof v === 'string' && v.length > 0);
}

/** Fresh attribution on this visit wins; otherwise fall back to the stored one. */
export function resolveAttribution(current: Attribution, stored: Attribution | null): Attribution {
  return hasAttribution(current) ? current : (stored ?? {});
}

export function serializeStoredAttribution(a: Attribution, now: number): string {
  return JSON.stringify({ a, t: now });
}

export function parseStoredAttribution(raw: string | null, now: number): Attribution | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { a?: Record<string, unknown>; t?: unknown };
    if (!parsed || typeof parsed.t !== 'number' || now - parsed.t > ATTRIBUTION_TTL_MS) return null;
    if (!parsed.a || typeof parsed.a !== 'object') return null;
    const out: Attribution = {};
    for (const key of ATTRIBUTION_KEYS) {
      const raw = parsed.a[key];
      const v = sanitizeAttrValue(typeof raw === 'string' ? raw : undefined);
      if (v) out[key] = v;
    }
    return hasAttribution(out) ? out : null;
  } catch {
    return null;
  }
}

export function buildTrackedLink(
  baseUrl: string,
  params: { source?: string; medium?: string; campaign?: string },
): string {
  const url = new URL(baseUrl);
  const set = (key: string, value?: string) => {
    const clean = sanitizeAttrValue(value)?.toLowerCase();
    if (clean) url.searchParams.set(key, clean);
  };
  set('utm_source', params.source);
  set('utm_medium', params.medium);
  set('utm_campaign', params.campaign);
  return url.toString();
}

// ------------------------------------------------------------------
// Analytics math
// ------------------------------------------------------------------

export function conversionRate(conversions: number, visitors: number): number {
  if (!visitors || visitors <= 0 || conversions <= 0) return 0;
  return Math.min(1, conversions / visitors);
}

export function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// ------------------------------------------------------------------
// Draft helpers / validation
// ------------------------------------------------------------------

export function isValidHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

/** WCAG relative luminance: pick dark or light text for a given accent background. */
export function readableTextColor(hex: string): string {
  if (!isValidHexColor(hex)) return '#ffffff';
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.179 ? '#0f172a' : '#ffffff';
}

export function emptyDraft(): LandingPageDraft {
  return {
    title: '',
    slug: '',
    headline: '',
    subheadline: '',
    body: '',
    sections: [],
    cta_label: 'Get a free quote',
    cta_mode: 'lead_form',
    accent_color: '#2563eb',
    seo_title: '',
    seo_description: '',
  };
}

export function draftFromPage(page: LandingPage): LandingPageDraft {
  return {
    title: page.title,
    slug: page.slug,
    headline: page.headline,
    subheadline: page.subheadline ?? '',
    body: page.body ?? '',
    sections: Array.isArray(page.sections) ? page.sections.map((s) => ({ title: s.title, body: s.body })) : [],
    cta_label: page.cta_label,
    cta_mode: page.cta_mode,
    accent_color: page.accent_color,
    seo_title: page.seo_title ?? '',
    seo_description: page.seo_description ?? '',
  };
}

export function cleanSections(sections: LandingSection[]): LandingSection[] {
  return sections
    .map((s) => ({
      title: s.title.trim().slice(0, DRAFT_LIMITS.sectionTitle),
      body: s.body.trim().slice(0, DRAFT_LIMITS.sectionBody),
    }))
    .filter((s) => s.title.length > 0 || s.body.length > 0)
    .slice(0, DRAFT_LIMITS.maxSections);
}

export function validateDraft(d: LandingPageDraft): DraftErrors {
  const e: DraftErrors = {};
  const L = DRAFT_LIMITS;
  if (!d.title.trim()) e.title = 'Give the page an internal name.';
  else if (d.title.trim().length > L.title) e.title = `Keep it under ${L.title} characters.`;

  if (!isValidSlug(d.slug)) e.slug = 'Use 3–60 lowercase letters, numbers or single hyphens.';

  if (!d.headline.trim()) e.headline = 'A headline is required.';
  else if (d.headline.trim().length > L.headline) e.headline = `Keep it under ${L.headline} characters.`;

  if (d.subheadline.trim().length > L.subheadline) e.subheadline = `Keep it under ${L.subheadline} characters.`;
  if (d.body.trim().length > L.body) e.body = `Keep it under ${L.body} characters.`;

  if (!d.cta_label.trim()) e.cta_label = 'Button text is required.';
  else if (d.cta_label.trim().length > L.ctaLabel) e.cta_label = `Keep it under ${L.ctaLabel} characters.`;

  if (!isValidHexColor(d.accent_color)) e.accent_color = 'Use a 6-digit hex color like #2563eb.';
  if (d.seo_title.trim().length > L.seoTitle) e.seo_title = `Keep it under ${L.seoTitle} characters.`;
  if (d.seo_description.trim().length > L.seoDescription) {
    e.seo_description = `Keep it under ${L.seoDescription} characters.`;
  }

  if (d.sections.length > L.maxSections) e.sections = `Up to ${L.maxSections} sections.`;
  else if (d.sections.some((s) => s.title.trim().length > L.sectionTitle || s.body.trim().length > L.sectionBody)) {
    e.sections = 'One of the sections is too long.';
  }
  return e;
}

// ------------------------------------------------------------------
// Public submit error mapping
// ------------------------------------------------------------------

export type SubmitFailure =
  | 'slot_taken'
  | 'too_soon'
  | 'unavailable'
  | 'rate_limited'
  | 'invalid_contact'
  | 'unknown';

export function mapSubmitError(message: string | undefined): SubmitFailure {
  const m = message ?? '';
  if (m.includes('slot_taken')) return 'slot_taken';
  if (m.includes('too_soon')) return 'too_soon';
  if (m.includes('booking_not_available') || m.includes('page_not_available')) return 'unavailable';
  if (m.includes('rate_limited')) return 'rate_limited';
  if (m.includes('contact_required') || m.includes('invalid_')) return 'invalid_contact';
  return 'unknown';
}
