// supabase/functions/_shared/wallet/passModel.ts
//
// Pure (no I/O, no Deno/Node APIs) pass model shared by the Apple and Google serializers, the edge functions
// and the vitest suite. One payload (from SQL wallet_pass_payload) -> one PassModel -> .pkpass JSON / Google object.

export type WalletKind = "appointment" | "membership" | "protection" | "gift_card" | "tech_badge";
export const WALLET_KINDS: readonly WalletKind[] = ["appointment", "membership", "protection", "gift_card", "tech_badge"];
export const isWalletKind = (v: unknown): v is WalletKind => typeof v === "string" && (WALLET_KINDS as readonly string[]).includes(v);

export interface PassPayload {
  pass: {
    id: string; user_id: string; kind: WalletKind; serial: string; auth_token: string; share_token: string;
    timezone: string; status: "active" | "voided"; version: number; last_changed_at: string; customer_id: string | null;
  };
  org: { name: string; phone?: string | null; color?: string | null; accent?: string | null };
  data: Record<string, unknown> | null;
  missing: boolean;
}

export interface PassField {
  key: string;
  label: string;
  value: string | number;
  /** Apple only: render `value` (ISO 8601) as a localized date/time on the device. */
  date?: { dateStyle: "none" | "short" | "medium"; timeStyle: "none" | "short" };
  /** Apple only: ISO currency code -> `value` is a number rendered as money. */
  currencyCode?: string;
  /** Apple only: lock-screen text when this field changes. Must contain %@. */
  changeMessage?: string;
}

export type GoogleState = "ACTIVE" | "COMPLETED" | "EXPIRED" | "INACTIVE";

export interface PassModel {
  kind: WalletKind;
  serial: string;
  org: string;
  description: string;
  style: "generic" | "storeCard";
  colors: { bg: string; fg: string; label: string };
  headline: string;
  subline: string;
  header: PassField[];
  primary: PassField[];
  secondary: PassField[];
  auxiliary: PassField[];
  back: PassField[];
  barcode: { message: string; altText: string };
  relevantDate?: string;
  expirationDate?: string;
  voided: boolean;
  googleState: GoogleState;
}

// ---------- small helpers ----------

const DEFAULT_COLOR = "#2563EB";
const HEX = /^#[0-9a-fA-F]{6}$/;

export function normalizeColor(input: unknown, fallback = DEFAULT_COLOR): string {
  return typeof input === "string" && HEX.test(input.trim()) ? input.trim().toUpperCase() : fallback;
}

export function resolveColors(hex?: unknown): PassModel["colors"] {
  const bg = normalizeColor(hex);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const light = lum > 0.45;
  return { bg, fg: light ? "#0B1220" : "#FFFFFF", label: light ? "#334155" : "#E2E8F0" };
}

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const clip = (v: unknown, max = 160): string => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v == null ? "" : String(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const iso = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().replace(".000Z", "Z");
};

export function fmtDate(isoValue: string, tz: string, opts: Intl.DateTimeFormatOptions): string {
  const timeZone = isValidTimezone(tz) ? tz : "UTC";
  return new Intl.DateTimeFormat("en-US", { timeZone, ...opts }).format(new Date(isoValue));
}
const fmtTime = (v: string, tz: string) => fmtDate(v, tz, { hour: "numeric", minute: "2-digit" });
const fmtDay = (v: string, tz: string) => fmtDate(v, tz, { weekday: "short", month: "short", day: "numeric" });
const fmtDayLong = (v: string, tz: string) => fmtDate(v, tz, { month: "short", day: "numeric", year: "numeric" });

