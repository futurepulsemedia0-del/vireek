// Agent Readiness — scoring + fix planning. Pure: input in, result out. No network, no clock, no DB.
// Runs in Deno (edge functions) and Vitest. The browser only renders what these functions return.
//
// Honesty rules enforced here:
//  * A check that cannot be measured is `not_measured` (never silently 0 or 100) and its subscore is
//    excluded from the overall score; `coverage` reports how much of the 100 points was actually measured.
//  * AI-visibility results are SAMPLES; the check is flagged `sampled` and never claims a ranking.
import { RULES, SUBSCORE_ORDER, SUBSCORE_WEIGHTS, type RuleId, type SubscoreId } from './rules.ts';
import { normalizePhone, type SiteAudit } from './siteAudit.ts';

export type Hours = Record<string, { open: string; close: string; closed?: boolean }>;
export interface PriceBookRow {
  id: string; service_name: string; description: string | null;
  pricing_model: 'flat' | 'starting_at' | 'range' | 'hourly';
  price_cents: number; price_max_cents: number | null; unit_label: string | null;
}
export interface Snapshot {
  business: { name: string | null; phone: string | null; address: string | null; city: string | null; state: string | null; website: string | null; country: string | null };
  hours: Hours | null;
  booking_hours: Hours | null;
  holidays: number;
  /** business_profile.handles_emergency_calls (text): 'yes_premium' | 'yes_same_rate' | 'business_hours_only' | null */
  handles_emergency: string | null;
  /** Primary business location (business_locations): 'ai_answer' | 'voicemail' | 'forward' | null when no location row exists. */
  after_hours_mode: string | null;
  currency: string | null;
  timezone_valid: boolean;
  services_offered: string[];
  faqs: unknown;
  service_areas: string[];
  price_book: PriceBookRow[];
  reviews: { connected: boolean; total: number; last_90d: number; due_total: number; due_replied: number };
  booking: { enabled: boolean; feed_enabled: boolean; partner_status: string };
  phone_ai_configured: boolean;
}
export interface AiSample { engine: 'gemini' | 'chatgpt' | 'google_ai_mode'; query: string; mentioned: boolean }

export interface Evidence { k: string; p?: Record<string, string | number> }
export type CheckStatus = 'pass' | 'partial' | 'fail' | 'not_measured';
export interface Check {
  ruleId: RuleId; subscore: SubscoreId; status: CheckStatus; points: number; max: number;
  evidence: Evidence; fixKey?: string; sampled?: boolean;
}
export interface SubscoreResult { id: SubscoreId; score: number | null; measuredChecks: number; totalChecks: number }
export interface ScanResult {
  score: number | null;
  /** 0-1: share of the overall weight that could actually be measured. */
  coverage: number;
  subscores: SubscoreResult[];
  checks: Check[];
}

const HOUR_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const isOpenDay = (d: Hours[string] | undefined): d is Hours[string] => !!d && d.closed !== true && HOUR_RE.test(d.open) && HOUR_RE.test(d.close);
const validDays = (h: Hours | null): number => Object.values(h ?? {}).filter(isOpenDay).length;
const handlesEmergency = (s: Snapshot): boolean => (s.handles_emergency ?? '').startsWith('yes');
const filled = (v: string | null | undefined): boolean => !!v && v.trim().length > 0;

export function normalizeFaqs(raw: unknown): { q: string; a: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { q: string; a: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const q = [o.question, o.q].find((v): v is string => typeof v === 'string')?.trim();
    const a = [o.answer, o.a].find((v): v is string => typeof v === 'string')?.trim();
    if (q && a) out.push({ q: q.slice(0, 300), a: a.slice(0, 1000) });
  }
  return out.slice(0, 20);
}

/** Union of price-book names and business-profile services, case-insensitively de-duplicated. */
export function serviceNames(s: Snapshot): string[] {
  const seen = new Map<string, string>();
  for (const n of [...s.price_book.map((p) => p.service_name), ...s.services_offered]) {
    const t = (n ?? '').trim();
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()];
}

function mk(ruleId: RuleId, fraction: number | null, evidence: Evidence, fixKey?: string, sampled = false): Check {
  const def = RULES[ruleId];
  if (fraction === null) return { ruleId, subscore: def.subscore, status: 'not_measured', points: 0, max: def.max, evidence, fixKey, sampled };
  const f = Math.min(1, Math.max(0, fraction));
  const status: CheckStatus = f >= 0.999 ? 'pass' : f > 0 ? 'partial' : 'fail';
  return { ruleId, subscore: def.subscore, status, points: Math.round(def.max * f * 100) / 100, max: def.max, evidence, fixKey, sampled };
}

