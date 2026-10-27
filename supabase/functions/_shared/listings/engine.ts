// supabase/functions/_shared/listings/engine.ts
//
// Pure, deterministic Listing Sync rules. No I/O and no clock reads (callers
// pass `now`), so it is unit-tested (src/lib/listings.test.ts) and shared by
// the listings / listings-sync edge functions AND the dashboard.
//
// Honesty rules: a listing is only "synced" when a provider call actually
// succeeded (push) or a remote read matched the canonical record (check).
// Directories without a write API are labelled "manual" — we hand the owner a
// copy-ready record and only record "updated" when they confirm it.

export type ListingPlatform = "apple" | "bing" | "yelp" | "facebook";
export type LinkMode = "push" | "monitor" | "manual";
export type LinkState = "pending" | "synced" | "drift" | "blocked" | "error" | "needs_reauth";
export type WeekdayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type DriftField = "name" | "phone" | "address" | "website" | "hours" | "status";

export const LISTING_PLATFORMS: ListingPlatform[] = ["apple", "bing", "yelp", "facebook"];
export const LISTING_PLATFORM_LABEL: Record<ListingPlatform, string> = {
  apple: "Apple Business Connect",
  bing: "Bing Places",
  yelp: "Yelp",
  facebook: "Facebook",
};
export const DRIFT_FIELD_LABEL: Record<DriftField, string> = {
  name: "Business name",
  phone: "Phone",
  address: "Address",
  website: "Website",
  hours: "Opening hours",
  status: "Open / closed status",
};

export const WEEKDAY_KEYS: WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * What each directory's API really allows.
 *  - apple / bing: partner-only write APIs. Vireek holds ONE set of partner credentials (env)
 *    and each customer location is linked by its Apple / Bing location id. Push stays OFF until
 *    the operator sets *_PUSH_ENABLED (same safety rail as GBP_APPLY_ENABLED); otherwise manual-assist.
 *  - yelp: Fusion is read-only -> we MONITOR for drift; owner edits on Yelp.
 *  - facebook: Graph API can edit phone / website / address / hours (not the Page name).
 * `credentials` tells the UI which connect flow to show.
 */
export const LISTING_CAPS: Record<
  ListingPlatform,
  { push: boolean; monitor: boolean; credentials: "oauth" | "location_id" | "yelp_url"; externalLabel: string; note: string }
> = {
  apple: {
    push: true,
    monitor: true,
    credentials: "location_id",
    externalLabel: "Apple location ID",
    note: "Shows your business in Apple Maps, Siri and Wallet. Updates need Apple Business Connect partner access — until it's enabled you get a copy-ready record to paste.",
  },
  bing: {
    push: true,
    monitor: true,
    credentials: "location_id",
    externalLabel: "Bing Places store code",
    note: "Feeds Bing, Microsoft Copilot and DuckDuckGo maps. Updates need Bing Places partner access — until it's enabled you get a copy-ready record to paste.",
  },
  yelp: {
    push: false,
    monitor: true,
    credentials: "yelp_url",
    externalLabel: "Yelp business page",
    note: "Yelp doesn't allow updates by API. We check your Yelp page every day and flag anything that no longer matches.",
  },
  facebook: {
    push: true,
    monitor: true,
    credentials: "oauth",
    externalLabel: "Facebook Page",
    note: "Phone, website, address and hours update automatically. Facebook only lets Page admins rename a Page on Facebook itself.",
  },
};

// ---------------------------------------------------------------------
// Canonical record
// ---------------------------------------------------------------------

export interface DayHours {
  closed: boolean;
  open: string;
  close: string;
}
export type HoursMap = Record<WeekdayKey, DayHours>;

export interface LocationInput {
  name?: string | null;
  status?: string | null;
  phone?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  business_hours?: unknown;
}

export interface ListingSettingsInput {
  website_url?: string | null;
  description?: string | null;
}

export interface Canonical {
  name: string;
  status: "active" | "inactive";
  phone: string | null;
  address: { line1: string; line2: string; city: string; region: string; postalCode: string; country: string };
  website: string | null;
  description: string | null;
  hours: HoursMap;
}

export const NAME_MAX = 120;
export const DESCRIPTION_MAX = 750;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function clip(input: unknown, max: number): string {
  return String(input ?? "").replace(/\r\n?/g, "\n").replace(CONTROL, "").trim().slice(0, max);
}

const oneLine = (v: unknown, max: number) => clip(v, max).replace(/\s+/g, " ");

