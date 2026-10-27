/**
 * Embeddable Website Widgets (booking / request-a-quote / reviews badge) — pure domain logic (no I/O, fully unit-tested).
 * The embed script (public/website-widgets.js) mirrors the default copy below and the DB limits in
 * supabase/migrations/20271021000000_website_widgets.sql — keep the three in sync.
 */

import { normalizeDomain, parseDomains, readableTextColor } from '@/lib/chatWidget';
import {
  buildDefaultEstimatorOptions,
  sanitizeEstimatorOptions,
  validateEstimatorOptions,
  type EstimatorErrorKey,
  type EstimatorOptions,
} from '@/lib/websiteEstimator';

export { normalizeDomain, parseDomains, readableTextColor };

export type WidgetType = 'booking' | 'quote' | 'reviews' | 'estimator';
export type WidgetTheme = 'light' | 'dark' | 'auto';
export type DisplayMode = 'floating' | 'inline';
export type WidgetPosition = 'left' | 'right';
export type ReviewPlatform = 'google' | 'yelp' | 'facebook';
export type QuoteContact = 'email' | 'phone' | 'either';
export type ReviewsLayout = 'badge' | 'cards';

export const WIDGET_TYPES: WidgetType[] = ['booking', 'quote', 'reviews', 'estimator'];
export const REVIEW_PLATFORMS: ReviewPlatform[] = ['google', 'yelp', 'facebook'];
export const PLATFORM_LABELS: Record<ReviewPlatform, string> = { google: 'Google', yelp: 'Yelp', facebook: 'Facebook' };

export interface BookingOptions {
  collect_notes: boolean;
}
export interface QuoteOptions {
  contact_required: QuoteContact;
  ask_zip: boolean;
  message_required: boolean;
  services_mode: 'business' | 'custom';
  custom_services: string[];
}
export interface ReviewsOptions {
  layout: ReviewsLayout;
  max_excerpts: number;
  min_rating: number;
  min_reviews: number;
  cta_url: string;
  platforms: ReviewPlatform[];
}
export type WidgetOptions = BookingOptions | QuoteOptions | ReviewsOptions | EstimatorOptions;

interface CommonSettings {
  enabled: boolean;
  brand_color: string;
  theme: WidgetTheme;
  display_mode: DisplayMode;
  position: WidgetPosition;
  radius: number;
  title: string;
  subtitle: string;
  button_label: string;
  success_message: string;
  allowed_domains: string[];
}

export type WidgetSettings =
  | (CommonSettings & { widget_type: 'booking'; options: BookingOptions })
  | (CommonSettings & { widget_type: 'quote'; options: QuoteOptions })
  | (CommonSettings & { widget_type: 'reviews'; options: ReviewsOptions })
  | (CommonSettings & { widget_type: 'estimator'; options: EstimatorOptions });

export type WidgetRow = WidgetSettings & {
  id: string;
  account_owner_id: string;
  public_key: string;
  last_seen_at: string | null;
  last_seen_host: string | null;
  updated_at: string;
};

/** Must stay in sync with the CHECK constraints in the migration. */
export const LIMITS = {
  title: 60,
  subtitle: 120,
  button: 30,
  success: 240,
  domains: 20,
  radiusMin: 0,
  radiusMax: 24,
  customServices: 30,
  customServiceLen: 60,
  ctaUrl: 500,
  excerptsMin: 1,
  excerptsMax: 5,
  ratingMin: 1,
  ratingMax: 5,
  minReviewsMin: 1,
  minReviewsMax: 100,
} as const;

export const TYPE_META: Record<WidgetType, { label: string; blurb: string; defaultTitle: string; defaultSubtitle: string; defaultButton: string; defaultSuccess: string }> = {
  booking: {
    label: 'Booking',
    blurb: 'Visitors pick a time and book — straight into your schedule.',
    defaultTitle: 'Book online',
    defaultSubtitle: 'Pick a time that works for you.',
    defaultButton: 'Book now',
    defaultSuccess: "You're booked! We'll see you then.",
  },
  quote: {
    label: 'Request a quote',
    blurb: 'A short form that drops new leads into your pipeline.',
    defaultTitle: 'Request a free quote',
    defaultSubtitle: 'Tell us what you need — we reply fast.',
    defaultButton: 'Get a quote',
    defaultSuccess: 'Thanks! We got your request and will be in touch shortly.',
  },
  reviews: {
    label: 'Reviews badge',
    blurb: 'Your live star rating and recent reviews, right on your site.',
    defaultTitle: 'What customers say',
    defaultSubtitle: '',
    defaultButton: 'See all reviews',
    defaultSuccess: '',
  },
  estimator: {
    label: 'Price estimator',
    blurb: 'Visitors pick a service and see your price instantly, then request the exact quote.',
    defaultTitle: 'Get an instant price',
    defaultSubtitle: 'Pick a service and see your price right away.',
    defaultButton: 'Get a price',
    defaultSuccess: 'Thanks! We got your request and will confirm your exact price shortly.',
  },
};