export function formatMoney(cents: number, currency = "usd"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

export const formatGiftCode = (code: string): string => (code.length === 12 ? code.replace(/(.{4})(?=.)/g, "$1-") : code);

// ---------- appointment ETA ----------

export interface EtaInfo {
  mode: "eta" | "window" | "scheduled";
  at: string | null; // ISO, for ETA / scheduled
  windowStart: string | null;
  windowEnd: string | null;
}

/** ETA = eta_set_at + eta_minutes. Ignored if stale (more than 45 min past), so an old ETA never lies. */
export function resolveEta(d: Record<string, unknown>, now: Date): EtaInfo {
  const minutes = num(d.eta_minutes);
  const setAt = iso(d.eta_set_at);
  if (minutes !== null && setAt) {
    const arrival = Date.parse(setAt) + minutes * 60_000;
    if (arrival > now.getTime() - 45 * 60_000) return { mode: "eta", at: new Date(arrival).toISOString().replace(".000Z", "Z"), windowStart: null, windowEnd: null };
  }
  const ws = iso(d.window_start);
  const we = iso(d.window_end);
  if (ws && we && Date.parse(we) > Date.parse(ws)) return { mode: "window", at: null, windowStart: ws, windowEnd: we };
  return { mode: "scheduled", at: iso(d.scheduled_at), windowStart: null, windowEnd: null };
}

const DONE = new Set(["completed"]);
const CANCELLED = new Set(["cancelled", "canceled"]);

// ---------- builders ----------

function appointment(p: PassPayload, d: Record<string, unknown>, now: Date): Partial<PassModel> {
  const tz = p.pass.timezone;
  const status = (str(d.job_status) ?? "scheduled").toLowerCase();
  const eta = resolveEta(d, now);
  const tech = str(d.technician_name);
  const service = str(d.service_type) ?? "Service visit";
  const done = DONE.has(status);
  const cancelled = CANCELLED.has(status);

  let headline: string;
  let label: string;
  let primary: PassField;
  if (done) {
    headline = "Visit completed";
    label = "STATUS";
    primary = { key: "eta", label, value: "Completed" };
  } else if (cancelled) {
    headline = "Appointment cancelled";
    label = "STATUS";
    primary = { key: "eta", label, value: "Cancelled" };
  } else if (eta.mode === "eta" && eta.at) {
    headline = `Arriving about ${fmtTime(eta.at, tz)}`;
    label = "TECHNICIAN ETA";
    primary = { key: "eta", label, value: eta.at, date: { dateStyle: "none", timeStyle: "short" }, changeMessage: "Technician ETA updated: %@" };
  } else if (eta.mode === "window" && eta.windowStart && eta.windowEnd) {
    headline = `${fmtDay(eta.windowStart, tz)}, ${fmtTime(eta.windowStart, tz)} – ${fmtTime(eta.windowEnd, tz)}`;
    label = "ARRIVAL WINDOW";
    primary = { key: "eta", label, value: `${fmtTime(eta.windowStart, tz)} – ${fmtTime(eta.windowEnd, tz)}`, changeMessage: "Arrival window updated: %@" };
  } else if (eta.at) {
    headline = `${fmtDay(eta.at, tz)}, ${fmtTime(eta.at, tz)}`;
    label = "SCHEDULED";
    primary = { key: "eta", label, value: eta.at, date: { dateStyle: "medium", timeStyle: "short" }, changeMessage: "Appointment time updated: %@" };
  } else {
    headline = "Appointment";
    label = "SCHEDULED";
    primary = { key: "eta", label, value: "To be confirmed" };
  }

  const secondary: PassField[] = [
    { key: "tech", label: "TECHNICIAN", value: tech ?? "Being assigned", changeMessage: "Your technician: %@" },
    { key: "service", label: "SERVICE", value: clip(service, 60) },
  ];
  const back: PassField[] = [];
  if (str(d.address)) back.push({ key: "address", label: "Service address", value: clip(d.address, 200) });
  back.push({ key: "support", label: "Questions?", value: p.org.phone ? `Call ${p.org.phone}` : "Contact us through your customer portal." });

  const expiry = done || cancelled ? now.toISOString().replace(/\.\d{3}Z$/, "Z") : eta.at ?? eta.windowEnd ?? undefined;
  return {
    description: `${p.org.name} appointment`,
    headline,
    subline: `${service}${tech ? ` · ${tech}` : ""}`,
    primary: [primary],
    secondary,
    auxiliary: [{ key: "status", label: "STATUS", value: done ? "Completed" : cancelled ? "Cancelled" : status === "scheduled" ? "Confirmed" : clip(status.replace(/_/g, " "), 24) }],
    back,
    relevantDate: eta.at ?? eta.windowStart ?? undefined,
    expirationDate: expiry ? new Date(Date.parse(expiry) + (done || cancelled ? 0 : 6 * 3600_000)).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined,
    voided: cancelled,
    googleState: done ? "COMPLETED" : cancelled ? "INACTIVE" : "ACTIVE",
  };
}

function membership(p: PassPayload, d: Record<string, unknown>): Partial<PassModel> {
  const active = (str(d.status) ?? "active") === "active";
  const plan = str(d.plan_name) ?? "Membership";
  const since = iso(d.started_at);
  const benefits = Array.isArray(d.benefits) ? (d.benefits as unknown[]).map((b) => clip(b, 120)).filter(Boolean) : [];
  return {
    style: "storeCard",
    description: `${p.org.name} ${plan}`,
    headline: plan,
    subline: clip(d.customer_name, 60),
    primary: [{ key: "plan", label: "PLAN", value: clip(plan, 40) }],
    secondary: [
      { key: "member", label: "MEMBER", value: clip(d.customer_name, 40) },
      { key: "status", label: "STATUS", value: active ? "Active" : "Inactive", changeMessage: "Membership status: %@" },
    ],
    auxiliary: since ? [{ key: "since", label: "MEMBER SINCE", value: since, date: { dateStyle: "medium", timeStyle: "none" } }] : [],
    back: [
      ...(benefits.length ? [{ key: "benefits", label: "Your benefits", value: benefits.map((b) => `• ${b}`).join("\n") }] : []),
      ...(str(d.billing_interval) ? [{ key: "billing", label: "Billing", value: str(d.billing_interval) === "monthly" ? "Monthly" : "Yearly" }] : []),
      { key: "ref", label: "Member ID", value: clip(d.member_ref, 16) },
    ],
    voided: !active,
    googleState: active ? "ACTIVE" : "INACTIVE",
  };
}

function protection(p: PassPayload, d: Record<string, unknown>, now: Date): Partial<PassModel> {
  const until = iso(d.warranty_expires_at);
  const untilEnd = until ? new Date(Date.parse(until) + 86_399_000).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
  const expired = untilEnd ? Date.parse(untilEnd) < now.getTime() : false;
  const gone = ["replaced", "removed"].includes((str(d.equipment_status) ?? "active").toLowerCase());
  const name = [str(d.make), str(d.model)].filter(Boolean).join(" ") || str(d.equipment_type) || "Equipment";
  const install = iso(d.install_date);
  return {
    description: `${p.org.name} service protection`,
    headline: gone ? "Equipment no longer covered" : until ? (expired ? "Warranty expired" : `Covered through ${fmtDayLong(until, "UTC")}`) : "Equipment record",
    subline: clip(name, 60),
    primary: [until
      ? { key: "until", label: expired ? "WARRANTY ENDED" : "COVERED THROUGH", value: until, date: { dateStyle: "medium", timeStyle: "none" }, changeMessage: "Warranty coverage updated: %@" }
      : { key: "until", label: "COVERAGE", value: "See your technician" }],
    secondary: [
      { key: "equip", label: "EQUIPMENT", value: clip(name, 40) },
      ...(str(d.serial_tail) ? [{ key: "serial", label: "SERIAL ENDS", value: clip(d.serial_tail, 8) }] : []),
    ],
    auxiliary: install ? [{ key: "install", label: "INSTALLED", value: install, date: { dateStyle: "medium" as const, timeStyle: "none" as const } }] : [],
    back: [
      { key: "owner", label: "Covered customer", value: clip(d.customer_name, 80) },
      ...(str(d.warranty_notes) ? [{ key: "notes", label: "Coverage notes", value: clip(d.warranty_notes, 500) }] : []),
      { key: "support", label: "Need service?", value: p.org.phone ? `Call ${p.org.phone}` : "Contact us through your customer portal." },
    ],
    expirationDate: untilEnd ?? undefined,
    voided: gone,
    googleState: gone ? "INACTIVE" : expired ? "EXPIRED" : "ACTIVE",
  };
}

function giftCard(p: PassPayload, d: Record<string, unknown>, now: Date): Partial<PassModel> {
  const cents = num(d.balance_cents) ?? 0;
  const currency = (str(d.currency) ?? "usd").toUpperCase();
  const status = str(d.status) ?? "active";
  const exp = iso(d.expires_at);
  const expired = exp ? Date.parse(exp) < now.getTime() : false;
  const voided = status === "voided";
  const code = str(d.code) ?? "";
  const credit = str(d.card_kind) === "store_credit";
  return {
    style: "storeCard",
    description: `${p.org.name} ${credit ? "store credit" : "gift card"}`,
    headline: `${formatMoney(cents, currency)} balance`,
    subline: credit ? "Store credit" : "Gift card",
    primary: [{ key: "balance", label: "BALANCE", value: cents / 100, currencyCode: currency, changeMessage: "Balance updated: %@" }],
    secondary: [
      ...(exp ? [{ key: "expires", label: "EXPIRES", value: exp, date: { dateStyle: "medium" as const, timeStyle: "none" as const } }] : []),
      ...(str(d.recipient_name) ? [{ key: "for", label: "FOR", value: clip(d.recipient_name, 40) }] : []),
    ],
    auxiliary: [{ key: "code", label: "CARD CODE", value: formatGiftCode(code) }],
    back: [
      { key: "how", label: "How to redeem", value: "Show this card or read the code to your technician or office when paying." },
      ...(p.org.phone ? [{ key: "support", label: "Questions?", value: `Call ${p.org.phone}` }] : []),
    ],
    expirationDate: exp ?? undefined,
    voided,
    barcode: { message: code, altText: formatGiftCode(code) },
    googleState: voided ? "INACTIVE" : expired || status === "depleted" ? "EXPIRED" : "ACTIVE",
  };
}

function techBadge(p: PassPayload, d: Record<string, unknown>): Partial<PassModel> {
  const name = str(d.name) ?? "Technician";
  const role = str(d.role) ?? "team";
  const roleLabel = role === "owner" ? "Owner" : role === "admin" ? "Manager" : "Field technician";
  return {
    description: `${p.org.name} technician ID`,
    headline: name,
    subline: `${roleLabel} · ${p.org.name}`,
    primary: [{ key: "name", label: "TECHNICIAN", value: clip(name, 40) }],
    secondary: [
      { key: "role", label: "ROLE", value: roleLabel },
      { key: "company", label: "COMPANY", value: clip(p.org.name, 40) },
    ],
    auxiliary: [{ key: "badge", label: "BADGE ID", value: clip(d.badge_ref, 12) }],
    back: [
      { key: "verify", label: "Verify this technician", value: p.org.phone ? `Call ${p.org.phone} to confirm identity before letting anyone in.` : "Contact the company to confirm identity before letting anyone in." },
    ],
    voided: false,
    googleState: "ACTIVE",
  };
}

export function buildPassModel(payload: PassPayload, now: Date = new Date()): PassModel {
  const { pass, org } = payload;
  const d = payload.data ?? {};
  const part: Partial<PassModel> =
    payload.missing ? { headline: "No longer available", subline: "", voided: true, googleState: "INACTIVE", description: `${org.name} pass` }
    : pass.kind === "appointment" ? appointment(payload, d, now)
    : pass.kind === "membership" ? membership(payload, d)
    : pass.kind === "protection" ? protection(payload, d, now)
    : pass.kind === "gift_card" ? giftCard(payload, d, now)
    : techBadge(payload, d);

  const voided = pass.status === "voided" || payload.missing || part.voided === true;
  const short = { appointment: "appt", membership: "member", protection: "cover", gift_card: "gift", tech_badge: "badge" }[pass.kind];
  return {
    kind: pass.kind,
    serial: pass.serial,
    org: clip(org.name, 40),
    description: part.description ?? `${org.name} pass`,
    style: part.style ?? "generic",
    colors: resolveColors(org.color),
    headline: part.headline ?? "",
    subline: part.subline ?? "",
    header: part.header ?? [],
    primary: part.primary ?? [],
    secondary: part.secondary ?? [],
    auxiliary: part.auxiliary ?? [],
    back: part.back ?? [],
    barcode: part.barcode ?? { message: `vireek:${short}:${pass.serial}`, altText: pass.serial.slice(0, 8).toUpperCase() },
    relevantDate: part.relevantDate,
    expirationDate: part.expirationDate,
    voided,
    googleState: voided && part.googleState === "ACTIVE" ? "INACTIVE" : part.googleState ?? "ACTIVE",
  };
}

// ---------- Apple serializer ----------

export interface AppleConfig { passTypeIdentifier: string; teamIdentifier: string; webServiceURL: string }

const DATE_STYLE = { none: "PKDateStyleNone", short: "PKDateStyleShort", medium: "PKDateStyleMedium" } as const;

function appleField(f: PassField): Record<string, unknown> {
  const out: Record<string, unknown> = { key: f.key, label: f.label, value: f.value };
  if (f.date) {
    out.dateStyle = DATE_STYLE[f.date.dateStyle];
    out.timeStyle = DATE_STYLE[f.date.timeStyle];
    out.ignoresTimeZone = false;
  }
  if (f.currencyCode) out.currencyCode = f.currencyCode;
  if (f.changeMessage) out.changeMessage = f.changeMessage;
  return out;
}

export function toApplePassJson(m: PassModel, authToken: string, cfg: AppleConfig): Record<string, unknown> {
  const body = {
    headerFields: m.header.map(appleField),
    primaryFields: m.primary.map(appleField),
    secondaryFields: m.secondary.map(appleField),
    auxiliaryFields: m.auxiliary.map(appleField),
    backFields: m.back.map(appleField),
  };
  const json: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: cfg.passTypeIdentifier,
    teamIdentifier: cfg.teamIdentifier,
    serialNumber: m.serial,
    organizationName: m.org,
    description: m.description,
    logoText: m.org,
    foregroundColor: rgb(m.colors.fg),
    backgroundColor: rgb(m.colors.bg),
    labelColor: rgb(m.colors.label),
    webServiceURL: cfg.webServiceURL,
    authenticationToken: authToken,
    barcodes: [{ format: "PKBarcodeFormatQR", message: m.barcode.message, messageEncoding: "iso-8859-1", altText: m.barcode.altText }],
    voided: m.voided,
    [m.style]: body,
  };
  if (m.relevantDate) json.relevantDate = m.relevantDate;
  if (m.expirationDate) json.expirationDate = m.expirationDate;
  return json;
}

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

