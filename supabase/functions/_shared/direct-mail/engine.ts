// Pure rules for the direct-mail (postcard) channel. No network, no Deno/Node APIs beyond
// Web Crypto + TextEncoder, so the edge functions, the dashboard (src/lib/directMail.ts)
// and the vitest suite all share ONE implementation and can never disagree.
//
// Attribution contract (do not change one side without the other):
//   QR / short link ...... {SITE_URL}/m/{TRACKING_CODE}
//   landing redirect ..... /lp/{slug}?utm_source=direct_mail&utm_medium=postcard
//                          &utm_campaign=dm-{first 8 hex of campaign id}&utm_content={tracking code, lowercase}
//   reporting joins ...... landing_page_events.utm_content = lower(direct_mail_pieces.tracking_code)

export type PostcardSize = "4x6" | "6x9" | "6x11";
export type MailType = "usps_first_class" | "usps_standard";
export type PieceStatus =
  | "queued" | "submitting" | "submitted" | "in_transit" | "delivered" | "returned" | "failed" | "cancelled";

export const UTM_SOURCE = "direct_mail";
export const UTM_MEDIUM = "postcard";

// ---------------------------------------------------------------- tracking codes
// 32 symbols, no I/L/O/U (read-aloud and print safe). 8 random symbols + 1 check symbol.
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 9;
const CHECK_MODULUS = 31; // prime: detects every single-symbol error and nearly every adjacent swap

function checkSymbol(data: string): string {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += CODE_ALPHABET.indexOf(data[i]) * (i + 1);
  return CODE_ALPHABET[sum % CHECK_MODULUS];
}

export function generateTrackingCode(random?: Uint8Array): string {
  const bytes = random ?? crypto.getRandomValues(new Uint8Array(8));
  if (bytes.length < 8) throw new Error("need 8 random bytes");
  let data = "";
  for (let i = 0; i < 8; i++) data += CODE_ALPHABET[bytes[i] & 31];
  return data + checkSymbol(data);
}

