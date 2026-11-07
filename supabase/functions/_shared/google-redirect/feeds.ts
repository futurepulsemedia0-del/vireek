// supabase/functions/_shared/google-redirect/feeds.ts
//
// Google Actions Center — "Appointments Redirect" feeds (Entity + Action), JSON form.
// Spec (fetched 2026-11-03/04; Entity feed last updated 2026-10-01, Action feed 2026-10-21):
//   developers.google.com/actions-center/verticals/appointments/redirect/reference/feeds/{entity-feed,action-feed}
//   - Entity: entity_id (opaque, unique, immutable, URL-safe), name (required), telephone (E.164, recommended),
//     url (optional), location (required: lat/lng and/or address{country,locality,postal_code,street_address required}).
//   - Action: {data:[{entity_id, link_id, url, actions:[{appointment_info:{}}]}]}; descriptor name
//     `reservewithgoogle.action.v2`; entity descriptor name `reservewithgoogle.entity`.
//   - Files: unique timestamped names, full refresh DAILY, uploaded to Google's generic SFTP server (Partner Portal).
// This module is pure: it validates and builds the files. It does NOT upload (SFTP credentials come from the
// Partner Portal after Google approves you as a partner).

export interface RedirectMerchant {
  /** Stable, immutable id. Vireek uses the account owner's user id. */
  entityId: string;
  name: string;
  /** Any common phone format; normalised to E.164 when possible, otherwise omitted (field is optional). */
  phone?: string | null;
  /** HTTPS booking page for this merchant (the redirect target). */
  bookingUrl: string;
  address: {
    country: string; // ISO 3166-1 alpha-2
    locality: string;
    region?: string | null;
    postalCode: string;
    streetAddress: string;
  };
}

export interface EntityRecord {
  entity_id: string;
  name: string;
  telephone?: string;
  location: { address: { country: string; locality: string; region?: string; postal_code: string; street_address: string } };
}
export interface ActionRecord {
  entity_id: string;
  link_id: string;
  url: string;
  actions: Array<{ appointment_info: Record<string, never> }>;
}

export interface FeedFile {
  name: string;
  content: string;
}
export interface RejectedMerchant {
  entityId: string;
  reason: string;
}

const ENTITY_ID_RE = /^[A-Za-z0-9._~-]{1,200}$/;

/** Best-effort E.164: keeps a leading +, otherwise assumes `defaultCountryCode` (e.g. "1" for US/CA). */
export function toE164(raw: string | null | undefined, defaultCountryCode = "1"): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  let e164: string;
  if (trimmed.startsWith("+")) e164 = `+${digits}`;
  else if (defaultCountryCode === "1" && digits.length === 10) e164 = `+1${digits}`;
  else if (defaultCountryCode === "1" && digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
  else return null;
  return /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
}

export function isHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !!u.hostname;
  } catch {
    return false;
  }
}

/** Returns a reason string when the merchant cannot be put in the feed, otherwise null. */
export function validateMerchant(m: RedirectMerchant): string | null {
  if (!ENTITY_ID_RE.test(m.entityId)) return "entity_id_invalid";
  if (!m.name || !m.name.trim()) return "name_missing";
  if (!isHttpsUrl(m.bookingUrl)) return "booking_url_not_https";
  const a = m.address;
  if (!/^[A-Z]{2}$/.test(a.country)) return "address_country_invalid";
  if (!a.locality?.trim()) return "address_locality_missing";
  if (!a.postalCode?.trim()) return "address_postal_code_missing";
  if (!a.streetAddress?.trim()) return "address_street_missing";
  return null;
}

export function toEntity(m: RedirectMerchant, defaultCountryCode = "1"): EntityRecord {
  const tel = toE164(m.phone, defaultCountryCode);
  return {
    entity_id: m.entityId,
    name: m.name.trim(),
    ...(tel ? { telephone: tel } : {}),
    location: {
      address: {
        country: m.address.country,
        locality: m.address.locality.trim(),
        ...(m.address.region?.trim() ? { region: m.address.region.trim() } : {}),
        postal_code: m.address.postalCode.trim(),
        street_address: m.address.streetAddress.trim(),
      },
    },
  };
}

export function toAction(m: RedirectMerchant): ActionRecord {
  return { entity_id: m.entityId, link_id: `${m.entityId}-book`, url: m.bookingUrl, actions: [{ appointment_info: {} }] };
}

export function partitionMerchants(all: RedirectMerchant[]): { valid: RedirectMerchant[]; rejected: RejectedMerchant[] } {
  const valid: RedirectMerchant[] = [];
  const rejected: RejectedMerchant[] = [];
  const seen = new Set<string>();
  for (const m of all) {
    const reason = validateMerchant(m) ?? (seen.has(m.entityId) ? "entity_id_duplicate" : null);
    if (reason) rejected.push({ entityId: m.entityId, reason });
    else {
      seen.add(m.entityId);
      valid.push(m);
    }
  }
  return { valid, rejected };
}

export const ENTITY_FILESET_NAME = "reservewithgoogle.entity";
export const ACTION_FILESET_NAME = "reservewithgoogle.action.v2";

/**
 * Builds the data files (sharded) and the fileset descriptor for one feed kind.
 * File names are unique per generation (timestamp), as Google recommends: entity_<ts>_0001.json,
 * entity_<ts>.filesetdesc.json, action_<ts>_0001.json, ...
 */
export function buildFeedFiles(
  kind: "entity" | "action",
  merchants: RedirectMerchant[],
  generationTimestampSec: number,
  opts: { shardSize?: number; defaultCountryCode?: string } = {},
): FeedFile[] {
  const shardSize = opts.shardSize ?? 5000;
  const records: Array<EntityRecord | ActionRecord> =
    kind === "entity" ? merchants.map((m) => toEntity(m, opts.defaultCountryCode)) : merchants.map(toAction);
  const dataFiles: FeedFile[] = [];
  for (let i = 0, n = 1; i < records.length || (i === 0 && n === 1); i += shardSize, n++) {
    dataFiles.push({
      name: `${kind}_${generationTimestampSec}_${String(n).padStart(4, "0")}.json`,
      content: JSON.stringify({ data: records.slice(i, i + shardSize) }),
    });
    if (records.length === 0) break;
  }
  const descriptor: FeedFile = {
    name: `${kind}_${generationTimestampSec}.filesetdesc.json`,
    content: JSON.stringify({
      generation_timestamp: generationTimestampSec,
      name: kind === "entity" ? ENTITY_FILESET_NAME : ACTION_FILESET_NAME,
      data_file: dataFiles.map((f) => f.name),
    }),
  };
  return [...dataFiles, descriptor];
}