// ---------- Google serializer ----------

export interface GoogleIds { classId: string; objectId: string }
export const googleClassId = (issuerId: string, kind: WalletKind) => `${issuerId}.vireek_${kind}_v1`;
export const googleObjectId = (issuerId: string, serial: string) => `${issuerId}.${serial}`;

const loc = (value: string) => ({ defaultValue: { language: "en-US", value } });
const textOf = (f: PassField, tz: string): string => {
  if (f.currencyCode) return formatMoney(Math.round(Number(f.value) * 100), f.currencyCode);
  if (f.date && typeof f.value === "string") {
    return f.date.timeStyle === "none" ? fmtDayLong(f.value, "UTC") : f.date.dateStyle === "none" ? fmtTime(f.value, tz) : `${fmtDay(f.value, tz)}, ${fmtTime(f.value, tz)}`;
  }
  return String(f.value);
};

export function toGoogleObject(m: PassModel, ids: GoogleIds, tz: string): Record<string, unknown> {
  const modules = [...m.primary, ...m.secondary, ...m.auxiliary, ...m.back]
    .slice(0, 10)
    .map((f) => ({ id: f.key, header: f.label.replace(/\b([A-Z])([A-Z]+)\b/g, (_, a: string, b: string) => a + b.toLowerCase()), body: clip(textOf(f, tz), 400) }));
  const obj: Record<string, unknown> = {
    id: ids.objectId,
    classId: ids.classId,
    state: m.googleState,
    hexBackgroundColor: m.colors.bg,
    cardTitle: loc(m.org),
    header: loc(m.headline || m.org),
    textModulesData: modules,
    barcode: { type: "QR_CODE", value: m.barcode.message, alternateText: m.barcode.altText },
  };
  if (m.subline) obj.subheader = loc(m.subline);
  if (m.expirationDate) obj.validTimeInterval = { end: { date: m.expirationDate } };
  return obj;
}
