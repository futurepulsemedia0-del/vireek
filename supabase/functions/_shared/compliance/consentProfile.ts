// supabase/functions/_shared/compliance/consentProfile.ts
//
// DRAFT ENGINEERING DEFAULTS - NOT LEGAL ADVICE. Pure, dependency-free (Deno + Node + Vite safe).
//
//   resolveConsentProfile({ businessRegion, callerRegion })  ->  ConsentProfile
//
// Replaces the "US area code only" view with a pair of regions (where the business is, where the caller is) and returns
// the STRICTER of the two parties' rules. Anything unknown resolves to the strictest rule, never to "no consent needed".
//
// Rules (a statement about how the assistant behaves, not about what the law says):
//   one_party          no announcement needed.
//   announce_required  tell the caller up front that the call may be recorded; an explicit "yes" is not waited for.
//   two_party          announce AND wait for an explicit yes before recording / transcribing.
//
// Every profile carries legalReview = "draft". Nothing here may be shown in UI copy as a statement of law.
// TODO(counsel): review EVERY entry in the tables below per jurisdiction (statutes, business-line exceptions, beep-tone
//                alternatives, data-protection overlays) and flip legalReview only after written sign-off.
// TODO(counsel): the US all-party list mirrors recordingConsent.ts / recordingProfiles.ts; keep the three in sync.

export type ConsentRule = "one_party" | "two_party" | "announce_required";

export interface Region {
  /** ISO-3166 alpha-2. Missing / invalid => unknown. */
  country?: string | null;
  /** US state / DC or Canadian province code, e.g. "CA", "QC". */
  subdivision?: string | null;
}

export interface PartyProfile {
  rule: ConsentRule;
  /** Normalised jurisdiction label, e.g. "US-TX", "DE", "UNKNOWN". */
  jurisdiction: string;
  /** false => resolved by the strictest-default, not by a table entry. */
  known: boolean;
}

export interface ConsentProfile {
  rule: ConsentRule;
  announceRequired: boolean;
  explicitConsentRequired: boolean;
  /** Recording AND transcription must not start before the yes (Germany). */
  strictRegime: boolean;
  business: PartyProfile;
  caller: PartyProfile;
  /** true when at least one party was unknown and the strictest rule was applied. */
  defaultedToStrictest: boolean;
  legalReview: "draft";
}

export interface ConsentInput { businessRegion?: Region | null; callerRegion?: Region | null }

const STRICTNESS: Record<ConsentRule, number> = { one_party: 0, announce_required: 1, two_party: 2 };
const strictest = (a: ConsentRule, b: ConsentRule): ConsentRule => (STRICTNESS[a] >= STRICTNESS[b] ? a : b);

// TODO(counsel): verify.
const US_ALL_PARTY = new Set(["CA", "FL", "PA", "IL", "MA", "MI", "WA", "MD", "CT", "MT", "NH", "DE", "NV"]);
// 50 states + DC + inhabited territories. A code outside this set is treated as unknown, not as one-party.
const US_KNOWN = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO",
  "MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
  "DC","PR","GU","VI","AS","MP",
]);
// TODO(counsel): verify the EU list and whether any member state should be modelled separately like DE.
const EU = new Set(["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE"]);
const CA_PROVINCES = new Set(["AB","BC","MB","NB","NL","NS","NT","NU","ON","PE","QC","SK","YT"]);

const clean = (v: string | null | undefined) => (v ?? "").trim().toUpperCase();
const UNKNOWN: PartyProfile = { rule: "two_party", jurisdiction: "UNKNOWN", known: false };

/** One party's rule. Pure table lookup; anything not listed is unknown => strictest. */
export function resolvePartyProfile(region: Region | null | undefined): PartyProfile {
  const c = clean(region?.country);
  const sub = clean(region?.subdivision);
  if (!/^[A-Z]{2}$/.test(c)) return UNKNOWN;

  if (c === "US") {
    if (!sub || !US_KNOWN.has(sub)) return { rule: "two_party", jurisdiction: sub ? `US-${sub}` : "US", known: false };
    return { rule: US_ALL_PARTY.has(sub) ? "two_party" : "one_party", jurisdiction: `US-${sub}`, known: true };
  }
  if (c === "DE") return { rule: "two_party", jurisdiction: "DE", known: true };
  if (EU.has(c)) return { rule: "two_party", jurisdiction: c, known: true };
  if (c === "GB") return { rule: "announce_required", jurisdiction: "GB", known: true };
  if (c === "AU") return { rule: "two_party", jurisdiction: "AU", known: true };
  if (c === "CA") {
    if (!sub || !CA_PROVINCES.has(sub)) return { rule: "two_party", jurisdiction: sub ? `CA-${sub}` : "CA", known: false };
    return { rule: sub === "QC" ? "two_party" : "announce_required", jurisdiction: `CA-${sub}`, known: true };
  }
  return { rule: "two_party", jurisdiction: c, known: false };
}

