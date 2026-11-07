// supabase/functions/_shared/fraud/countries.ts
//
// Static destination knowledge used by destinationPolicy.ts. Pure data, no I/O.
// FAIL-CLOSED: a calling code that is not in this table is "unknown" and is
// denied for every plan. To support a new country, add it here on purpose.
//
// POLICY NOTE: the tier assignment and the premium / high-cost lists below are an
// INITIAL list from public toll-fraud (IRSF) guidance. They must be reviewed against
// your carrier's rate deck before launch (see "Decisions for the owner" in the report).

export type CountryTier = "domestic" | "standard" | "extended" | "high_cost";

export interface CountryInfo {
  iso: string;
  tier: CountryTier;
}

/** NANP area codes that are Canada (treated as "domestic" together with the US). */
export const CANADA_AREA_CODES: ReadonlySet<string> = new Set(
  ("204 226 236 249 250 263 289 306 343 354 365 367 368 382 403 416 418 431 437 438 450 468 474 506 514 519 " +
    "548 579 581 584 587 604 613 639 647 672 683 705 709 742 753 778 780 782 807 819 825 867 873 879 902 905 942").split(" "),
);

/** US territories that bill like the US mainland. */
export const US_TERRITORY_AREA_CODES: ReadonlySet<string> = new Set(["787", "939", "340"]);

/**
 * +1 area codes that are NOT the US or Canada: Caribbean / Pacific NANP members.
 * Classic "one-ring" and IRSF targets that look domestic to users but bill as international.
 */
export const NANP_NON_DOMESTIC: Readonly<Record<string, string>> = {
  "242": "BS", "246": "BB", "264": "AI", "268": "AG", "284": "VG", "345": "KY", "441": "BM", "473": "GD",
  "649": "TC", "658": "JM", "664": "MS", "670": "MP", "671": "GU", "684": "AS", "721": "SX", "758": "LC",
  "767": "DM", "784": "VC", "809": "DO", "829": "DO", "849": "DO", "868": "TT", "869": "KN", "876": "JM",
};

/** NANP numbers in these area codes are premium / carrier-billed: always denied. */
export const NANP_PREMIUM_AREA_CODES: ReadonlySet<string> = new Set([
  "900", "976", "700", "500", "533", "544", "566", "577", "588",
]);

/**
 * International "calling codes" that are never routable by this platform
 * (global networks, satellite, premium-rate services, universal numbers).
 */
export const NEVER_ROUTABLE_CODES: readonly string[] = [
  "800", "808", "870", "871", "872", "873", "874", "878", "881", "882", "883", "888", "979", "991",
];

/**
 * National-number prefixes (after the country code) that are premium rate or
 * non-geographic high-cost. Matched against the digits after the calling code.
 */
export const PREMIUM_NATIONAL_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  "44": ["9", "70", "87", "56"],
  "49": ["900", "137", "180", "32"],
  "33": ["89", "8"],
  "31": ["90", "6760"],
  "34": ["80", "90"],
  "39": ["89", "899"],
  "41": ["90"],
  "43": ["900", "930", "939"],
  "32": ["90"],
  "61": ["19"],
};