export function websiteChecks(a: SiteAudit | null, profilePhone: string | null): Check[] {
  const nm = (rule: RuleId, k: string): Check => mk(rule, null, { k });
  if (!a) {
    return (['site_https', 'site_meta', 'site_jsonld_business', 'site_jsonld_service', 'site_jsonld_faq', 'site_booking_link', 'site_click_to_call', 'site_speed'] as const)
      .map((r) => nm(r, 'site_not_audited'));
  }
  const lb = a.localBusiness;
  const lbParts = [lb.hasName, lb.hasTelephone, lb.hasAddress, lb.hasHours, lb.hasAreaServed].filter(Boolean).length;
  const metaParts = [a.hasTitle, a.hasMetaDescription, a.hasViewport].filter(Boolean).length;
  const speed = a.fetchMs <= 1500 ? 1 : a.fetchMs <= 3000 ? 0.5 : 0;
  const checks: Check[] = [
    mk('site_https', a.https ? 1 : 0, { k: a.https ? 'https_ok' : 'https_missing' }),
    mk('site_meta', metaParts / 3, { k: 'meta_parts', p: { found: metaParts, total: 3 } }),
    mk('site_jsonld_business', lb.present ? 0.4 + 0.12 * lbParts : 0,
      lb.present ? { k: 'lb_fields', p: { found: lbParts, total: 5 } } : { k: a.jsonLdInvalid > 0 ? 'jsonld_invalid' : 'lb_missing' }, 'jsonld_snippet'),
    mk('site_jsonld_service', a.hasService ? 1 : 0, { k: a.hasService ? 'service_ok' : 'service_missing' }, 'jsonld_snippet'),
    mk('site_jsonld_faq', a.hasFaq ? 1 : 0, { k: a.hasFaq ? 'faq_ok' : 'faq_missing' }, 'jsonld_snippet'),
    mk('site_booking_link', a.hasBookingLink ? 1 : 0, { k: a.hasBookingLink ? 'booking_link_ok' : 'booking_link_missing' }),
    mk('site_click_to_call', a.telLinks > 0 ? 1 : 0, { k: a.telLinks > 0 ? 'tel_ok' : 'tel_missing', p: { count: a.telLinks } }),
    mk('site_speed', speed, { k: 'speed_sample', p: { ms: Math.round(a.fetchMs) } }),
  ];
  // Cross-check the phone on the site against the phone on file — only possible with both.
  const onFile = profilePhone ? normalizePhone(profilePhone) : null;
  if (onFile) {
    const match = a.phones.includes(onFile);
    checks.push(mk('nap_site_match', match ? 1 : 0, { k: match ? 'nap_phone_match' : 'nap_phone_mismatch', p: { found: a.phones.length } }));
  }
  return checks;
}

export function profileChecks(s: Snapshot): Check[] {
  const b = s.business;
  const napMissing = [!filled(b.name) && 'name', !filled(b.phone) && 'phone', !(filled(b.address) && filled(b.city) && filled(b.state)) && 'address'].filter((x): x is string => !!x);
  const days = validDays(s.hours);
  const names = serviceNames(s);
  const active = s.price_book;
  const priced = active.filter((p) => p.price_cents > 0).length;
  const described = active.filter((p) => (p.description ?? '').trim().length >= 40).length;
  const faqCount = normalizeFaqs(s.faqs).length;
  const hoursSpecial = (handlesEmergency(s) ? 0.5 : 0) + (s.holidays > 0 ? 0.5 : 0);
  return [
    mk('nap_basics', (3 - napMissing.length) / 3, napMissing.length ? { k: 'nap_missing', p: { fields: napMissing.join(', ') } } : { k: 'nap_ok' }),
    mk('hours_defined', days >= 5 ? 1 : days / 5, { k: 'hours_days', p: { days } }),
    mk('hours_special', hoursSpecial, { k: 'hours_special', p: { emergency: handlesEmergency(s) ? 1 : 0, holidays: s.holidays } }, 'hours_review'),
    mk('services_count', names.length >= 8 ? 1 : names.length / 8, { k: 'services_count', p: { count: names.length } }, 'gbp_services'),
    mk('services_priced', active.length === 0 ? 0 : priced / active.length, { k: 'services_priced', p: { priced, total: active.length } }),
    mk('services_described', active.length === 0 ? 0 : described / active.length, { k: 'services_described', p: { described, total: active.length } }, 'service_descriptions'),
    mk('service_areas', s.service_areas.length > 0 ? 1 : 0, { k: 'areas', p: { count: s.service_areas.length } }),
    mk('faq_qa', faqCount >= 3 ? 1 : faqCount / 3, { k: 'faq_count', p: { count: faqCount } }),
    mk('gbp_categories_photos', null, { k: 'needs_gbp_read' }, 'gbp_manual_checks'),
  ];
}