/** E.164 for US/CA numbers typed any common way, or any number already written with a leading +. */
export function normalizePhone(input: unknown, country = "US"): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (country === "US" || country === "CA") {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  }
  return null;
}

/** https only; bare hosts get https://. Returns null for anything that isn't a plain web address. */
export function normalizeWebsite(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".")) return null;
    u.protocol = "https:";
    u.hash = "";
    return u.toString().replace(/\/$/, "").slice(0, 300);
  } catch {
    return null;
  }
}

const DEFAULT_DAY: DayHours = { closed: true, open: "08:00", close: "17:00" };

export function normalizeHours(raw: unknown): HoursMap {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = {} as HoursMap;
  for (const k of WEEKDAY_KEYS) {
    const d = src[k] && typeof src[k] === "object" ? (src[k] as Record<string, unknown>) : {};
    out[k] = {
      closed: typeof d.closed === "boolean" ? d.closed : DEFAULT_DAY.closed,
      open: typeof d.open === "string" ? d.open : DEFAULT_DAY.open,
      close: typeof d.close === "string" ? d.close : DEFAULT_DAY.close,
    };
  }
  return out;
}

export function buildCanonical(loc: LocationInput, settings: ListingSettingsInput, brandWebsite?: string | null): Canonical {
  const country = String(loc.country ?? "US").toUpperCase().slice(0, 2) || "US";
  return {
    name: oneLine(loc.name, NAME_MAX),
    status: loc.status === "active" ? "active" : "inactive",
    phone: normalizePhone(loc.phone, country),
    address: {
      line1: oneLine(loc.address_line1, 120),
      line2: oneLine(loc.address_line2, 120),
      city: oneLine(loc.city, 80),
      region: oneLine(loc.state, 40),
      postalCode: oneLine(loc.postal_code, 20),
      country,
    },
    website: normalizeWebsite(settings.website_url) ?? normalizeWebsite(brandWebsite),
    description: clip(settings.description, DESCRIPTION_MAX) || null,
    hours: normalizeHours(loc.business_hours),
  };
}

// ---------------------------------------------------------------------
// Stable hash (change detection, not security)
// ---------------------------------------------------------------------

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/** cyrb53 -> 14 hex chars. Deterministic and identical on Deno, Node and browsers. */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export const canonicalHash = (c: Canonical): string => hashString(stableStringify(c));

// ---------------------------------------------------------------------
// Readiness validation
// ---------------------------------------------------------------------

export interface ListingIssue {
  code: string;
  field: DriftField | "description";
  message: string;
  blocking: boolean;
}

/** Blocking issues stop every sync (we never publish a half-empty listing); warnings only inform. */
export function validateCanonical(c: Canonical): ListingIssue[] {
  const issues: ListingIssue[] = [];
  const add = (code: string, field: ListingIssue["field"], message: string, blocking: boolean) => issues.push({ code, field, message, blocking });

  if (!c.name) add("name_missing", "name", "Add a business name.", true);
  if (!c.address.line1) add("address_line1_missing", "address", "Add the street address.", true);
  if (!c.address.city) add("city_missing", "address", "Add the city.", true);
  if (!c.address.postalCode) add("postal_missing", "address", "Add the postal code.", true);
  if (!/^[A-Z]{2}$/.test(c.address.country)) add("country_invalid", "address", "Use a 2-letter country code.", true);
  if (!c.phone) add("phone_invalid", "phone", "Add a phone number (outside the US/Canada start it with +country code).", true);

  let allClosed = true;
  for (const k of WEEKDAY_KEYS) {
    const d = c.hours[k];
    if (d.closed) continue;
    allClosed = false;
    if (!TIME_RE.test(d.open) || !TIME_RE.test(d.close) || d.open >= d.close) {
      add("hours_invalid", "hours", `Fix the ${k.toUpperCase()} hours (open must be before close).`, true);
      break;
    }
  }
  if (allClosed) add("hours_all_closed", "hours", "Every day is marked closed — directories will show you as closed all week.", false);
  if (!c.website) add("website_missing", "website", "Add a website so directories can link to you.", false);
  if (!c.description) add("description_missing", "description", "A short description improves how you appear in directories.", false);
  if (c.status !== "active") add("location_inactive", "status", "This location isn't active, so it is not synced.", false);
  return issues;
}

export const blockingIssues = (issues: ListingIssue[]) => issues.filter((i) => i.blocking);

// ---------------------------------------------------------------------
// Remote listings + drift detection
// ---------------------------------------------------------------------