/** Calling code -> country. Longest-prefix match is applied by lookupCountry(). */
const TABLE: Readonly<Record<string, CountryInfo>> = {
  // Standard-cost, commonly serviced markets
  "44": { iso: "GB", tier: "standard" }, "353": { iso: "IE", tier: "standard" },
  "61": { iso: "AU", tier: "standard" }, "64": { iso: "NZ", tier: "standard" },
  "52": { iso: "MX", tier: "standard" }, "49": { iso: "DE", tier: "standard" },
  "33": { iso: "FR", tier: "standard" }, "34": { iso: "ES", tier: "standard" },
  "39": { iso: "IT", tier: "standard" }, "31": { iso: "NL", tier: "standard" },
  "32": { iso: "BE", tier: "standard" }, "41": { iso: "CH", tier: "standard" },
  "43": { iso: "AT", tier: "standard" }, "45": { iso: "DK", tier: "standard" },
  "46": { iso: "SE", tier: "standard" }, "47": { iso: "NO", tier: "standard" },
  "358": { iso: "FI", tier: "standard" }, "351": { iso: "PT", tier: "standard" },
  "48": { iso: "PL", tier: "standard" }, "65": { iso: "SG", tier: "standard" },
  "81": { iso: "JP", tier: "standard" }, "82": { iso: "KR", tier: "standard" },
  // Extended: valid destinations that cost more or carry more fraud risk
  "30": { iso: "GR", tier: "extended" }, "36": { iso: "HU", tier: "extended" }, "40": { iso: "RO", tier: "extended" },
  "420": { iso: "CZ", tier: "extended" }, "421": { iso: "SK", tier: "extended" }, "359": { iso: "BG", tier: "extended" },
  "385": { iso: "HR", tier: "extended" }, "352": { iso: "LU", tier: "extended" }, "354": { iso: "IS", tier: "extended" },
  "370": { iso: "LT", tier: "extended" }, "372": { iso: "EE", tier: "extended" }, "380": { iso: "UA", tier: "extended" },
  "381": { iso: "RS", tier: "extended" }, "90": { iso: "TR", tier: "extended" }, "972": { iso: "IL", tier: "extended" },
  "971": { iso: "AE", tier: "extended" }, "966": { iso: "SA", tier: "extended" }, "974": { iso: "QA", tier: "extended" },
  "27": { iso: "ZA", tier: "extended" }, "20": { iso: "EG", tier: "extended" }, "212": { iso: "MA", tier: "extended" },
  "54": { iso: "AR", tier: "extended" }, "55": { iso: "BR", tier: "extended" }, "56": { iso: "CL", tier: "extended" },
  "57": { iso: "CO", tier: "extended" }, "51": { iso: "PE", tier: "extended" }, "593": { iso: "EC", tier: "extended" },
  "595": { iso: "PY", tier: "extended" }, "598": { iso: "UY", tier: "extended" }, "506": { iso: "CR", tier: "extended" },
  "507": { iso: "PA", tier: "extended" }, "502": { iso: "GT", tier: "extended" }, "503": { iso: "SV", tier: "extended" },
  "504": { iso: "HN", tier: "extended" }, "505": { iso: "NI", tier: "extended" },
  "91": { iso: "IN", tier: "extended" }, "92": { iso: "PK", tier: "extended" }, "880": { iso: "BD", tier: "extended" },
  "60": { iso: "MY", tier: "extended" }, "62": { iso: "ID", tier: "extended" }, "63": { iso: "PH", tier: "extended" },
  "66": { iso: "TH", tier: "extended" }, "84": { iso: "VN", tier: "extended" }, "86": { iso: "CN", tier: "extended" },
  "234": { iso: "NG", tier: "extended" }, "233": { iso: "GH", tier: "extended" }, "254": { iso: "KE", tier: "extended" },
  // High-cost / frequent IRSF and one-ring destinations: denied unless staff add an explicit exception
  "53": { iso: "CU", tier: "high_cost" }, "216": { iso: "TN", tier: "high_cost" }, "224": { iso: "GN", tier: "high_cost" },
  "231": { iso: "LR", tier: "high_cost" }, "232": { iso: "SL", tier: "high_cost" }, "239": { iso: "ST", tier: "high_cost" },
  "247": { iso: "AC", tier: "high_cost" }, "252": { iso: "SO", tier: "high_cost" }, "263": { iso: "ZW", tier: "high_cost" },
  "269": { iso: "KM", tier: "high_cost" }, "371": { iso: "LV", tier: "high_cost" }, "500": { iso: "FK", tier: "high_cost" },
  "674": { iso: "NR", tier: "high_cost" }, "682": { iso: "CK", tier: "high_cost" }, "686": { iso: "KI", tier: "high_cost" },
  "688": { iso: "TV", tier: "high_cost" }, "960": { iso: "MV", tier: "high_cost" }, "970": { iso: "PS", tier: "high_cost" },
  "218": { iso: "LY", tier: "high_cost" }, "93": { iso: "AF", tier: "high_cost" }, "98": { iso: "IR", tier: "high_cost" },
  "964": { iso: "IQ", tier: "high_cost" }, "7": { iso: "RU", tier: "high_cost" }, "375": { iso: "BY", tier: "high_cost" },
};

export interface CountryLookup {
  iso: string;
  tier: CountryTier;
  callingCode: string;
  /** Digits after the calling code. */
  national: string;
}

/** Resolves an E.164 digit string (no '+') to a country. Returns null for unknown codes (fail closed). */
export function lookupCountry(digits: string): CountryLookup | null {
  if (digits.startsWith("1")) {
    const area = digits.slice(1, 4);
    const national = digits.slice(1);
    if (CANADA_AREA_CODES.has(area)) return { iso: "CA", tier: "domestic", callingCode: "1", national };
    if (US_TERRITORY_AREA_CODES.has(area)) return { iso: "US", tier: "domestic", callingCode: "1", national };
    const other = NANP_NON_DOMESTIC[area];
    if (other) return { iso: other, tier: "high_cost", callingCode: "1", national };
    return { iso: "US", tier: "domestic", callingCode: "1", national };
  }
  for (const len of [3, 2, 1]) {
    const code = digits.slice(0, len);
    const hit = TABLE[code];
    if (hit) return { ...hit, callingCode: code, national: digits.slice(len) };
  }
  return null;
}

export function listKnownCountries(): string[] {
  return Array.from(new Set(["US", "CA", ...Object.values(TABLE).map((c) => c.iso)])).sort();
}