export function resolveConsentProfile(input: ConsentInput): ConsentProfile {
  const business = resolvePartyProfile(input.businessRegion);
  const caller = resolvePartyProfile(input.callerRegion);
  const rule = strictest(business.rule, caller.rule);
  return {
    rule,
    announceRequired: rule !== "one_party",
    explicitConsentRequired: rule === "two_party",
    strictRegime: business.jurisdiction === "DE" || caller.jurisdiction === "DE",
    business,
    caller,
    defaultedToStrictest: !business.known || !caller.known,
    legalReview: "draft",
  };
}

// ------------------------------------------------------------------ caller region from a phone number
export type CallerRegionSource =
  | "missing"            // no / unparseable number
  | "us_area_code"       // NANP area code found in the all-party list (state known)
  | "ca_area_code"       // NANP area code assigned to Canada
  | "nanp_unmapped"      // +1 / 10-digit number whose state we cannot tell (legacy: treated as US, no notice)
  | "calling_code"       // international number, country from the calling code
  | "unrecognized";      // international number, calling code not in the table

export interface InferredCallerRegion { region: Region; source: CallerRegionSource }

// Same list as recordingConsent.ts (area codes of all-party states). Imported lazily by the caller to stay dependency-free:
// pass it in, or use inferCallerRegion's default below.
// TODO(counsel/owner): US/CA area-code tables are incomplete by design (an area code is not a location). Verify numbering plan.
const CA_AREA_CODES = new Set([
  "204","226","236","249","250","289","306","343","365","367","403","416","418","431","437","438","450","506","514","519",
  "548","579","581","587","604","613","639","647","672","705","709","742","778","780","807","819","825","867","873","902","905",
]);
const QC_AREA_CODES = new Set(["367","418","438","450","514","579","581","819","873"]);

// ITU calling code -> ISO country, limited to the jurisdictions this resolver knows. Longest prefix wins.
const CALLING_CODES: Record<string, string> = {
  "49": "DE", "44": "GB", "61": "AU",
  "43": "AT", "32": "BE", "359": "BG", "385": "HR", "357": "CY", "420": "CZ", "45": "DK", "372": "EE", "358": "FI", "33": "FR",
  "30": "GR", "36": "HU", "353": "IE", "39": "IT", "371": "LV", "370": "LT", "352": "LU", "356": "MT", "31": "NL", "48": "PL",
  "351": "PT", "40": "RO", "421": "SK", "386": "SI", "34": "ES", "46": "SE",
};

/**
 * @param allPartyStateForAreaCode  returns the US all-party state code for a 3-digit area code (or null). Injected so this
 *        file stays pure; consentContext.ts passes the table from recordingConsent.ts.
 */
export function inferCallerRegion(
  callerNumber: string | null | undefined,
  allPartyStateForAreaCode: (areaCode: string) => string | null = () => null,
): InferredCallerRegion {
  const raw = (callerNumber ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return { region: {}, source: "missing" };

  const nanp = (ten: string): InferredCallerRegion => {
    const area = ten.slice(0, 3);
    const us = allPartyStateForAreaCode(area);
    if (us) return { region: { country: "US", subdivision: us }, source: "us_area_code" };
    if (CA_AREA_CODES.has(area)) return { region: { country: "CA", subdivision: QC_AREA_CODES.has(area) ? "QC" : null }, source: "ca_area_code" };
    return { region: { country: "US", subdivision: null }, source: "nanp_unmapped" };
  };

  // Same acceptance rule as the legacy US check: 10 digits, or 11 digits starting with 1.
  if (digits.length === 10 && !raw.startsWith("+")) return nanp(digits);
  if (digits.length === 11 && digits.startsWith("1")) return nanp(digits.slice(1));

  if (raw.startsWith("+") || raw.startsWith("00")) {
    const national = raw.startsWith("00") ? digits.slice(2) : digits;
    for (const len of [3, 2]) {
      const iso = CALLING_CODES[national.slice(0, len)];
      if (iso) return { region: { country: iso }, source: "calling_code" };
    }
    return { region: {}, source: "unrecognized" };
  }
  return { region: {}, source: "missing" };
}
