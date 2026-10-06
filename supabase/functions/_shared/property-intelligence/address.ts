// Address + phone helpers for the Property Intelligence Graph. Pure, no I/O.

import type { SiteAddressInput } from "./types.ts";

const SUFFIX: Record<string, string> = {
  street: "st", avenue: "ave", road: "rd", drive: "dr", lane: "ln", boulevard: "blvd", court: "ct",
  circle: "cir", place: "pl", highway: "hwy", parkway: "pkwy", terrace: "ter", trail: "trl",
  square: "sq", alley: "aly", expressway: "expy", freeway: "fwy", way: "way",
};

const DIRECTION: Record<string, string> = {
  north: "n", south: "s", east: "e", west: "w",
  northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
};

/** Lowercase, strip unit designators/punctuation, abbreviate suffixes + directions. */
export function normalizeStreet(raw: string): string {
  let s = (raw ?? "").toLowerCase();
  s = s.replace(/\b(apt|apartment|unit|ste|suite)\b\.?\s*#?\s*[\w-]+/g, " ");
  s = s.replace(/#\s*[\w-]+/g, " ");
  s = s.replace(/[^a-z0-9\s]/g, " ");
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => SUFFIX[token] ?? DIRECTION[token] ?? token)
    .join(" ");
}

/** Stable matching key: normalized street + 5-digit ZIP. Unit numbers are deliberately ignored. */
export function buildAddressKey(street: string, zip: string | null | undefined): string {
  const zip5 = (zip ?? "").replace(/\D/g, "").slice(0, 5);
  return `${normalizeStreet(street)}|${zip5}`;
}

export function hasUsableAddress(site: SiteAddressInput): boolean {
  const street = (site.address ?? "").trim();
  if (street.length < 3) return false;
  const zip = (site.postal_code ?? "").replace(/\D/g, "");
  const hasCityState = !!(site.city ?? "").trim() && !!(site.state ?? "").trim();
  return zip.length >= 5 || hasCityState;
}

export function formatAddressLine(site: SiteAddressInput): string {
  const street = (site.address ?? "").trim();
  const city = (site.city ?? "").trim();
  const state = (site.state ?? "").trim();
  const zip = (site.postal_code ?? "").trim();
  const tail = [state, zip].filter(Boolean).join(" ");
  return [street, city, tail].filter(Boolean).join(", ");
}

/** "123 MAIN ST, AUSTIN, TX, 78701" -> parts (Census geocoder format). */
export function parseMatchedAddress(matched: string): {
  street1: string;
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  const parts = matched.split(",").map((p) => p.trim()).filter(Boolean);
  return {
    street1: parts[0] ?? matched.trim(),
    city: parts[1] ?? null,
    state: parts[2] ?? null,
    zip: parts[3] ?? null,
  };
}

export function last10Digits(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/** Formats a stored customers.phone may be in, for an exact-match lookup. */
export function phoneCandidates(phone: string | null | undefined): string[] {
  const raw = (phone ?? "").trim();
  if (!raw) return [];
  const d10 = last10Digits(raw);
  const out = new Set<string>([raw]);
  if (d10.length === 10) {
    out.add(d10);
    out.add(`+1${d10}`);
    out.add(`1${d10}`);
  }
  return [...out];
}
