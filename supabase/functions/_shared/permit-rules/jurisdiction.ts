// supabase/functions/_shared/permit-rules/jurisdiction.ts
//
// Deterministic jurisdiction resolution from a free-text job address.
// We never guess: a state is only returned when the address contains a
// recognisable "ST 12345" / ", ST," pattern (or a full state name after a
// comma). Everything else falls back to country-only or unknown.

import type { JurisdictionInfo } from "./types.ts";

export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

const STATE_BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]),
);

const COUNTRY_ALIASES: Record<string, string> = {
  US: "US", USA: "US", "UNITED STATES": "US", "UNITED STATES OF AMERICA": "US",
  GB: "GB", UK: "GB", "UNITED KINGDOM": "GB", ENGLAND: "GB", SCOTLAND: "GB", WALES: "GB",
  CA: "CA", CANADA: "CA",
};

export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toUpperCase();
  if (!key) return null;
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];
  return /^[A-Z]{2}$/.test(key) ? key : null;
}

function clean(s: string | undefined | null): string | null {
  const v = (s ?? "").replace(/\s+/g, " ").trim();
  return v ? v.slice(0, 80) : null;
}

/** Splits "123 Main St, Austin, TX 78701" into comma segments. */
function segments(address: string): string[] {
  return address.split(",").map((s) => s.trim()).filter(Boolean);
}

export function parseJurisdiction(address: string | null | undefined, countryHint?: string | null): JurisdictionInfo {
  const hint = normalizeCountry(countryHint);
  const addr = (address ?? "").trim();
  let state: string | null = null;
  let zip: string | null = null;
  let city: string | null = null;

  if (addr) {
    const segs = segments(addr);

    // 1) "... ST 12345" or "... ST 12345-6789" - strongest signal (case-sensitive on purpose).
    const zipMatch = addr.match(/\b([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/);
    if (zipMatch && US_STATES[zipMatch[1]]) {
      state = zipMatch[1];
      zip = zipMatch[2];
    }

    // 2) A whole comma segment that is exactly a state code, e.g. ", TX," or ", TX".
    if (!state) {
      const idx = segs.findIndex((s, i) => i > 0 && /^[A-Z]{2}$/.test(s) && !!US_STATES[s]);
      if (idx > 0) state = segs[idx];
    }

    // 3) A comma segment that is a full state name, e.g. ", Texas".
    if (!state) {
      const idx = segs.findIndex((s, i) => i > 0 && !!STATE_BY_NAME[s.toLowerCase().replace(/\s+\d{5}.*$/, "")]);
      if (idx > 0) state = STATE_BY_NAME[segs[idx].toLowerCase().replace(/\s+\d{5}.*$/, "")];
    }

    // City = the segment immediately before the segment that carries the state.
    if (state) {
      const stateIdx = segs.findIndex((s) => {
        const up = s.toUpperCase();
        return up === state || up.startsWith(`${state} `) || s.toLowerCase().startsWith(US_STATES[state!].toLowerCase());
      });
      if (stateIdx > 0) city = clean(segs[stateIdx - 1]);
      // "Austin TX 78701" style (no comma between city and state)
      else if (stateIdx === 0 && segs.length === 1) {
        const m = addr.match(new RegExp(`([A-Za-z .'-]+?)\\s+${state}\\s+\\d{5}`));
        city = clean(m?.[1]);
      }
    }
  }

  const country = state ? "US" : hint ?? (addr && /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/.test(addr) ? "GB" : null);
  const basis: JurisdictionInfo["basis"] = state ? "address" : country ? "country_only" : "unknown";
  const coverage: JurisdictionInfo["coverage"] = country === "US" ? "us_curated" : country === "GB" || country === "CA" ? "country_curated" : "generic";

  const label = [city, state ? `${state}${zip ? ` ${zip}` : ""}` : null, country].filter(Boolean).join(", ") || "Unknown jurisdiction";

  return {
    country,
    state,
    stateName: state ? US_STATES[state] : null,
    city,
    zip,
    label,
    basis,
    coverage,
  };
}