/* ------------------------------ defaults ----------------------------- */

export function buildDefaultOptions(type: WidgetType): WidgetOptions {
  if (type === 'booking') return { collect_notes: true };
  if (type === 'quote') return { contact_required: 'either', ask_zip: false, message_required: false, services_mode: 'business', custom_services: [] };
  if (type === 'estimator') return buildDefaultEstimatorOptions();
  return { layout: 'badge', max_excerpts: 3, min_rating: 4, min_reviews: 1, cta_url: '', platforms: [...REVIEW_PLATFORMS] };
}

export function buildDefaults(type: WidgetType): WidgetSettings {
  const m = TYPE_META[type];
  return {
    widget_type: type,
    enabled: false,
    brand_color: '#3448E8',
    theme: 'auto',
    display_mode: type === 'reviews' ? 'inline' : 'floating',
    position: 'right',
    radius: 14,
    title: m.defaultTitle,
    subtitle: m.defaultSubtitle,
    button_label: m.defaultButton,
    success_message: m.defaultSuccess,
    allowed_domains: [],
    options: buildDefaultOptions(type),
  } as WidgetSettings;
}

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : fallback;
};
const isOneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

/** Coerces untrusted/partial jsonb into a complete, in-range options object for the type. */
export function sanitizeOptions(type: WidgetType, raw: unknown): WidgetOptions {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const d = buildDefaultOptions(type);
  if (type === 'booking') return { collect_notes: typeof o.collect_notes === 'boolean' ? o.collect_notes : (d as BookingOptions).collect_notes };
  if (type === 'quote') {
    const dq = d as QuoteOptions;
    const services = Array.isArray(o.custom_services)
      ? [...new Set(o.custom_services.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean))].slice(0, LIMITS.customServices)
      : [];
    return {
      contact_required: isOneOf(o.contact_required, ['email', 'phone', 'either'] as const) ? o.contact_required : dq.contact_required,
      ask_zip: typeof o.ask_zip === 'boolean' ? o.ask_zip : dq.ask_zip,
      message_required: typeof o.message_required === 'boolean' ? o.message_required : dq.message_required,
      services_mode: o.services_mode === 'custom' ? 'custom' : 'business',
      custom_services: services,
    };
  }
  if (type === 'estimator') return sanitizeEstimatorOptions(raw);
  const dr = d as ReviewsOptions;
  const platforms = Array.isArray(o.platforms) ? REVIEW_PLATFORMS.filter((p) => (o.platforms as unknown[]).includes(p)) : [];
  return {
    layout: o.layout === 'cards' ? 'cards' : 'badge',
    max_excerpts: clampInt(o.max_excerpts, LIMITS.excerptsMin, LIMITS.excerptsMax, dr.max_excerpts),
    min_rating: clampInt(o.min_rating, LIMITS.ratingMin, LIMITS.ratingMax, dr.min_rating),
    min_reviews: clampInt(o.min_reviews, LIMITS.minReviewsMin, LIMITS.minReviewsMax, dr.min_reviews),
    cta_url: typeof o.cta_url === 'string' ? o.cta_url.trim() : '',
    platforms: platforms.length ? platforms : [...REVIEW_PLATFORMS],
  };
}

/** Normalises a DB row (or partial) into settings, filling anything missing from the type's defaults. */
export function normalizeSettings(type: WidgetType, row: Partial<WidgetSettings> | null | undefined): WidgetSettings {
  const d = buildDefaults(type);
  if (!row) return d;
  return {
    ...d,
    ...row,
    widget_type: type,
    radius: clampInt(row.radius, LIMITS.radiusMin, LIMITS.radiusMax, d.radius),
    allowed_domains: Array.isArray(row.allowed_domains) ? row.allowed_domains : [],
    options: sanitizeOptions(type, row.options),
  } as WidgetSettings;
}

/** Returns a copy with some option keys changed (keeps the union type intact). */
export function withOptions<T extends WidgetSettings>(s: T, patch: Partial<T['options']>): T {
  return { ...s, options: { ...s.options, ...patch } } as T;
}

export function settingsEqual(a: WidgetSettings, b: WidgetSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ----------------------------- validation ---------------------------- */

export type WidgetErrorKey =
  | 'brand_color' | 'radius' | 'title' | 'subtitle' | 'button_label' | 'success_message' | 'allowed_domains'
  | 'custom_services' | 'cta_url' | 'platforms' | 'max_excerpts' | 'min_rating' | 'min_reviews'
  | EstimatorErrorKey;
export type WidgetErrors = Partial<Record<WidgetErrorKey, string>>;

export function isHttpsUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !/\s/.test(value);
  } catch {
    return false;
  }
}

