// Agent Readiness — pure HTML auditor. Reads ONE already-fetched page; never fetches anything itself.
// No imports, no DOM: regex/JSON only, so it runs unchanged in Deno and Vitest.

export interface SiteAudit {
  https: boolean;
  hasTitle: boolean;
  hasMetaDescription: boolean;
  hasViewport: boolean;
  jsonLdBlocks: number;
  jsonLdInvalid: number;
  types: string[];
  localBusiness: { present: boolean; hasName: boolean; hasTelephone: boolean; hasAddress: boolean; hasHours: boolean; hasAreaServed: boolean };
  hasService: boolean;
  hasFaq: boolean;
  telLinks: number;
  hasBookingLink: boolean;
  /** Last 10 digits of every phone number seen (tel: links + visible text), de-duplicated. */
  phones: string[];
  fetchMs: number;
  bytes: number;
}

const LD_RE = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const BUSINESS_TYPES = new Set(['LocalBusiness', 'HomeAndConstructionBusiness', 'Plumber', 'Electrician', 'HVACBusiness',
  'RoofingContractor', 'GeneralContractor', 'HousePainter', 'Locksmith', 'MovingCompany', 'ProfessionalService']);

function typesOf(node: Record<string, unknown>): string[] {
  const t = node['@type'];
  const list = Array.isArray(t) ? t : t ? [t] : [];
  return list.filter((x): x is string => typeof x === 'string').map((x) => x.replace(/^https?:\/\/schema\.org\//, ''));
}

function flatten(value: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((v) => flatten(v, out, depth + 1)); return; }
  const node = value as Record<string, unknown>;
  out.push(node);
  if (node['@graph']) flatten(node['@graph'], out, depth + 1);
}

const nonEmpty = (v: unknown): boolean => (typeof v === 'string' ? v.trim() !== '' : v !== null && v !== undefined && (!Array.isArray(v) || v.length > 0));

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

export function auditHtml(html: string, finalUrl: string, meta: { fetchMs: number; bytes: number }): SiteAudit {
  const src = html.slice(0, 1_500_000);
  const nodes: Record<string, unknown>[] = [];
  let blocks = 0;
  let invalid = 0;
  for (const m of src.matchAll(LD_RE)) {
    blocks += 1;
    try { flatten(JSON.parse(m[1].trim()), nodes); } catch { invalid += 1; }
  }
  const types = [...new Set(nodes.flatMap(typesOf))].sort();
  const business = nodes.find((n) => typesOf(n).some((t) => BUSINESS_TYPES.has(t)));
  const phones = new Set<string>();
  let telLinks = 0;
  for (const m of src.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
    telLinks += 1;
    const p = normalizePhone(decodeURIComponent(m[1]));
    if (p) phones.add(p);
  }
  const text = src.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, ' ');
  for (const m of text.matchAll(/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g)) {
    const p = normalizePhone(m[0]);
    if (p) phones.add(p);
    if (phones.size >= 20) break;
  }
  let hasBooking = false;
  let anchors = 0;
  for (const m of src.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (++anchors > 2000) break;
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(m[1])?.[1] ?? '';
    const label = m[2].replace(/<[^>]+>/g, ' ');
    if (/(book|schedul|appointment|reserve)/i.test(href) || /\b(book|schedule|appointment|reserve)\b/i.test(label)) { hasBooking = true; break; }
  }
  return {
    https: finalUrl.startsWith('https://'),
    hasTitle: /<title[^>]*>\s*\S[\s\S]*?<\/title>/i.test(src),
    hasMetaDescription: /<meta\b[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["'][^"']{20,}/i.test(src)
      || /<meta\b[^>]*content\s*=\s*["'][^"']{20,}["'][^>]*name\s*=\s*["']description["']/i.test(src),
    hasViewport: /<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(src),
    jsonLdBlocks: blocks,
    jsonLdInvalid: invalid,
    types,
    localBusiness: {
      present: !!business,
      hasName: !!business && nonEmpty(business.name),
      hasTelephone: !!business && nonEmpty(business.telephone),
      hasAddress: !!business && nonEmpty(business.address),
      hasHours: !!business && (nonEmpty(business.openingHoursSpecification) || nonEmpty(business.openingHours)),
      hasAreaServed: !!business && nonEmpty(business.areaServed),
    },
    hasService: nodes.some((n) => typesOf(n).includes('Service')) || nodes.some((n) => nonEmpty(n.hasOfferCatalog)),
    hasFaq: nodes.some((n) => typesOf(n).includes('FAQPage') && nonEmpty(n.mainEntity)),
    telLinks,
    hasBookingLink: hasBooking,
    phones: [...phones],
    fetchMs: meta.fetchMs,
    bytes: meta.bytes,
  };
}
