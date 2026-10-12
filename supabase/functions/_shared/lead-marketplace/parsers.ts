// supabase/functions/_shared/lead-marketplace/parsers.ts
//
// Turns a marketplace webhook body or notification email into one normalized
// ParsedLead. Pure functions only (no I/O) so every branch is unit-tested.
//
// NOT LIVE-VERIFIED against each marketplace's current production payloads
// and email templates — they are partner/private formats that change without
// notice. That is why the parsers are deliberately TOLERANT instead of
// template-exact:
//   - webhooks: case/punctuation-insensitive key lookup at any depth, with
//     alias lists per field (leadPrice == lead_price == LeadPrice);
//   - emails:   "Label: value" extraction (plain text, or HTML flattened to
//     text), with conservative, flagged fallbacks.
// Anything unparseable is stored raw in lead_marketplace_events so the alias
// lists can be extended from real samples. See docs/lead-marketplace-ingestion.md.

import { MARKETPLACE_PROVIDERS, PROVIDER_LABELS, type MarketplaceProvider, type ParsedLead, type ParseResult } from "./types.ts";

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

const MAX_FIELD = 500;
const MAX_MESSAGE = 1000;

export function normKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function clean(value: unknown, max = MAX_FIELD): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  if (!s || /^(null|undefined|n\/a|none|-)$/i.test(s)) return null;
  return s.slice(0, max);
}

/** E.164-style. US 10/11-digit numbers get +1; other numbers need an explicit "+". */
export function normalizePhone(raw: unknown): string | null {
  const s = clean(raw, 60);
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (s.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

export function normalizeEmail(raw: unknown): string | null {
  const s = clean(raw, 200);
  if (!s) return null;
  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
}

const MAX_COST_CENTS = 200_000; // $2,000 — above this it is almost certainly not a lead fee

/** "$45.00" | "45" | 45 | 45.5 -> cents. `isCents` = the number is already cents. */
export function parseMoneyToCents(value: unknown, isCents = false): number | null {
  let cents: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    cents = isCents ? Math.round(value) : Math.round(value * 100);
  } else if (typeof value === "string") {
    if (/^\s*-/.test(value)) return null;
    const m = value.replace(/\s/g, "").match(/(\d[\d,]*(?:\.\d{1,2})?)/);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) return null;
    cents = isCents ? Math.round(n) : Math.round(n * 100);
  }
  if (cents === null || cents < 0 || cents > MAX_COST_CENTS) return null;
  return cents;
}

export function humanizeService(raw: string): string {
  // Google LSA category ids look like "xcat:service_area_business_plumber".
  const s = raw
    .replace(/^xcat:/i, "")
    .replace(/^service_area_business_/i, "")
    .replace(/^(?:jobtype|gcid):/i, "")
    .replace(/[_]+/g, " ")
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : raw;
}

export function fallbackLeadName(provider: MarketplaceProvider): string {
  return `${PROVIDER_LABELS[provider]} lead`;
}

// ---------------------------------------------------------------------
// Provider detection (email path)
// ---------------------------------------------------------------------

const PROVIDER_DOMAINS: Record<MarketplaceProvider, string[]> = {
  angi: ["angi.com", "angieslist.com"],
  homeadvisor: ["homeadvisor.com"],
  thumbtack: ["thumbtack.com"],
  nextdoor: ["nextdoor.com"],
  google_lsa: ["google.com"],
};

// google.com sends many things; only treat it as LSA with explicit LSA context.
const LSA_CONTEXT = /local services|google guaranteed|google screened|\blsa\b|new lead/i;

const ALIAS_TAGS: Record<string, MarketplaceProvider> = {
  angi: "angi",
  angieslist: "angi",
  homeadvisor: "homeadvisor",
  ha: "homeadvisor",
  thumbtack: "thumbtack",
  tt: "thumbtack",
  nextdoor: "nextdoor",
  nd: "nextdoor",
  lsa: "google_lsa",
  google: "google_lsa",
  googlelsa: "google_lsa",
  google_lsa: "google_lsa",
};

/** "angi" in "token+angi@domain" -> provider. */
export function providerFromAliasTag(tag: string | null | undefined): MarketplaceProvider | null {
  if (!tag) return null;
  return ALIAS_TAGS[tag.toLowerCase().trim()] ?? null;
}

function domainOf(address: string): string | null {
  const m = address.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return m ? m[1].toLowerCase() : null;
}