export function otherChecks(s: Snapshot, samples: AiSample[] | null): Check[] {
  const rv = s.reviews;
  const checks: Check[] = [
    mk('phone_ai_number', s.phone_ai_configured ? 1 : 0, { k: s.phone_ai_configured ? 'ai_number_ok' : 'ai_number_missing' }),
    s.after_hours_mode === null
      ? mk('phone_after_hours', null, { k: 'after_hours_unknown' })
      : mk('phone_after_hours', s.after_hours_mode === 'ai_answer' ? 1 : s.after_hours_mode === 'forward' ? 0.7 : 0, { k: 'after_hours_mode', p: { mode: s.after_hours_mode } }),
    mk('phone_answer_time', null, { k: 'answer_time_not_tracked' }),
  ];
  if (!rv.connected) {
    for (const r of ['reviews_volume', 'reviews_recency', 'reviews_response'] as const) checks.push(mk(r, null, { k: 'reviews_not_connected' }, 'review_backlog'));
  } else {
    checks.push(mk('reviews_volume', rv.total >= 25 ? 1 : rv.total / 25, { k: 'reviews_total', p: { count: rv.total } }));
    checks.push(mk('reviews_recency', rv.last_90d >= 3 ? 1 : rv.last_90d / 3, { k: 'reviews_recent', p: { count: rv.last_90d } }));
    checks.push(rv.due_total === 0
      ? mk('reviews_response', null, { k: 'reviews_none_due' })
      : mk('reviews_response', Math.min(1, rv.due_replied / rv.due_total / 0.8), { k: 'reviews_replied', p: { replied: rv.due_replied, total: rv.due_total } }, 'review_backlog'));
  }
  const slotsReady = s.booking.enabled && s.timezone_valid && validDays(s.booking_hours ?? s.hours) > 0;
  checks.push(mk('booking_enabled', s.booking.enabled ? 1 : 0, { k: s.booking.enabled ? 'booking_on' : 'booking_off' }));
  checks.push(mk('booking_feed', s.booking.feed_enabled && slotsReady ? 1 : slotsReady ? 0.4 : 0,
    { k: s.booking.feed_enabled ? (slotsReady ? 'feed_on' : 'feed_blocked') : slotsReady ? 'feed_ready_off' : 'feed_not_ready' }, 'publish_feed'));
  checks.push(mk('booking_partner', s.booking.partner_status === 'approved' ? 1 : s.booking.partner_status === 'not_applied' ? 0 : 0.5,
    { k: 'partner_status', p: { status: s.booking.partner_status } }));
  checks.push(mk('nap_directories', null, { k: 'directories_not_checked' }, 'nap_manual'));
  if (samples && samples.length > 0) {
    const hits = samples.filter((x) => x.mentioned).length;
    checks.push(mk('ai_samples', hits / samples.length, { k: 'ai_sample_rate', p: { hits, total: samples.length } }, undefined, true));
  } else checks.push(mk('ai_samples', null, { k: 'ai_not_sampled' }, undefined, true));
  return checks;
}

export function summarize(checks: Check[]): ScanResult {
  const subscores: SubscoreResult[] = SUBSCORE_ORDER.map((id) => {
    const own = checks.filter((c) => c.subscore === id);
    const measured = own.filter((c) => c.status !== 'not_measured');
    const max = measured.reduce((n, c) => n + c.max, 0);
    const pts = measured.reduce((n, c) => n + c.points, 0);
    return { id, score: max > 0 ? Math.round((pts / max) * 100) : null, measuredChecks: measured.length, totalChecks: own.length };
  });
  const measured = subscores.filter((x) => x.score !== null);
  const wSum = measured.reduce((n, x) => n + SUBSCORE_WEIGHTS[x.id], 0);
  const score = wSum > 0 ? Math.round(measured.reduce((n, x) => n + (x.score as number) * SUBSCORE_WEIGHTS[x.id], 0) / wSum) : null;
  return { score, coverage: Math.round(wSum) / 100, subscores, checks };
}

export function scoreAccount(s: Snapshot, audit: SiteAudit | null, samples: AiSample[] | null = null): ScanResult {
  return summarize([...profileChecks(s), ...websiteChecks(audit, s.business.phone), ...otherChecks(s, samples)]);
}

