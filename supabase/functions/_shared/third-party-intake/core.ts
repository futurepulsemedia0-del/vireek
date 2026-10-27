// supabase/functions/_shared/third-party-intake/core.ts
//
// PURE logic (no Deno / Supabase imports) so it is unit-tested with Vitest:
// normalising partner API payloads, best-effort parsing of partner emails,
// sender -> partner matching and idempotency keys.
//
// Design rule: a request from a known partner is NEVER dropped. Anything we
// cannot read is stored as-is with `reviewReasons`, so a human sees it.

export type Priority = "standard" | "urgent" | "emergency";

export interface ParsedIntake {
  externalRef: string | null;
  title: string;
  description: string | null;
  serviceType: string | null;
  priority: Priority;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  serviceAddress: string | null;
  policyNumber: string | null;
  nteCents: number | null;
  preAuthorized: boolean;
  authorizedCents: number | null;
  /** ISO deadline supplied by the partner (future only), else null. */
  dueAt: string | null;
  reviewReasons: string[];
}

export type ParseResult =
  | { ok: true; intake: ParsedIntake }
  | { ok: false; reason: string; detail: string };

export interface InboundMail {
  from: string;
  subject: string | null;
  text: string | null;
  html: string | null;
}

const MAX = { title: 200, description: 5000, short: 120, name: 200, phone: 40, email: 200, address: 300 };
const MAX_CENTS = 2_147_483_647;

// ------------------------------------------------------------------
// Scalar cleaners
// ------------------------------------------------------------------
export function clean(value: unknown, max: number, keepNewlines = false): string | null {
  if (value === null || value === undefined) return null;
  const raw = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  const noCtl = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/\r\n?/g, "\n");
  const s = keepNewlines
    ? noCtl.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
    : noCtl.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

export function parseMoneyToCents(value: unknown): number | null {
  let cents: number | null = null;
  if (typeof value === "number") {
    cents = Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
  } else if (typeof value === "string") {
    const m = value.replace(/,/g, "").match(/(\d{1,8}(?:\.\d{1,2})?)/);
    cents = m ? Math.round(Number(m[1]) * 100) : null;
  }
  return cents !== null && cents <= MAX_CENTS ? cents : null;
}

function parseCentsInt(value: unknown): number | null {
  const n = typeof value === "string" && /^\d{1,10}$/.test(value.trim()) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_CENTS ? n : null;
}

export function normalizePhone(value: unknown): string | null {
  const s = clean(value, MAX.phone);
  return s && s.replace(/\D/g, "").length >= 7 ? s : null;
}

export function normalizeEmail(value: unknown): string | null {
  const s = clean(value, MAX.email)?.toLowerCase() ?? null;
  return s && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s) ? s : null;
}

export function normalizePriority(value: unknown): Priority | null {
  const s = String(value ?? "").toLowerCase();
  if (!s.trim()) return null;
  if (/emerg|critical|\bp1\b|asap|same[- ]?day/.test(s)) return "emergency";
  if (/urgent|high|rush|expedite|\bp2\b/.test(s)) return "urgent";
  if (/routine|standard|normal|low|regular/.test(s)) return "standard";
  return null;
}

export function parseDue(value: unknown, nowMs: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  if (!Number.isFinite(ms) || ms <= nowMs || ms > nowMs + 366 * 86_400_000) return null;
  return new Date(ms).toISOString();
}

const truthy = (v: unknown) => v === true || (typeof v === "string" && /^(true|yes|y|1)$/i.test(v.trim())) || v === 1;

// ------------------------------------------------------------------
// API payload
// ------------------------------------------------------------------
type Dict = Record<string, unknown>;

/** Lower-cases keys and drops "_", "-", " " so claim_number / claimNumber / Claim Number all match. */
function normalizeKeys(obj: Dict, depth = 0): Dict {
  const out: Dict = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!key) continue;
    out[key] = v && typeof v === "object" && !Array.isArray(v) && depth < 2 ? normalizeKeys(v as Dict, depth + 1) : v;
  }
  return out;
}

function get(obj: Dict, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split(".")) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Dict)[k];
    else return undefined;
  }
  return cur;
}

function pick(obj: Dict, paths: string[]): unknown {
  for (const p of paths) {
    const v = get(obj, p);
    if (v !== undefined && v !== null && v !== "" && !(typeof v === "object")) return v;
  }
  return undefined;
}