function matchDomain(domain: string, subject: string, body: string): MarketplaceProvider | null {
  for (const provider of MARKETPLACE_PROVIDERS) {
    for (const d of PROVIDER_DOMAINS[provider]) {
      if (domain === d || domain.endsWith(`.${d}`)) {
        if (provider === "google_lsa" && !LSA_CONTEXT.test(`${subject}\n${body.slice(0, 2000)}`)) continue;
        return provider;
      }
    }
  }
  return null;
}

/**
 * Order of evidence: (1) the sender's domain, (2) the original sender of a
 * forwarded message ("From: ... @thumbtack.com" in the body), (3) the plus-tag
 * on the tenant's secret alias ("token+angi@..."). The tag is trusted because
 * the alias itself is secret, but real sender evidence wins over it.
 */
export function detectProvider(input: {
  from: string;
  subject?: string | null;
  text?: string | null;
  hint?: MarketplaceProvider | null;
}): MarketplaceProvider | null {
  const subject = input.subject ?? "";
  const body = input.text ?? "";

  const fromDomain = domainOf(input.from);
  if (fromDomain) {
    const byFrom = matchDomain(fromDomain, subject, body);
    if (byFrom) return byFrom;
  }

  const forwardedFrom = /^\s*(?:from|de)\s*:[^\n]*$/gim;
  for (const line of body.slice(0, 4000).match(forwardedFrom) ?? []) {
    const d = domainOf(line);
    if (!d) continue;
    const byFwd = matchDomain(d, subject, body);
    if (byFwd) return byFwd;
  }

  return input.hint ?? null;
}

// ---------------------------------------------------------------------
// Webhook (JSON / form) parsing
// ---------------------------------------------------------------------

interface Entry {
  key: string;
  parent: string;
  depth: number;
  value: string | number | boolean;
}

const MAX_ENTRIES = 600;
const MAX_DEPTH = 5;

function flatten(root: unknown): Entry[] {
  const out: Entry[] = [];
  const queue: Array<{ node: unknown; parent: string; depth: number }> = [{ node: root, parent: "", depth: 0 }];
  while (queue.length && out.length < MAX_ENTRIES) {
    const { node, parent, depth } = queue.shift()!;
    if (Array.isArray(node)) {
      if (depth < MAX_DEPTH) for (const item of node.slice(0, 50)) if (item && typeof item === "object") queue.push({ node: item, parent, depth: depth + 1 });
      continue;
    }
    if (!node || typeof node !== "object") continue;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const key = normKey(k);
      if (v !== null && typeof v === "object") {
        if (depth < MAX_DEPTH) queue.push({ node: v, parent: key, depth: depth + 1 });
      } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out.push({ key, parent, depth, value: v });
      }
    }
  }
  return out;
}

function candidates(entries: Entry[], aliases: string[], parentOk?: (parent: string) => boolean): Entry[] {
  const found: Entry[] = [];
  for (const alias of aliases) {
    const hits = entries
      .filter((e) => e.key === alias && (!parentOk || parentOk(e.parent)) && clean(e.value) !== null)
      .sort((a, b) => a.depth - b.depth);
    found.push(...hits);
  }
  return found;
}

function pickText(entries: Entry[], aliases: string[], parentOk?: (parent: string) => boolean, max = MAX_FIELD): string | null {
  const hit = candidates(entries, aliases, parentOk)[0];
  return hit ? clean(hit.value, max) : null;
}

const PERSON_PARENTS = new Set(["", "customer", "consumer", "contact", "contactdetails", "lead", "client", "user", "homeowner", "requester", "person", "owner"]);
const SERVICE_PARENTS = new Set(["category", "service", "task", "request", "job", "project"]);
const COST_PARENTS = new Set(["price", "cost", "fee", "charge", "leadprice", "leadcost", "leadfee", "leadcharge", "pricing", "billing"]);

function collectQa(root: unknown): string[] {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number) => {
    if (lines.length >= 12 || depth > MAX_DEPTH || !node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 40)) walk(item, depth + 1);
      return;
    }
    const rec = node as Record<string, unknown>;
    const keys = Object.keys(rec).reduce<Record<string, string>>((acc, k) => ((acc[normKey(k)] = k), acc), {});
    const q = keys.question ? clean(rec[keys.question], 160) : null;
    const a = keys.answer ? clean(Array.isArray(rec[keys.answer]) ? (rec[keys.answer] as unknown[]).join(", ") : rec[keys.answer], 200) : null;
    if (q && a) lines.push(`${q}: ${a}`);
    for (const v of Object.values(rec)) walk(v, depth + 1);
  };
  walk(root, 0);
  return lines;
}