/** Public tool: only the website can be measured. Returns the score plus the 5 biggest point losses. */
export function scoreWebsiteOnly(audit: SiteAudit): ScanResult & { topFixes: { ruleId: RuleId; lost: number; evidence: Evidence }[] } {
  const result = summarize(websiteChecks(audit, null));
  const topFixes = result.checks
    .filter((c) => c.status === 'fail' || c.status === 'partial')
    .map((c) => ({ ruleId: c.ruleId, lost: Math.round((c.max - c.points) * 100) / 100, evidence: c.evidence }))
    .sort((a, b) => b.lost - a.lost || a.ruleId.localeCompare(b.ruleId))
    .slice(0, 5);
  return { ...result, topFixes };
}

// ---------------------------------------------------------------------------------------------
// Fix planning
// ---------------------------------------------------------------------------------------------
export interface DiffRow { id: string; label: string; before: string; after: string }
export type FixKind = 'apply' | 'copy' | 'link' | 'task';
export interface Fix {
  key: string; kind: FixKind; ruleIds: RuleId[];
  /** Estimated points recovered if fully done (sum of lost points on the linked checks). */
  impact: number;
  diff?: DiffRow[]; copyText?: string; href?: string; notes?: string[];
}

const CURRENCY: Record<string, { code: string; symbol: string }> = { US: { code: 'USD', symbol: '$' }, CA: { code: 'CAD', symbol: 'CA$' } };
const SYMBOLS: Record<string, string> = { USD: '$', CAD: 'CA$' };
/** Currency from the primary location when it is a valid ISO code; otherwise USD, flagged as assumed. */
export function currencyFor(currency: string | null, country: string | null = null): { code: string; symbol: string; assumed: boolean } {
  const code = (currency ?? '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) return { code, symbol: SYMBOLS[code] ?? `${code} `, assumed: false };
  const hit = country ? CURRENCY[country.trim().toUpperCase()] : undefined;
  return hit ? { ...hit, assumed: false } : { code: 'USD', symbol: '$', assumed: true };
}
const money = (cents: number, symbol: string): string => `${symbol}${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`;

export function priceText(p: PriceBookRow, symbol: string): string {
  const unit = p.unit_label?.trim() ? ` ${p.unit_label.trim()}` : '';
  switch (p.pricing_model) {
    case 'flat': return `${money(p.price_cents, symbol)}${unit}`;
    case 'starting_at': return `starting at ${money(p.price_cents, symbol)}${unit}`;
    case 'range': return p.price_max_cents ? `${money(p.price_cents, symbol)}–${money(p.price_max_cents, symbol)}${unit}` : `starting at ${money(p.price_cents, symbol)}${unit}`;
    case 'hourly': return `${money(p.price_cents, symbol)} per hour`;
  }
}

/** Templated, plain-language draft. It states only what the price book says; the owner approves each row. */
export function describeService(p: PriceBookRow, symbol: string): string {
  const base = `${p.service_name.trim()} for homes and small businesses.`;
  if (p.price_cents <= 0) return `${base} Contact us for a price.`;
  const tail = p.pricing_model === 'flat' ? 'The price is fixed for this service.' : 'The final price depends on the job and is confirmed before work begins.';
  return `${base} Price: ${priceText(p, symbol)}. ${tail}`.slice(0, 300);
}

function lostFor(checks: Check[], ids: RuleId[]): number {
  return Math.round(checks.filter((c) => ids.includes(c.ruleId) && c.status !== 'not_measured').reduce((n, c) => n + (c.max - c.points), 0) * 100) / 100;
}

const DAY_NAMES: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

export function buildJsonLd(s: Snapshot): { json: string; notes: string[] } {
  const notes: string[] = [];
  const cur = currencyFor(s.currency, s.business.country);
  if (cur.assumed) notes.push('currency_assumed');
  const hours = Object.entries(s.hours ?? {}).filter(([k, v]) => DAY_NAMES[k] && isOpenDay(v))
    .map(([k, v]) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: DAY_NAMES[k], opens: v.open, closes: v.close }));
  const services = s.price_book.slice(0, 50).map((p) => {
    const svc: Record<string, unknown> = { '@type': 'Service', name: p.service_name.trim() };
    const desc = (p.description ?? '').trim() || describeService(p, cur.symbol);
    svc.description = desc;
    if (p.price_cents > 0) {
      const spec: Record<string, unknown> = { '@type': 'PriceSpecification', priceCurrency: cur.code, minPrice: p.price_cents / 100 };
      if (p.pricing_model === 'range' && p.price_max_cents) spec.maxPrice = p.price_max_cents / 100;
      if (p.pricing_model === 'hourly') spec.unitCode = 'HUR';
      svc.offers = { '@type': 'Offer', priceSpecification: spec };
    }
    return svc;
  });
  const faqs = normalizeFaqs(s.faqs);
  const business: Record<string, unknown> = { '@type': 'HomeAndConstructionBusiness', name: s.business.name ?? undefined };
  if (filled(s.business.website)) business.url = s.business.website;
  if (filled(s.business.phone)) business.telephone = s.business.phone;
  if (filled(s.business.address) && filled(s.business.city) && filled(s.business.state)) {
    business.address = { '@type': 'PostalAddress', streetAddress: s.business.address, addressLocality: s.business.city, addressRegion: s.business.state };
  } else notes.push('address_incomplete');
  if (hours.length) business.openingHoursSpecification = hours; else notes.push('hours_missing');
  if (s.service_areas.length) business.areaServed = s.service_areas.slice(0, 20).map((n) => ({ '@type': 'Place', name: n }));
  if (services.length) business.hasOfferCatalog = { '@type': 'OfferCatalog', name: 'Services', itemListElement: services };
  const graph: Record<string, unknown>[] = [business];
  if (faqs.length) graph.push({ '@type': 'FAQPage', mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2)
    .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return { json, notes };
}