const ALIASES = {
  ref: ["externalref", "reference", "referenceid", "referencenumber", "claimnumber", "claimno", "claimid", "authorizationnumber", "authorizationid", "authnumber", "ponumber", "workordernumber", "workorderid", "servicerequestnumber", "dispatchnumber", "id"],
  title: ["title", "summary", "jobtitle", "subject", "problem", "issue", "servicerequested"],
  description: ["description", "details", "problemdescription", "issuedescription", "notes", "scope", "scopeofwork", "comments"],
  service: ["servicetype", "trade", "category", "service", "appliance", "equipmenttype"],
  priority: ["priority", "urgency"],
  name: ["customername", "policyholder", "insured", "homeowner", "contactname", "clientname", "customer.name", "customer.fullname", "insured.name", "contact.name", "customer"],
  phone: ["customerphone", "phone", "contactphone", "phonenumber", "mobile", "customer.phone", "insured.phone", "contact.phone"],
  email: ["customeremail", "email", "contactemail", "customer.email", "insured.email", "contact.email"],
  policy: ["policynumber", "policyno", "policy", "contractnumber", "planid", "coverageid"],
  nteCents: ["ntecents", "authorizedcents", "authorizedamountcents", "limitcents"],
  nte: ["nte", "nteamount", "nottoexceed", "authorizedamount", "authorizationamount", "authorizationlimit", "servicelimit", "coveragelimit", "limit"],
  authCents: ["authorizedcents", "authorizedamountcents"],
  authAmount: ["authorizedamount", "authorizationamount"],
  preAuth: ["preauthorized", "authorized", "isauthorized", "preapproved"],
  due: ["dueat", "duedate", "deadline", "completeby", "dueby"],
};

function addressFrom(o: Dict): string | null {
  for (const p of ["serviceaddress", "address", "propertyaddress", "location", "siteaddress", "customer.address", "property.address", "insured.address"]) {
    const v = get(o, p);
    if (typeof v === "string" && v.trim()) return clean(v, MAX.address);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const a = v as Dict;
      const parts = [a.street ?? a.address1 ?? a.line1 ?? a.address, a.city, a.state ?? a.region, a.zip ?? a.postalcode ?? a.postal]
        .map((x) => clean(x, 120))
        .filter(Boolean);
      if (parts.length) return clean(parts.join(", "), MAX.address);
    }
  }
  return null;
}

function reviewReasonsFor(i: Pick<ParsedIntake, "serviceAddress" | "customerPhone" | "customerEmail">): string[] {
  const reasons: string[] = [];
  if (!i.serviceAddress) reasons.push("Service address is missing");
  if (!i.customerPhone && !i.customerEmail) reasons.push("No customer phone or email");
  return reasons;
}

export function parseApiPayload(body: unknown, nowMs = Date.now()): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "invalid_json", detail: "The body must be a JSON object." };
  }
  const o = normalizeKeys(body as Dict);
  const description = clean(pick(o, ALIASES.description), MAX.description, true);
  const titleRaw = clean(pick(o, ALIASES.title), MAX.title);
  if (!titleRaw && !description) {
    return { ok: false, reason: "missing_description", detail: "Send a title or a description of the work." };
  }
  const title = titleRaw ?? clean(description!.split("\n")[0], MAX.title) ?? "Work order request";

  const ntePrimary = parseCentsInt(pick(o, ALIASES.nteCents)) ?? parseMoneyToCents(pick(o, ALIASES.nte));
  const authCents = parseCentsInt(pick(o, ALIASES.authCents)) ?? parseMoneyToCents(pick(o, ALIASES.authAmount));
  const preAuthorized = truthy(pick(o, ALIASES.preAuth)) || authCents !== null;

  const base = {
    serviceAddress: addressFrom(o),
    customerPhone: normalizePhone(pick(o, ALIASES.phone)),
    customerEmail: normalizeEmail(pick(o, ALIASES.email)),
  };
  return {
    ok: true,
    intake: {
      externalRef: clean(pick(o, ALIASES.ref), MAX.short),
      title,
      description,
      serviceType: clean(pick(o, ALIASES.service), MAX.short),
      priority: normalizePriority(pick(o, ALIASES.priority)) ?? "standard",
      customerName: clean(pick(o, ALIASES.name), MAX.name),
      policyNumber: clean(pick(o, ALIASES.policy), MAX.short),
      nteCents: ntePrimary ?? authCents,
      preAuthorized,
      authorizedCents: authCents,
      dueAt: parseDue(pick(o, ALIASES.due), nowMs),
      reviewReasons: reviewReasonsFor(base),
      ...base,
    },
  };
}

// ------------------------------------------------------------------
// Email
// ------------------------------------------------------------------
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\s*br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<\/t[dh]>/gi, ": ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}

const LABELS: Record<string, string> = {
  ref: "(?:claim|authori[sz]ation|auth|work\\s*order|wo|service\\s*request|dispatch|job|po|case|reference|ref)\\s*(?:#|no\\.?|number|id)?",
  name: "(?:customer(?:\\s*name)?|policy\\s*holder|policyholder|insured|home\\s*owner|homeowner|client|contact(?:\\s*name)?)",
  phone: "(?:(?:customer|contact|primary)\\s*)?(?:phone|telephone|tel|mobile|cell)(?:\\s*(?:#|no\\.?|number))?",
  email: "(?:(?:customer|contact)\\s*)?e-?mail(?:\\s*address)?",
  address: "(?:(?:service|property|site|job)\\s*)?(?:address|location)",
  policy: "(?:policy|contract|plan)\\s*(?:#|no\\.?|number|id)?",
  nte: "(?:nte|not[- ]to[- ]exceed|authori[sz]ed\\s*amount|authori[sz]ation\\s*(?:limit|amount)|service\\s*limit)",
  problem: "(?:problem|issue|complaint|description|reported\\s*issue|work\\s*requested|scope(?:\\s*of\\s*work)?|details)",
  service: "(?:service\\s*type|type\\s*of\\s*service|trade|category|appliance|equipment)",
  priority: "(?:priority|urgency)",
  due: "(?:due(?:\\s*date)?|deadline|complete\\s*by|due\\s*by)",
};