function composeLocation(entries: Entry[]): string | null {
  const street = pickText(entries, ["addressfirstline", "street", "streetaddress", "address1", "addressline1", "line1", "addressline"]);
  const city = pickText(entries, ["city", "town", "locality"]);
  const state = pickText(entries, ["state", "region", "province", "statecode"]);
  const zip = pickText(entries, ["postalcode", "zipcode", "zip", "postcode"]);
  const parts = [street, city, [state, zip].filter(Boolean).join(" ") || null].filter(Boolean) as string[];
  if (parts.length) return parts.join(", ").slice(0, MAX_FIELD);
  return pickText(entries, ["location", "address", "serviceaddress", "joblocation", "customerlocation", "area"]);
}

function countSignals(lead: Omit<ParsedLead, "warnings" | "provider">): number {
  return [lead.externalId, lead.name, lead.phone, lead.email, lead.service, lead.location, lead.message].filter(Boolean).length;
}

export function parseWebhookPayload(provider: MarketplaceProvider, body: unknown): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "invalid_payload", detail: "Body is not a JSON object." };
  }
  const entries = flatten(body);
  const warnings: string[] = [];

  const first = pickText(entries, ["firstname", "givenname"]);
  const last = pickText(entries, ["lastname", "surname", "familyname"]);
  const fullFromParts = [first, last].filter(Boolean).join(" ") || null;
  const name =
    pickText(entries, ["fullname", "customername", "consumername", "contactname", "clientname", "displayname"]) ??
    fullFromParts ??
    pickText(entries, ["name"], (p) => PERSON_PARENTS.has(p));

  let phone: string | null = null;
  for (const e of candidates(entries, ["phone", "phonenumber", "primaryphone", "mobile", "mobilephone", "cell", "cellphone", "customerphone", "consumerphone", "telephone", "homephone", "secondaryphone"])) {
    phone = normalizePhone(e.value);
    if (phone) break;
  }

  let email: string | null = null;
  for (const e of candidates(entries, ["email", "emailaddress", "customeremail", "consumeremail", "primaryemail"])) {
    email = normalizeEmail(e.value);
    if (email) break;
  }

  const serviceRaw =
    pickText(entries, ["category", "categoryname", "service", "servicename", "servicetype", "servicerequested", "tasktype", "taskname", "jobtype", "projecttype", "requesttype", "subcategory", "categoryid", "serviceid"]) ??
    pickText(entries, ["name", "title"], (p) => SERVICE_PARENTS.has(p));
  const service = serviceRaw ? humanizeService(serviceRaw) : null;

  const baseMessage = pickText(
    entries,
    ["description", "details", "comments", "comment", "message", "customermessage", "taskdescription", "requestdescription", "projectdescription", "note", "notes", "additionaldetails"],
    undefined,
    MAX_MESSAGE,
  );
  const qa = collectQa(body);
  const message = [baseMessage, ...qa].filter(Boolean).join("\n").slice(0, MAX_MESSAGE) || null;

  const externalId =
    pickText(entries, ["leadid", "leadoid", "alleadid", "apileadid", "correlationid", "negotiationid", "negotiationpk", "requestid", "requestpk", "leadkey"]) ??
    pickText(entries, ["id"], (p) => p === "" || p === "lead");

  let costCents: number | null = null;
  for (const e of candidates(entries, ["costcents", "pricecents", "leadcostcents", "leadpricecents", "feecents", "chargecents", "amountcents"])) {
    costCents = parseMoneyToCents(e.value, true);
    if (costCents !== null) break;
  }
  if (costCents === null) {
    const dollars = [
      ...candidates(entries, ["leadprice", "leadcost", "leadfee", "leadcharge", "leadamount", "chargeamount", "price", "cost", "fee", "charge"]),
      ...candidates(entries, ["amount", "value", "total"], (p) => COST_PARENTS.has(p)),
    ];
    for (const e of dollars) {
      costCents = parseMoneyToCents(e.value, false);
      if (costCents !== null) break;
    }
    if (costCents === null && dollars.length) warnings.push("cost_unparseable_or_out_of_range");
  }

  const location = composeLocation(entries);

  const partial = { externalId, name, phone, email, service, location, message, costCents };
  if (countSignals(partial) === 0) {
    return { ok: false, reason: "no_recognized_fields", detail: "No known lead fields were found in the payload." };
  }
  if (!phone && !email) warnings.push("no_contact_info");

  return { ok: true, lead: { provider, ...partial, warnings } };
}