/** Uppercases, strips spaces/dashes and applies Crockford look-alike fixes (O->0, I/L->1). */
export function normalizeTrackingCode(input: string): string {
  return String(input ?? "")
    .toUpperCase()
    .replace(/[\s\-_.]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function isValidTrackingCode(input: string): boolean {
  const code = normalizeTrackingCode(input);
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (CODE_ALPHABET.indexOf(ch) < 0) return false;
  return checkSymbol(code.slice(0, 8)) === code[8];
}

/** Printed form: ABCD-EFGH-J */
export function formatTrackingCode(code: string): string {
  const c = normalizeTrackingCode(code);
  return c.length === CODE_LENGTH ? `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}` : c;
}

export const trackingCodeToUtm = (code: string) => normalizeTrackingCode(code).toLowerCase();

export function campaignUtm(campaignId: string): string {
  return `dm-${campaignId.replace(/-/g, "").slice(0, 8).toLowerCase()}`;
}

export function scanUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/m/${normalizeTrackingCode(code)}`;
}

export function landingRedirectPath(slug: string, campaignId: string, code: string): string {
  const q = new URLSearchParams({
    utm_source: UTM_SOURCE,
    utm_medium: UTM_MEDIUM,
    utm_campaign: campaignUtm(campaignId),
    utm_content: trackingCodeToUtm(code),
  });
  return `/lp/${encodeURIComponent(slug)}?${q.toString()}`;
}

// ---------------------------------------------------------------- addresses
export interface MailAddress {
  name: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  zip: string;
}

export const US_STATES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR GU VI AS MP AA AE AP".split(" "),
);

const squash = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

export function normalizeAddress(a: Partial<MailAddress>): MailAddress {
  const zip = squash(a.zip);
  return {
    name: squash(a.name).slice(0, 120),
    line1: squash(a.line1).slice(0, 200),
    line2: squash(a.line2).slice(0, 200),
    city: squash(a.city).slice(0, 100),
    state: squash(a.state).toUpperCase(),
    zip: /^\d{9}$/.test(zip) ? `${zip.slice(0, 5)}-${zip.slice(5)}` : zip,
  };
}

/** Empty array = deliverable-looking US address. (Real deliverability is checked by the print API.) */
export function validateAddress(raw: Partial<MailAddress>): string[] {
  const a = normalizeAddress(raw);
  const errors: string[] = [];
  if (!a.name) errors.push("name_required");
  if (!a.line1) errors.push("line1_required");
  if (!a.city) errors.push("city_required");
  if (!US_STATES.has(a.state)) errors.push("state_invalid");
  if (!/^\d{5}(-\d{4})?$/.test(a.zip)) errors.push("zip_invalid");
  return errors;
}

/** MUST mirror public.direct_mail_address_key() in the migration. */
export function addressKey(a: Pick<MailAddress, "line1" | "line2" | "zip">): string {
  const street = `${a.line1 ?? ""} ${a.line2 ?? ""}`.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${street}|${String(a.zip ?? "").slice(0, 5)}`;
}

/** "123 Main St, Apt 4, Austin, TX 78701" -> parts. Returns null when it does not clearly parse. */
export function parseSingleLineAddress(text: string): Omit<MailAddress, "name"> | null {
  const m = squash(text).match(/^(.+?),\s*([^,]+?),?\s+([A-Za-z]{2})\.?,?\s+(\d{5}(?:-\d{4})?)(?:,?\s*(?:USA?|United States))?$/i);
  if (!m) return null;
  const parts = m[1].split(",").map((p) => p.trim()).filter(Boolean);
  const line1 = parts[0];
  if (!line1 || !/\d/.test(line1)) return null;
  const state = m[3].toUpperCase();
  if (!US_STATES.has(state)) return null;
  return { line1, line2: parts.slice(1).join(", "), city: m[2].trim(), state, zip: m[4] };
}

// ---------------------------------------------------------------- postcard artwork
interface Geometry { widthIn: number; heightIn: number; addressW: number; addressH: number }
// Sizes include Lob's 0.125" bleed per side. The reserved back area is deliberately LARGER than the
// printer's address/indicia block, so artwork can never collide with it. Verify with the test-mode PDF proof.
export const GEOMETRY: Record<PostcardSize, Geometry> = {
  "4x6": { widthIn: 6.25, heightIn: 4.25, addressW: 3.45, addressH: 2.55 },
  "6x9": { widthIn: 9.25, heightIn: 6.25, addressW: 4.4, addressH: 2.9 },
  "6x11": { widthIn: 11.25, heightIn: 6.25, addressW: 4.4, addressH: 2.9 },
};

export const escapeHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export const isHexColor = (c: string) => /^#[0-9a-fA-F]{6}$/.test(c);

export function readableTextColor(hex: string): string {
  const h = isHexColor(hex) ? hex : "#0F62FE";
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#111111" : "#FFFFFF";
}

export interface ArtworkInput {
  size: PostcardSize;
  brand: string;
  headline: string;
  offer: string;
  cta: string;
  phone: string;
  accent: string;
  code: string;
  scanUrl: string;
  qrSvg: string;
}

const fontCss = "font-family:Helvetica,Arial,sans-serif;";

export function buildFrontHtml(i: ArtworkInput): string {
  const g = GEOMETRY[i.size];
  const accent = isHexColor(i.accent) ? i.accent : "#0F62FE";
  const ink = readableTextColor(accent);
  const big = i.size === "4x6" ? 0.42 : 0.62;
  return `<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;width:${g.widthIn}in;height:${g.heightIn}in;background:${accent};color:${ink};${fontCss}}
.safe{position:absolute;left:0.4in;right:0.4in;top:0.4in;bottom:0.4in}
.brand{font-size:${i.size === "4x6" ? 0.17 : 0.24}in;letter-spacing:.08em;text-transform:uppercase;font-weight:700;opacity:.9}
h1{margin:.18in 0 .12in;font-size:${big}in;line-height:1.05;font-weight:800;max-width:${g.widthIn - 1.4}in}
.offer{font-size:${i.size === "4x6" ? 0.22 : 0.3}in;line-height:1.25;font-weight:600;max-width:${g.widthIn - 1.8}in}
.phone{position:absolute;left:0;bottom:0;font-size:${i.size === "4x6" ? 0.26 : 0.36}in;font-weight:800}
</style></head><body><div class="safe">
<div class="brand">${escapeHtml(i.brand)}</div>
<h1>${escapeHtml(i.headline)}</h1>
<div class="offer">${escapeHtml(i.offer)}</div>
${i.phone ? `<div class="phone">${escapeHtml(i.phone)}</div>` : ""}
</div></body></html>`;
}

export function buildBackHtml(i: ArtworkInput): string {
  const g = GEOMETRY[i.size];
  const accent = isHexColor(i.accent) ? i.accent : "#0F62FE";
  const qrIn = i.size === "4x6" ? 1.15 : 1.5;
  const leftW = g.widthIn - g.addressW - 0.9;
  return `<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;width:${g.widthIn}in;height:${g.heightIn}in;background:#fff;color:#111;${fontCss}}
.left{position:absolute;left:0.4in;top:0.4in;width:${leftW}in}
.brand{font-size:${i.size === "4x6" ? 0.15 : 0.2}in;font-weight:800;color:${accent};text-transform:uppercase;letter-spacing:.06em}
.cta{margin:.1in 0 .14in;font-size:${i.size === "4x6" ? 0.2 : 0.28}in;line-height:1.2;font-weight:700}
.qr{width:${qrIn}in;height:${qrIn}in;padding:.08in;background:#fff;border:1px solid #ddd}
.qr svg{width:100%;height:100%;display:block}
.code{margin-top:.08in;font-size:${i.size === "4x6" ? 0.13 : 0.17}in;color:#333}
.code b{font-size:${i.size === "4x6" ? 0.17 : 0.22}in;letter-spacing:.05em;color:#111}
.ph{margin-top:.06in;font-size:${i.size === "4x6" ? 0.14 : 0.19}in;font-weight:700}
</style></head><body><div class="left">
<div class="brand">${escapeHtml(i.brand)}</div>
<div class="cta">${escapeHtml(i.cta)}</div>
<div class="qr">${i.qrSvg}</div>
<div class="code">Offer code <b>${escapeHtml(formatTrackingCode(i.code))}</b></div>
${i.phone ? `<div class="ph">Call ${escapeHtml(i.phone)} and mention your code</div>` : ""}
</div></body></html>`;
}

// ---------------------------------------------------------------- print API (Lob)
export interface LobPayloadInput {
  size: PostcardSize;
  mailType: MailType;
  front: string;
  back: string;
  to: MailAddress;
  from: MailAddress;
  description: string;
  metadata: Record<string, string>;
}

const lobAddress = (a: MailAddress) => ({
  name: a.name,
  address_line1: a.line1,
  ...(a.line2 ? { address_line2: a.line2 } : {}),
  address_city: a.city,
  address_state: a.state,
  address_zip: a.zip,
  address_country: "US",
});

export function buildLobPostcardPayload(i: LobPayloadInput) {
  return {
    description: i.description.slice(0, 255),
    to: lobAddress(i.to),
    from: lobAddress(i.from),
    front: i.front,
    back: i.back,
    size: i.size,
    mail_type: i.mailType,
    use_type: "marketing",
    metadata: i.metadata,
  };
}

/** Lob returns price as a decimal-dollar string (e.g. "0.85"). Returns integer cents or null. */
export function parseProviderPriceCents(price: unknown): number | null {
  if (price === null || price === undefined || price === "") return null;
  const cleaned = typeof price === "number" ? String(price) : String(price).replace(/[^0-9.]/g, "");
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

// Lob event id -> our piece status (null = informational, no status change)
const EVENT_STATUS: Record<string, PieceStatus | null> = {
  "postcard.created": "submitted",
  "postcard.mailed": "in_transit",
  "postcard.in_transit": "in_transit",
  "postcard.in_local_area": "in_transit",
  "postcard.processed_for_delivery": "in_transit",
  "postcard.re-routed": "in_transit",
  "postcard.delivered": "delivered",
  "postcard.returned_to_sender": "returned",
  "postcard.failed": "failed",
  "postcard.deleted": "cancelled",
  "postcard.rendered_pdf": null,
  "postcard.rendered_thumbnails": null,
  "postcard.international_exit": null,
};

export function mapProviderEvent(eventType: string): PieceStatus | null {
  return EVENT_STATUS[eventType] ?? null;
}

const RANK: Record<PieceStatus, number> = {
  queued: 0, submitting: 1, submitted: 2, in_transit: 3, delivered: 4, returned: 5, failed: 2, cancelled: 99,
};

/** Webhooks arrive out of order and are retried; a status may only move forward. MUST mirror the SQL RPC. */
export function shouldAdvance(current: PieceStatus, next: PieceStatus): boolean {
  if (current === "cancelled") return false;
  if (next === "failed") return RANK[current] < RANK.delivered && current !== "failed";
  if (next === "cancelled") return RANK[current] < RANK.delivered;
  if (current === "failed") return false;
  return RANK[next] > RANK[current];
}

// ---------------------------------------------------------------- webhook signature
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/** Lob signs `${timestamp}.${rawBody}` with HMAC-SHA256 (hex). Fails closed on any missing piece. */
export async function verifyLobSignature(p: {
  secret: string | null | undefined;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowMs: number;
}): Promise<boolean> {
  if (!p.secret || !p.timestamp || !p.signature) return false;
  const ts = Number(p.timestamp);
  if (!Number.isFinite(ts)) return false;
  const tsMs = ts < 1e12 ? ts * 1000 : ts; // seconds or milliseconds
  if (Math.abs(p.nowMs - tsMs) > WEBHOOK_TOLERANCE_MS) return false;
  const expected = await hmacSha256Hex(p.secret, `${p.timestamp}.${p.rawBody}`);
  return timingSafeEqual(expected, p.signature.trim().toLowerCase());
}