export function buildFixes(s: Snapshot, checks: Check[]): Fix[] {
  const fixes: Fix[] = [];
  const cur = currencyFor(s.currency, s.business.country);

  const rows = s.price_book.filter((p) => (p.description ?? '').trim().length < 40 && p.service_name.trim());
  if (rows.length) {
    fixes.push({
      key: 'service_descriptions', kind: 'apply', ruleIds: ['services_described'], impact: lostFor(checks, ['services_described']),
      diff: rows.slice(0, 50).map((p) => ({ id: p.id, label: p.service_name, before: (p.description ?? '').trim(), after: describeService(p, cur.symbol) })),
      notes: ['templated_draft', ...(cur.assumed ? ['currency_assumed'] : [])],
    });
  }

  const ld = buildJsonLd(s);
  fixes.push({ key: 'jsonld_snippet', kind: 'copy', ruleIds: ['site_jsonld_business', 'site_jsonld_service', 'site_jsonld_faq'],
    impact: lostFor(checks, ['site_jsonld_business', 'site_jsonld_service', 'site_jsonld_faq']), copyText: `<script type="application/ld+json">\n${ld.json}\n</script>`, notes: ld.notes });

  const bh = JSON.stringify(s.booking_hours ?? null);
  const hh = JSON.stringify(s.hours ?? null);
  const conflict = s.booking_hours !== null && s.hours !== null && bh !== hh;
  if (conflict || s.holidays === 0 || !handlesEmergency(s)) {
    fixes.push({ key: 'hours_review', kind: 'task', ruleIds: ['hours_defined', 'hours_special'], impact: lostFor(checks, ['hours_defined', 'hours_special']),
      href: '/dashboard/settings', notes: [conflict ? 'hours_conflict' : '', s.holidays === 0 ? 'holidays_missing' : '', !handlesEmergency(s) ? 'emergency_flag_missing' : ''].filter(Boolean) });
  }

  const names = serviceNames(s);
  const copy = s.price_book.slice(0, 15).map((p) => `• ${p.service_name.trim()} — ${(p.description ?? '').trim() || describeService(p, cur.symbol)}`).join('\n');
  fixes.push({ key: 'gbp_services', kind: 'link', ruleIds: ['services_count', 'services_priced'], impact: lostFor(checks, ['services_count', 'services_priced']),
    href: '/dashboard/google-booking', copyText: copy || names.slice(0, 15).map((n) => `• ${n}`).join('\n'), notes: names.length < 8 ? ['services_below_8'] : [] });

  if (s.reviews.connected && s.reviews.due_total > s.reviews.due_replied) {
    fixes.push({ key: 'review_backlog', kind: 'link', ruleIds: ['reviews_response'], impact: lostFor(checks, ['reviews_response']), href: '/dashboard/reputation' });
  }
  if (!s.booking.feed_enabled) fixes.push({ key: 'publish_feed', kind: 'link', ruleIds: ['booking_feed'], impact: lostFor(checks, ['booking_feed']), href: '/dashboard/google-booking' });
  fixes.push({ key: 'gbp_manual_checks', kind: 'task', ruleIds: ['gbp_categories_photos', 'nap_directories'], impact: 0 });
  return fixes.sort((a, b) => b.impact - a.impact);
}