/** What a directory currently shows. Any field a provider can't read stays undefined and is never counted as drift. */
export interface RemoteListing {
  name?: string;
  phone?: string | null;
  address?: { line1?: string; line2?: string; city?: string; region?: string; postalCode?: string };
  website?: string | null;
  hours?: Partial<Record<WeekdayKey, DayHours>>;
  permanentlyClosed?: boolean;
}

const ABBREVIATIONS: Record<string, string> = {
  street: "st", avenue: "ave", road: "rd", boulevard: "blvd", drive: "dr", lane: "ln", court: "ct", suite: "ste",
  highway: "hwy", parkway: "pkwy", place: "pl", north: "n", south: "s", east: "e", west: "w", and: "and",
};

/** Case, punctuation and common abbreviations never count as a mismatch. */
export function normText(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ABBREVIATIONS[t] ?? t)
    .join(" ");
}

export function phoneKey(v: unknown): string {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

export function websiteKey(v: unknown): string {
  const raw = String(v ?? "").trim();
  if (!raw) return "";
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return raw.toLowerCase();
  }
}

const hhmm = (v: string) => (/^\d{4}$/.test(v) ? `${v.slice(0, 2)}:${v.slice(2)}` : v);

function sameDay(a: DayHours, b: DayHours): boolean {
  if (a.closed || b.closed) return a.closed === b.closed;
  return hhmm(a.open) === hhmm(b.open) && hhmm(a.close) === hhmm(b.close);
}

export function compareRemote(c: Canonical, r: RemoteListing): DriftField[] {
  const out: DriftField[] = [];
  if (r.name !== undefined && normText(r.name) !== normText(c.name)) out.push("name");
  if (r.phone !== undefined && phoneKey(r.phone) !== phoneKey(c.phone)) out.push("phone");
  if (r.address) {
    const a = r.address;
    const street = (x: { line1?: string; line2?: string }) => normText(`${x.line1 ?? ""} ${x.line2 ?? ""}`);
    const differs =
      (a.line1 !== undefined && street(a) !== street(c.address)) ||
      (a.city !== undefined && normText(a.city) !== normText(c.address.city)) ||
      (a.region !== undefined && normText(a.region) !== normText(c.address.region)) ||
      (a.postalCode !== undefined && normText(a.postalCode).replace(/\s/g, "") !== normText(c.address.postalCode).replace(/\s/g, ""));
    if (differs) out.push("address");
  }
  if (r.website !== undefined && websiteKey(r.website) !== websiteKey(c.website)) out.push("website");
  if (r.hours && WEEKDAY_KEYS.some((k) => r.hours?.[k] && !sameDay(r.hours[k] as DayHours, c.hours[k]))) out.push("hours");
  if (r.permanentlyClosed === true && c.status === "active") out.push("status");
  return out;
}

// ---------------------------------------------------------------------
// Provider payload mappers + response normalizers (pure => testable)
// ---------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

/** Facebook Page "hours" map: mon_1_open / mon_1_close. Closed days are simply omitted. */
export function toFacebookHours(hours: HoursMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of WEEKDAY_KEYS) {
    if (hours[k].closed) continue;
    out[`${k}_1_open`] = hours[k].open;
    out[`${k}_1_close`] = hours[k].close;
  }
  return out;
}

