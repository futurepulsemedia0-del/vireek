// supabase/functions/_shared/compliance-rules/jurisdiction.ts
//
// Resolve a US state for a customer. Address beats phone: an area code only
// says where a number was issued, not where the person is. The engine treats
// phone-derived states as a weak signal and says so in its assumptions.

export const US_STATES: ReadonlySet<string> = new Set(
  (
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND " +
    "OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY"
  ).split(" "),
);

export const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

/** Normalises "tx", " TX ", "US-TX" → "TX"; anything else → null. */
export function normalizeState(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().toUpperCase().replace(/^US-/, "");
  return US_STATES.has(s) ? s : null;
}

/** "US-TX" for a state code, "US" for federal. */
export function jurisdictionCode(state: string | null | undefined): string {
  const s = normalizeState(state);
  return s ? `US-${s}` : "US";
}

export function stateOfJurisdiction(code: string): string | null {
  return code === "US" ? null : normalizeState(code);
}

export function stateFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const a = address.toUpperCase();
  const zip = /\b([A-Z]{2})\.?,?\s+\d{5}(?:-\d{4})?\b/.exec(a);
  if (zip && US_STATES.has(zip[1])) return zip[1];
  const tail = /,\s*([A-Z]{2})\.?\s*(?:,|$)/.exec(a);
  if (tail && US_STATES.has(tail[1])) return tail[1];
  return null;
}

// Area codes for the states this engine ships rules for. NOT exhaustive and
// numbers port — which is why phone-derived results are labelled low-confidence.
const AREA_CODES: Record<string, string> = {};
function add(state: string, codes: string): void {
  for (const c of codes.split(" ")) AREA_CODES[c] = state;
}
add("CA", "209 213 279 310 323 341 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 858 909 916 925 949 951");
add("FL", "239 305 321 352 386 407 561 727 754 772 786 813 850 863 904 941 954");
add("PA", "215 223 267 272 412 445 484 570 610 717 724 814 835 878");
add("IL", "217 224 309 312 331 447 464 618 630 708 773 779 815 847 872");
add("MA", "339 351 413 508 617 774 781 857 978");
add("MI", "231 248 269 313 517 586 616 734 810 906 947 989");
add("WA", "206 253 360 425 509 564");
add("MD", "227 240 301 410 443 667");
add("CT", "203 475 860 959");
add("MT", "406");
add("NH", "603");
add("DE", "302");
add("NV", "702 725 775");
add("TX", "210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979");
add("OK", "405 539 572 580 918");
add("AZ", "480 520 602 623 928");

export function stateFromPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const d = phone.replace(/\D/g, "");
  const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (ten.length !== 10) return null;
  return AREA_CODES[ten.slice(0, 3)] ?? null;
}

export interface ResolvedState {
  state: string | null;
  basis: "explicit" | "address" | "phone" | "unknown";
}

export function resolveCounterpartyState(input: {
  explicitState?: string | null;
  address?: string | null;
  phone?: string | null;
}): ResolvedState {
  const explicit = normalizeState(input.explicitState);
  if (explicit) return { state: explicit, basis: "explicit" };
  const fromAddress = stateFromAddress(input.address);
  if (fromAddress) return { state: fromAddress, basis: "address" };
  const fromPhone = stateFromPhone(input.phone);
  if (fromPhone) return { state: fromPhone, basis: "phone" };
  return { state: null, basis: "unknown" };
}