// ---------------------------------------------------------------------
// Email parsing
// ---------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)));
}

export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ": ")
    .replace(/<br\s*\/?>|<\/(?:p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withBreaks)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

const LABELS = {
  name: /^(?:(?:customer|client|consumer|homeowner|contact|lead|full|requester)(?:'s|’s)?\s+)?name$/i,
  firstName: /^first\s*name$/i,
  lastName: /^last\s*name$/i,
  phone: /^(?:(?:customer|client|contact|cell|mobile|home|primary|day(?:time)?)(?:'s|’s)?\s+)?(?:phone|telephone|mobile|cell)(?:\s*(?:number|no\.?|#))?$/i,
  email: /^(?:(?:customer|client|contact|primary)(?:'s|’s)?\s+)?e-?mail(?:\s*address)?$/i,
  service: /^(?:service(?:\s*(?:needed|requested|category|type))?|(?:job|project|request|task)\s*type|category|what do you need|type of service|task|project|job)$/i,
  location: /^(?:(?:service|job|project|customer)\s+)?(?:location|address|city|zip(?:\s*code)?|postal\s*code|city\/state|area)$/i,
  message: /^(?:(?:project|job|request|customer)\s+)?(?:description|details|message|comments?|notes?)$|^additional\s+(?:details|info(?:rmation)?)$/i,
  externalId: /^(?:lead|request|job|project|reference|confirmation|negotiation)\s*(?:id|number|no\.?|#)$/i,
  cost: /^(?:lead\s+)?(?:cost|fee|price|charge|amount charged)$/i,
} as const;

type LabelKey = keyof typeof LABELS;

function labelKeyOf(label: string): LabelKey | null {
  for (const key of Object.keys(LABELS) as LabelKey[]) if (LABELS[key].test(label.trim())) return key;
  return null;
}

function extractLabeled(text: string): Partial<Record<LabelKey, string[]>> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 400);
  const out: Partial<Record<LabelKey, string[]>> = {};
  const push = (key: LabelKey, value: string) => {
    const v = value.trim();
    if (!v) return;
    (out[key] ??= []).push(v);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z][A-Za-z0-9 /&'’#.-]{1,40}?)\s*[:：]\s*(.*)$/);
    if (m) {
      const key = labelKeyOf(m[1]);
      if (!key) continue;
      let value = m[2];
      if (!value && lines[i + 1] && !/^[A-Za-z][A-Za-z0-9 /&'’#.-]{1,40}?\s*[:：]/.test(lines[i + 1])) value = lines[++i];
      push(key, value);
    } else if (line.length <= 40) {
      // "Phone" on one line, value on the next (common in HTML-derived text)
      const key = labelKeyOf(line);
      if (key && lines[i + 1] && !labelKeyOf(lines[i + 1])) push(key, lines[++i]);
    }
  }
  return out;
}

const FOOTER = /unsubscribe|privacy policy|©|\(c\)\s*\d{4}|terms of (?:use|service)|you are receiving this|customer (?:service|support)/i;

function cutFooter(text: string): string {
  const idx = text.search(FOOTER);
  return idx > 150 ? text.slice(0, idx) : text;
}

const PHONE_SCAN = /(?:\+?1[\s.\-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[\s.\-]?\d{3}[\s.\-]?\d{4}/;
const COST_SENTENCES: RegExp[] = [
  /lead\s*(?:cost|fee|price|charge)s?\D{0,25}\$\s*([\d,]+(?:\.\d{1,2})?)/i,
  /(?:charged|billed)\D{0,40}\$\s*([\d,]+(?:\.\d{1,2})?)/i,
  /\$\s*([\d,]+(?:\.\d{1,2})?)\s*(?:for this lead|lead fee|per lead)/i,
  /(?:cost|price|fee)s?\s*(?:is|of|:)?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i,
];

function nameFromSubject(subject: string): string | null {
  const valid = (s: string) => /^[\p{L}][\p{L}'’.\- ]{1,39}$/u.test(s) && s.split(/\s+/).length <= 4 && !/\b(lead|request|customer|message|new|you)\b/i.test(s);
  const patterns = [
    /^(.{2,40}?)\s+(?:is looking for|wants|needs|sent you a request|requested|has a new|is requesting)/i,
    /new\s+(?:lead|customer|request|message)[^:\u2013\u2014-]{0,30}[:\u2013\u2014-]\s*(.{2,40})$/i,
  ];
  for (const p of patterns) {
    const m = subject.trim().match(p);
    if (m && valid(m[1].trim())) return m[1].trim();
  }
  return null;
}

export interface EmailInput {
  from: string;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
}

export function parseMarketplaceEmail(provider: MarketplaceProvider, input: EmailInput): ParseResult {
  const subject = clean(input.subject, 300) ?? "";
  const bodyRaw = (input.text && input.text.trim()) || (input.html ? htmlToText(input.html) : "");
  if (!bodyRaw) return { ok: false, reason: "invalid_payload", detail: "Email has no readable body." };
  const body = bodyRaw.slice(0, 20_000);
  const warnings: string[] = [];

  const labeled = extractLabeled(body);
  const firstOf = (k: LabelKey) => labeled[k]?.[0] ?? null;

  let name = clean(firstOf("name"), 120);
  if (!name) {
    const joined = [clean(firstOf("firstName"), 60), clean(firstOf("lastName"), 60)].filter(Boolean).join(" ");
    name = joined || null;
  }
  if (!name) name = nameFromSubject(subject);

  let phone: string | null = null;
  for (const v of labeled.phone ?? []) {
    phone = normalizePhone(v);
    if (phone) break;
  }
  const scanArea = cutFooter(body);
  if (!phone) {
    const m = scanArea.slice(0, 3000).match(PHONE_SCAN);
    phone = m ? normalizePhone(m[0]) : null;
    if (phone) warnings.push("phone_from_body_scan");
  }

  let email: string | null = null;
  for (const v of labeled.email ?? []) {
    email = normalizeEmail(v);
    if (email) break;
  }
  if (!email) {
    const ignoredDomains = new Set<string>([...Object.values(PROVIDER_DOMAINS).flat(), domainOf(input.from) ?? ""]);
    const all = scanArea.slice(0, 3000).match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
    for (const candidate of all) {
      const lower = candidate.toLowerCase();
      const d = lower.split("@")[1];
      const blocked = [...ignoredDomains].some((x) => x && (d === x || d.endsWith(`.${x}`)));
      if (blocked || /^(?:no-?reply|do-?not-?reply|mailer-daemon|support|help|info)@/.test(lower)) continue;
      email = lower;
      warnings.push("email_from_body_scan");
      break;
    }
  }

  const serviceRaw = clean(firstOf("service"), 160);
  const service = serviceRaw ? humanizeService(serviceRaw) : null;

  const locationParts = [...new Set((labeled.location ?? []).map((v) => clean(v, 160)).filter(Boolean) as string[])].slice(0, 3);
  const location = locationParts.length ? locationParts.join(", ") : null;

  const message = clean((labeled.message ?? []).join("\n").replace(/\n/g, " "), MAX_MESSAGE);
  const externalId = clean(firstOf("externalId"), 120);

  let costCents: number | null = null;
  for (const v of labeled.cost ?? []) {
    costCents = parseMoneyToCents(v);
    if (costCents !== null) break;
  }
  if (costCents === null) {
    for (const re of COST_SENTENCES) {
      const m = `${subject}\n${scanArea}`.match(re);
      if (m) {
        costCents = parseMoneyToCents(m[1]);
        if (costCents !== null) break;
      }
    }
  }

  const partial = { externalId, name, phone, email, service, location, message, costCents };
  if (countSignals(partial) === 0) {
    return { ok: false, reason: "no_recognized_fields", detail: "No known lead fields were found in the email." };
  }
  if (!phone && !email) warnings.push("no_contact_info");

  return { ok: true, lead: { provider, ...partial, warnings } };
}

// ---------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------

/**
 * Contact + provider + UTC day. Contact-first on purpose: a marketplace that
 * sends BOTH a webhook and a notification email for one lead (or retries)
 * collapses to one lead, even though only one of them carries an external id.
 * Falls back to the external id; returns null when neither exists (no dedupe).
 */
export function buildDedupeKey(provider: MarketplaceProvider, lead: ParsedLead, receivedAtIso: string): string | null {
  const day = receivedAtIso.slice(0, 10);
  const contact = lead.phone ? lead.phone.replace(/\D/g, "").slice(-10) : lead.email;
  if (contact) return `${provider}:c:${contact}:${day}`;
  if (lead.externalId) return `${provider}:x:${lead.externalId}`;
  return null;
}