export function validateSettings(s: WidgetSettings): WidgetErrors {
  const e: WidgetErrors = {};
  if (!/^#[0-9a-fA-F]{6}$/.test(s.brand_color)) e.brand_color = 'Use a 6-digit hex color, e.g. #3448E8.';
  if (!Number.isInteger(s.radius) || s.radius < LIMITS.radiusMin || s.radius > LIMITS.radiusMax) e.radius = `Between ${LIMITS.radiusMin} and ${LIMITS.radiusMax}.`;
  if (s.title.length > LIMITS.title) e.title = `Max ${LIMITS.title} characters.`;
  if (s.subtitle.length > LIMITS.subtitle) e.subtitle = `Max ${LIMITS.subtitle} characters.`;
  if (s.button_label.length > LIMITS.button) e.button_label = `Max ${LIMITS.button} characters.`;
  if (s.success_message.length > LIMITS.success) e.success_message = `Max ${LIMITS.success} characters.`;
  if (s.widget_type !== 'reviews' && !s.button_label.trim()) e.button_label = 'Enter a button label.';
  if (s.allowed_domains.length > LIMITS.domains) e.allowed_domains = `Max ${LIMITS.domains} domains.`;

  if (s.widget_type === 'quote') {
    const o = s.options;
    if (o.services_mode === 'custom') {
      if (o.custom_services.length === 0) e.custom_services = 'Add at least one service, or use your business services.';
      else if (o.custom_services.length > LIMITS.customServices) e.custom_services = `Max ${LIMITS.customServices} services.`;
      else if (o.custom_services.some((x) => x.length > LIMITS.customServiceLen)) e.custom_services = `Each service: max ${LIMITS.customServiceLen} characters.`;
    }
  }
  if (s.widget_type === 'reviews') {
    const o = s.options;
    if (o.cta_url && (!isHttpsUrl(o.cta_url) || o.cta_url.length > LIMITS.ctaUrl)) e.cta_url = 'Use a full https:// link (max 500 characters).';
    if (o.platforms.length === 0) e.platforms = 'Choose at least one platform.';
    if (o.max_excerpts < LIMITS.excerptsMin || o.max_excerpts > LIMITS.excerptsMax) e.max_excerpts = `Between ${LIMITS.excerptsMin} and ${LIMITS.excerptsMax}.`;
    if (o.min_rating < LIMITS.ratingMin || o.min_rating > LIMITS.ratingMax) e.min_rating = `Between ${LIMITS.ratingMin} and ${LIMITS.ratingMax}.`;
    if (o.min_reviews < LIMITS.minReviewsMin || o.min_reviews > LIMITS.minReviewsMax) e.min_reviews = `Between ${LIMITS.minReviewsMin} and ${LIMITS.minReviewsMax}.`;
  }
  if (s.widget_type === 'estimator') Object.assign(e, validateEstimatorOptions(s.options));

  return e;
}

export const hasErrors = (e: WidgetErrors): boolean => Object.keys(e).length > 0;

/* ------------------------------ readiness ---------------------------- */

export interface ReadinessContext {
  bookingEnabled: boolean;
  bookingSlug: string | null;
  serviceCount: number;
  reviewCount: number;
}

/** Why a saved+enabled widget might still render nothing on the website. Empty list = ready. */
export function getReadinessIssues(s: WidgetSettings, ctx: ReadinessContext): string[] {
  const issues: string[] = [];
  if (s.widget_type === 'estimator') return issues; // needs the price-book catalog — see getEstimatorIssues()
  if (s.widget_type === 'booking') {
    if (!ctx.bookingEnabled || !ctx.bookingSlug) issues.push('Online booking is switched off. Enable it in Booking Settings — the widget stays hidden until then.');
  } else if (s.widget_type === 'quote') {
    if (s.options.services_mode === 'business' && ctx.serviceCount === 0) issues.push('No services on your business profile — visitors will see a free-text field instead of a service list.');
  } else {
    if (ctx.reviewCount === 0) issues.push('No reviews synced yet. Connect a listing or log reviews in Reputation — the badge stays hidden until you have some.');
    else if (ctx.reviewCount < s.options.min_reviews) issues.push(`You have ${ctx.reviewCount} review${ctx.reviewCount === 1 ? '' : 's'}; the badge shows from ${s.options.min_reviews}.`);
  }
  return issues;
}

/* ------------------------------ install ------------------------------ */

export interface SnippetInput {
  type: WidgetType;
  mode: DisplayMode;
  origin: string;
  publicKey: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

const escAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function buildWidgetSnippet({ type, mode, origin, publicKey, supabaseUrl, supabaseAnonKey }: SnippetInput): string {
  const lines = [`<!-- Vireek ${TYPE_META[type].label.toLowerCase()} widget -->`];
  if (mode === 'inline') lines.push(`<div data-vireek-widget="${escAttr(publicKey)}"></div>`);
  lines.push(
    '<script',
    `  src="${escAttr(origin.replace(/\/$/, ''))}/website-widgets.js"`,
    `  data-key="${escAttr(publicKey)}"`,
    `  data-api="${escAttr(supabaseUrl.replace(/\/$/, ''))}"`,
    `  data-anon="${escAttr(supabaseAnonKey)}"`,
    '  async',
    '></script>',
  );
  return lines.join('\n');
}

export const INSTALL_TIPS: { platform: string; steps: string }[] = [
  { platform: 'WordPress', steps: 'Appearance → Theme File Editor → footer.php, or use a "Custom HTML" block / header-footer plugin. Paste before </body>.' },
  { platform: 'Wix', steps: 'Settings → Custom Code → Add Code → paste, set to "Body – end", apply to all pages. (Inline: use an Embed → Custom Code element.)' },
  { platform: 'Squarespace', steps: 'Settings → Advanced → Code Injection → Footer. (Inline: add a Code block where it should appear.)' },
  { platform: 'Shopify', steps: 'Online Store → Themes → Edit code → theme.liquid → paste before </body>.' },
  { platform: 'Webflow', steps: 'Project Settings → Custom Code → Footer Code. (Inline: add an Embed element.)' },
  { platform: 'Custom HTML', steps: 'Paste just before the closing </body> tag on every page where it should appear.' },
];

/* ------------------------------ analytics ---------------------------- */

export interface DailyStatRow {
  widget_id: string;
  day: string; // YYYY-MM-DD (UTC)
  views: number;
  opens: number;
  conversions: number;
}

export interface StatsSummary {
  views: number;
  opens: number;
  conversions: number;
  /** opens ÷ views, 0–1, or null when there are no views. */
  openRate: number | null;
  /** conversions ÷ views, 0–1, or null when there are no views. */
  conversionRate: number | null;
  /** Oldest → newest, zero-filled, one point per UTC day. */
  series: { day: string; views: number; conversions: number }[];
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10);

export function summarizeStats(rows: DailyStatRow[], days: number, now: Date = new Date()): StatsSummary {
  const byDay = new Map<string, { views: number; conversions: number }>();
  let views = 0;
  let opens = 0;
  let conversions = 0;
  const wanted: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    wanted.push(dayKey(d));
  }
  const inRange = new Set(wanted);
  for (const r of rows) {
    if (!inRange.has(r.day)) continue;
    views += r.views;
    opens += r.opens;
    conversions += r.conversions;
    const cur = byDay.get(r.day) ?? { views: 0, conversions: 0 };
    byDay.set(r.day, { views: cur.views + r.views, conversions: cur.conversions + r.conversions });
  }
  return {
    views,
    opens,
    conversions,
    // Views are de-duplicated per browser tab, interactions are not — clamp so a rate never reads above 100%.
    openRate: views > 0 ? Math.min(1, opens / views) : null,
    conversionRate: views > 0 ? Math.min(1, conversions / views) : null,
    series: wanted.map((day) => ({ day, ...(byDay.get(day) ?? { views: 0, conversions: 0 }) })),
  };
}

export function formatPercent(rate: number | null): string {
  if (rate === null) return '—';
  const pct = rate * 100;
  return `${pct >= 10 || pct === 0 ? Math.round(pct) : pct.toFixed(1)}%`;
}

export const formatCount = (n: number): string => new Intl.NumberFormat('en-US').format(n);

/* -------------------------------- misc ------------------------------- */

/** Fill (0–1) of each of the five stars for an average rating, e.g. 4.3 → [1,1,1,1,0.3]. */
export function starFills(average: number): number[] {
  const a = Math.min(5, Math.max(0, Number.isFinite(average) ? average : 0));
  return [0, 1, 2, 3, 4].map((i) => Math.min(1, Math.max(0, Math.round((a - i) * 10) / 10)));
}

/** Maps DB / RPC error codes to friendly copy. */
export function friendlySaveError(err: unknown, fallback = 'Could not save. Please try again.'): string {
  const msg = err instanceof Error ? err.message : typeof (err as { message?: unknown })?.message === 'string' ? (err as { message: string }).message : '';
  if (msg.includes('WIDGET_FORBIDDEN') || /row-level security/i.test(msg)) return 'You do not have permission to change website widgets.';
  if (msg.includes('WIDGET_NOT_CONFIGURED')) return 'Save the widget once before rotating its key.';
  if (/ww_options_check/.test(msg)) return 'Those options are too large. Shorten the custom services list.';
  return fallback;
}