function field(text: string, key: keyof typeof LABELS): string | null {
  const re = new RegExp(`^[ \\t>*\\u2022-]*(?:${LABELS[key]})\\s*[:=\\u2013-]\\s*(.+?)\\s*$`, "im");
  const m = text.match(re);
  return m ? m[1].replace(/[:\s]+$/, "") || null : null;
}

export function parseEmail(mail: InboundMail, nowMs = Date.now()): ParseResult {
  const body = clean(mail.text && mail.text.trim() ? mail.text : mail.html ? stripHtml(mail.html) : "", MAX.description * 2, true) ?? "";
  const subject = clean((mail.subject ?? "").replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, ""), MAX.title);

  const fields = {
    ref: field(body, "ref"), name: field(body, "name"), phone: field(body, "phone"), email: field(body, "email"),
    address: field(body, "address"), policy: field(body, "policy"), nte: field(body, "nte"),
    problem: field(body, "problem"), service: field(body, "service"), priority: field(body, "priority"), due: field(body, "due"),
  };
  const labeled = Object.values(fields).filter(Boolean).length;

  const base = {
    serviceAddress: clean(fields.address, MAX.address),
    customerPhone: normalizePhone(fields.phone),
    customerEmail: normalizeEmail(fields.email),
  };
  const reasons = reviewReasonsFor(base);
  if (labeled < 2) reasons.unshift("Could not read structured fields from the email");

  const priority = normalizePriority(fields.priority)
    ?? (/\b(emergency|asap)\b/i.test(subject ?? "") ? "emergency" : /\b(urgent|rush)\b/i.test(subject ?? "") ? "urgent" : "standard");

  return {
    ok: true,
    intake: {
      externalRef: clean(fields.ref, MAX.short) ?? clean(subject?.match(/\b(?:claim|auth|wo|ref|po)\s*#?\s*[:\-]?\s*([A-Z0-9][A-Z0-9-]{3,})/i)?.[1], MAX.short),
      title: subject ?? clean(fields.problem, MAX.title) ?? "Work order request (email)",
      description: clean(body, MAX.description, true),
      serviceType: clean(fields.service, MAX.short),
      priority,
      customerName: clean(fields.name, MAX.name),
      policyNumber: clean(fields.policy, MAX.short),
      nteCents: parseMoneyToCents(fields.nte),
      preAuthorized: false,
      authorizedCents: null,
      dueAt: parseDue(fields.due, nowMs),
      reviewReasons: reasons,
      ...base,
    },
  };
}

// ------------------------------------------------------------------
// Sender -> partner
// ------------------------------------------------------------------
export function senderDomain(from: string): string | null {
  const m = from.match(/<([^>]+)>/);
  const addr = (m ? m[1] : from).trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 1) return null;
  const d = addr.slice(at + 1).replace(/[>\s]+$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

export interface PayerMatchRow {
  id: string;
  email_tag: string | null;
  sender_domains: string[];
}

/**
 * The secret alias tag (`<token>+<tag>@domain`) wins. A sender-domain match is
 * accepted only when exactly one partner claims that domain, and is reported
 * as `via: "domain"` so the caller can flag the request for review (From can be forged).
 */
export function matchPayer<T extends PayerMatchRow>(payers: T[], tag: string | null, fromDomain: string | null): { payer: T; via: "tag" | "domain" } | null {
  if (tag) {
    const t = payers.find((p) => p.email_tag && p.email_tag.toLowerCase() === tag.toLowerCase());
    if (t) return { payer: t, via: "tag" };
  }
  if (fromDomain) {
    const hits = payers.filter((p) => p.sender_domains.some((d) => d.toLowerCase() === fromDomain || fromDomain.endsWith(`.${d.toLowerCase()}`)));
    if (hits.length === 1) return { payer: hits[0], via: "domain" };
  }
  return null;
}

// ------------------------------------------------------------------
// Idempotency
// ------------------------------------------------------------------
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Same partner + same reference (or same content) => same key => the retry is a no-op duplicate. */
export async function buildDedupeKey(payerId: string, intake: Pick<ParsedIntake, "externalRef">, raw: string): Promise<string> {
  if (intake.externalRef) return `p:${payerId}:ref:${intake.externalRef.toLowerCase().replace(/\s+/g, "")}`;
  return `p:${payerId}:h:${(await sha256Hex(raw.slice(0, 4000))).slice(0, 40)}`;
}