export const singleLineAddress = (a: Canonical["address"]): string =>
  [[a.line1, a.line2].filter(Boolean).join(" "), a.city, [a.region, a.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");

/** Fields we write to a Facebook Page. The Page name is deliberately NOT pushed (Facebook gates renames). */
export function toFacebookPayload(c: Canonical): { fields: DriftField[]; body: Record<string, string> } {
  const body: Record<string, string> = { hours: JSON.stringify(toFacebookHours(c.hours)), single_line_address: singleLineAddress(c.address) };
  const fields: DriftField[] = ["hours", "address"];
  if (c.phone) { body.phone = c.phone; fields.push("phone"); }
  if (c.website) { body.website = c.website; fields.push("website"); }
  return { fields, body };
}

export function normalizeFacebookPage(r: Raw): RemoteListing {
  const loc = r?.location ?? {};
  const hours: Partial<Record<WeekdayKey, DayHours>> = {};
  if (r?.hours && typeof r.hours === "object") {
    for (const k of WEEKDAY_KEYS) {
      const open = r.hours[`${k}_1_open`];
      const close = r.hours[`${k}_1_close`];
      hours[k] = open && close ? { closed: false, open: String(open), close: String(close) } : { closed: true, open: "00:00", close: "00:00" };
    }
  }
  return {
    name: typeof r?.name === "string" ? r.name : undefined,
    phone: typeof r?.phone === "string" ? r.phone : r?.phone === null ? null : undefined,
    website: typeof r?.website === "string" ? r.website : undefined,
    address: loc.street || loc.city ? { line1: loc.street ?? "", city: loc.city ?? "", region: loc.state ?? "", postalCode: loc.zip ?? "" } : undefined,
    hours: r?.hours ? hours : undefined,
    permanentlyClosed: r?.permanently_closed === true ? true : undefined,
  };
}

/** Yelp Fusion business details (day 0 = Monday). Yelp doesn't expose the website. */
export function normalizeYelpBusiness(r: Raw): RemoteListing {
  const loc = r?.location ?? {};
  const regular = Array.isArray(r?.hours) ? r.hours.find((h: Raw) => h?.hours_type === "REGULAR") ?? r.hours[0] : null;
  let hours: RemoteListing["hours"];
  if (regular && Array.isArray(regular.open)) {
    hours = {};
    for (const k of WEEKDAY_KEYS) hours[k] = { closed: true, open: "00:00", close: "00:00" };
    for (const slot of regular.open) {
      const key = WEEKDAY_KEYS[Number(slot?.day)];
      if (!key || !slot?.start || !slot?.end) continue;
      const cur = hours[key] as DayHours;
      // Split shifts: keep the widest span so a lunch break never reads as drift.
      const open = hhmm(String(slot.start));
      const close = hhmm(String(slot.end));
      hours[key] = cur.closed ? { closed: false, open, close } : { closed: false, open: open < cur.open ? open : cur.open, close: close > cur.close ? close : cur.close };
    }
  }
  return {
    name: typeof r?.name === "string" ? r.name : undefined,
    phone: typeof r?.phone === "string" && r.phone ? r.phone : typeof r?.display_phone === "string" ? r.display_phone : undefined,
    address: r?.location ? { line1: loc.address1 ?? "", line2: [loc.address2, loc.address3].filter(Boolean).join(" "), city: loc.city ?? "", region: loc.state ?? "", postalCode: loc.zip_code ?? "" } : undefined,
    hours,
    permanentlyClosed: r?.is_closed === true ? true : undefined,
  };
}

/**
 * Neutral shape used for Apple Business Connect / Bing Places adapters. Provider
 * field names differ, so the normalizer accepts the common aliases; the adapter in
 * providers.ts is the only place that knows the real endpoint.
 */
export function toPartnerPayload(c: Canonical) {
  return {
    name: c.name,
    phone: c.phone,
    website: c.website,
    description: c.description,
    address: { line1: c.address.line1, line2: c.address.line2, city: c.address.city, region: c.address.region, postalCode: c.address.postalCode, country: c.address.country },
    hours: c.hours,
    status: c.status === "active" ? "OPEN" : "CLOSED",
  };
}

export function normalizePartnerRemote(r: Raw): RemoteListing {
  const a = r?.address ?? r?.location ?? null;
  const pick = (...vals: unknown[]) => vals.find((v) => typeof v === "string") as string | undefined;
  const status = String(r?.status ?? "").toUpperCase();
  return {
    name: pick(r?.name, r?.displayName),
    phone: pick(r?.phone, r?.telephone, r?.phoneNumber),
    website: pick(r?.website, r?.url, r?.websiteUri),
    address: a
      ? {
          line1: pick(a.line1, a.addressLine1, a.street) ?? "",
          line2: pick(a.line2, a.addressLine2) ?? "",
          city: pick(a.city, a.locality) ?? "",
          region: pick(a.region, a.state, a.administrativeArea) ?? "",
          postalCode: pick(a.postalCode, a.zip, a.zipCode) ?? "",
        }
      : undefined,
    hours: r?.hours && typeof r.hours === "object" ? (normalizeHours(r.hours) as Partial<Record<WeekdayKey, DayHours>>) : undefined,
    permanentlyClosed: status === "CLOSED" || status === "PERMANENTLY_CLOSED" ? true : undefined,
  };
}

// ---------------------------------------------------------------------
// Sync planning
// ---------------------------------------------------------------------

export const CHECK_INTERVAL_MS = 24 * 3_600_000; // re-verify each listing daily
export const REPUSH_COOLDOWN_MS = 6 * 3_600_000; // moderated platforms get time before we push again
export const ERROR_RETRY_MS = 3_600_000;

export type SyncAction = "blocked" | "manual" | "push" | "check" | "skip";

/** Mode a link runs in, given what the server has enabled. */
export function resolveMode(platform: ListingPlatform, env: { configured: boolean; pushEnabled: boolean }): LinkMode {
  const caps = LISTING_CAPS[platform];
  if (!env.configured) return "manual";
  if (caps.push && env.pushEnabled) return "push";
  return caps.monitor ? "monitor" : "manual";
}

export function decideAction(i: {
  mode: LinkMode;
  state: LinkState;
  hasBlocking: boolean;
  currentHash: string;
  lastPushedHash: string | null;
  lastPushedAt: string | null;
  lastCheckedAt: string | null;
  force: boolean;
  now: Date;
}): SyncAction {
  if (i.hasBlocking) return "blocked";
  if (i.mode === "manual") return "manual";
  const since = (iso: string | null) => (iso ? i.now.getTime() - new Date(iso).getTime() : Infinity);
  if (!i.force && i.state === "error" && since(i.lastCheckedAt) < ERROR_RETRY_MS) return "skip";
  const stale = i.lastPushedHash !== i.currentHash;
  const checkDue = since(i.lastCheckedAt) >= CHECK_INTERVAL_MS;

  if (i.mode === "push") {
    if (i.force || stale || i.state === "pending") return "push";
    if (i.state === "drift" && since(i.lastPushedAt) >= REPUSH_COOLDOWN_MS) return "push";
    return checkDue ? "check" : "skip";
  }
  // monitor
  return i.force || stale || i.state === "pending" || checkDue ? "check" : "skip";
}

/** Manual links: "synced" only while the record the owner confirmed is still the current one. */
export function manualState(currentHash: string, lastPushedHash: string | null): LinkState {
  return lastPushedHash === currentHash ? "synced" : "pending";
}

// ---------------------------------------------------------------------
// Presentation helpers shared with the UI
// ---------------------------------------------------------------------

export const STATE_LABEL: Record<LinkState, string> = {
  pending: "Update needed",
  synced: "In sync",
  drift: "Out of date",
  blocked: "Needs details",
  error: "Sync error",
  needs_reauth: "Reconnect needed",
};

export const MODE_LABEL: Record<LinkMode, string> = {
  push: "Auto-updates",
  monitor: "Monitored daily",
  manual: "Copy & paste",
};

export interface HealthSummary {
  total: number;
  synced: number;
  attention: number;
  percent: number;
}

/** Share of links that are verifiably in sync. No links => 0 (never a flattering 100). */
export function listingHealth(states: LinkState[]): HealthSummary {
  const synced = states.filter((s) => s === "synced").length;
  return { total: states.length, synced, attention: states.length - synced, percent: states.length ? Math.round((synced / states.length) * 100) : 0 };
}

/** A copy-ready, human-readable record for directories we can't write to. */
export function copyRecord(c: Canonical): string {
  const lines = [
    `Business name: ${c.name}`,
    `Address: ${singleLineAddress(c.address)}${c.address.country ? `, ${c.address.country}` : ""}`,
    `Phone: ${c.phone ?? ""}`,
    `Website: ${c.website ?? ""}`,
  ];
  for (const k of WEEKDAY_KEYS) lines.push(`${k.toUpperCase()}: ${c.hours[k].closed ? "Closed" : `${c.hours[k].open}–${c.hours[k].close}`}`);
  if (c.description) lines.push(`Description: ${c.description}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Validation + permission gate (server + client)
// ---------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
export const isListingPlatform = (v: unknown): v is ListingPlatform => typeof v === "string" && (LISTING_PLATFORMS as string[]).includes(v);

/** Partner location ids end up inside URLs: letters, digits and . _ : - only. */
export function normalizeExternalId(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^[A-Za-z0-9._:-]{1,100}$/.test(s) ? s : null;
}

/** Yelp business alias from a pasted page link or the alias itself. */
export function normalizeYelpAlias(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (!/(^|\.)yelp\.[a-z.]+$/i.test(u.hostname)) return null;
    const m = /^\/biz\/([A-Za-z0-9_-]+)/.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return /^[A-Za-z0-9_-]{2,120}$/.test(s) ? s : null;
  }
}

/** Same rule as the dashboard nav + Reputation: owner, or can_edit_business_profile (custom role overrides). */
export function canManageListings(input: {
  role: string | null | undefined;
  teamPermissions?: Record<string, unknown> | null;
  customRolePermissions?: Record<string, unknown> | null;
}): boolean {
  if (input.role === "owner") return true;
  const perms = { ...(input.teamPermissions ?? {}), ...(input.customRolePermissions ?? {}) };
  return perms.can_edit_business_profile === true;
}
