// supabase/functions/_shared/review-shield/match.ts
//
// Ledger match: does the business's OWN record contain someone who plausibly wrote this
// review? Design rule: the costly mistake is calling a genuine customer "no match", so
// every threshold leans toward REPORTING a possible match. A match or possible match is
// always shown to the owner and can never flow into an appeal pack (see eligibility.ts).
//
// This file is pure. Names/addresses stay inside the tenant: callers pass records already
// loaded server-side for ONE account owner; the output carries ids, scores and reason codes.

import { clamp, foldDiacritics, tokenize } from "./text.ts";

export type LedgerSource = "call" | "sms" | "booking" | "job" | "invoice" | "customer";
export const LEDGER_SOURCES: LedgerSource[] = ["call", "sms", "booking", "job", "invoice", "customer"];

const NICKNAMES: Record<string, string> = {
  bob: "robert", rob: "robert", bobby: "robert", robbie: "robert", bill: "william", billy: "william", will: "william", willy: "william",
  liz: "elizabeth", beth: "elizabeth", betty: "elizabeth", lizzie: "elizabeth", eliza: "elizabeth", jim: "james", jimmy: "james", jamie: "james",
  mike: "michael", mikey: "michael", mick: "michael", dave: "david", davy: "david", tom: "thomas", tommy: "thomas", dick: "richard",
  rick: "richard", ricky: "richard", rich: "richard", jack: "john", johnny: "john", jon: "john", joe: "joseph", joey: "joseph",
  steve: "steven", stevie: "steven", chris: "christopher", kate: "katherine", katie: "katherine", kathy: "katherine", kat: "katherine",
  cathy: "katherine", sue: "susan", susie: "susan", peggy: "margaret", maggie: "margaret", meg: "margaret", peg: "margaret",
  tony: "anthony", andy: "andrew", drew: "andrew", matt: "matthew", nick: "nicholas", dan: "daniel", danny: "daniel", ed: "edward",
  eddie: "edward", ted: "edward", teddy: "edward", pat: "patrick", patty: "patricia", jen: "jennifer", jenny: "jennifer", sam: "samuel",
  alex: "alexander", ben: "benjamin", benny: "benjamin", charlie: "charles", chuck: "charles", hank: "henry", harry: "henry",
  larry: "lawrence", jerry: "gerald", greg: "gregory", pete: "peter", ron: "ronald", ronnie: "ronald", terry: "terence", vicky: "victoria",
  becky: "rebecca", debbie: "deborah", deb: "deborah", barb: "barbara", abby: "abigail", sandy: "sandra", cindy: "cynthia", nate: "nathan",
  zach: "zachary", zack: "zachary", josh: "joshua", jake: "jacob", tim: "timothy", timmy: "timothy", ken: "kenneth", kenny: "kenneth",
};
const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "mx", "sir", "madam"]);
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

export interface NameParts {
  tokens: string[]; // canonical tokens, nicknames mapped, titles/suffixes removed
  raw: string[]; // same tokens before nickname mapping
  suffix: string | null;
}

export function parseName(input: string | null | undefined): NameParts {
  const raw = tokenize(foldDiacritics(String(input ?? ""))).map((x) => x.replace(/'/g, ""));
  const kept = raw.filter((x) => x && !TITLES.has(x) && !SUFFIXES.has(x));
  const suffix = raw.find((x) => SUFFIXES.has(x)) ?? null;
  return { tokens: kept.map((x) => NICKNAMES[x] ?? x), raw: kept, suffix };
}

function editDistanceAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // transposition
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return s.slice(i) === l.slice(i + 1); // insertion/deletion
}

export type NameKind = "exact" | "nickname" | "initial" | "fuzzy" | "first_name_only" | "none";
export interface NameScore {
  score: number; // 0..1
  kind: NameKind;
  suffixConflict: boolean;
}

/**
 * Review names are often "Maria G." or "Mike". Scores one reviewer name against one ledger name.
 * Single-token reviewers can reach at most 0.5 ("possible") — a first name alone never "matches".
 */
export function scoreName(reviewer: string, ledgerName: string): NameScore {
  const a = parseName(reviewer);
  const b = parseName(ledgerName);
  if (!a.tokens.length || !b.tokens.length) return { score: 0, kind: "none", suffixConflict: false };
  const suffixConflict = (a.suffix !== null || b.suffix !== null) && a.suffix !== b.suffix;

  const aFirst = a.tokens[0];
  const bFirst = b.tokens[0];
  const aLast = a.tokens.length > 1 ? a.tokens[a.tokens.length - 1] : null;
  const bLast = b.tokens.length > 1 ? b.tokens[b.tokens.length - 1] : null;

  const firstExact = aFirst === bFirst;
  const firstFuzzy = !firstExact && aFirst.length >= 4 && bFirst.length >= 4 && editDistanceAtMost1(aFirst, bFirst);
  const firstInitial = !firstExact && (aFirst.length === 1 || bFirst.length === 1) && aFirst[0] === bFirst[0];
  const firstOk = firstExact || firstFuzzy || firstInitial;

  if (!aLast || !bLast) {
    // Reviewer (or ledger entry) has a single token.
    const only = !firstOk ? 0 : 0.5;
    return { score: only, kind: only ? "first_name_only" : "none", suffixConflict };
  }

  const lastExact = aLast === bLast;
  const lastFuzzy = !lastExact && aLast.length >= 5 && bLast.length >= 5 && editDistanceAtMost1(aLast, bLast);
  const lastInitial = !lastExact && (aLast.length === 1 || bLast.length === 1) && aLast[0] === bLast[0];

  let score = 0;
  let kind: NameKind = "none";
  if (firstExact && lastExact) {
    const viaNick = a.raw[0] !== b.raw[0];
    score = viaNick ? 0.92 : 1;
    kind = viaNick ? "nickname" : "exact";
  } else if (firstOk && (lastExact || lastFuzzy)) {
    score = firstInitial ? 0.8 : 0.78;
    kind = firstInitial ? "initial" : "fuzzy";
  } else if (firstOk && lastInitial) {
    score = firstExact ? 0.72 : 0.6; // "Maria G." vs "Maria Gonzalez"
    kind = "initial";
  } else if (lastExact && !firstOk) {
    score = 0.3; // same surname, different first name: a spouse/relative is possible, not a match
    kind = "fuzzy";
  } else if (firstExact) {
    score = 0.3;
    kind = "first_name_only";
  }
  if (suffixConflict) score = Math.min(score, 0.5);
  return { score, kind, suffixConflict };
}

// ---- context signals ----------------------------------------------------------------

const STOP = new Set(["the", "and", "for", "with", "was", "were", "had", "have", "that", "this", "they", "them", "our", "your", "you", "but", "not", "very", "from", "service", "company", "work", "worst", "terrible", "awful", "great", "good", "bad"]);

function contentTokens(s: string | null | undefined): Set<string> {
  return new Set(tokenize(s).filter((x) => x.length >= 4 && !STOP.has(x)).map((x) => x.replace(/(ing|ers|er|es|s)$/, "")));
}

/** Overlap between what the review claims and a record's service type (e.g. "furnace repair" in the text). */
export function serviceOverlap(reviewText: string | null, serviceType: string | null | undefined): number {
  const svc = contentTokens(serviceType);
  if (!svc.size) return 0;
  const txt = contentTokens(reviewText);
  let hit = 0;
  for (const x of svc) if (txt.has(x)) hit++;
  return hit / svc.size;
}

/** Does the review mention the place (a street/city token) found in the record's address? Conservative: needs a 4+ letter token. */
export function placeMentioned(reviewText: string | null, address: string | null | undefined): boolean {
  const addr = [...contentTokens(address)].filter((x) => !/^\d+$/.test(x));
  if (!addr.length) return false;
  const txt = contentTokens(reviewText);
  return addr.some((x) => txt.has(x));
}

// ---- ledger evaluation ----------------------------------------------------------------

export interface LedgerRecord {
  source: LedgerSource;
  id: string;
  /** Primary name first, then aliases / household members from identity resolution. */
  names: string[];
  at: string | null; // ISO — when the call / job / invoice happened
  service?: string | null;
  address?: string | null;
}

export type MatchBand = "match" | "possible" | "none";

export interface MatchHit {
  source: LedgerSource;
  recordId: string;
  band: MatchBand;
  score: number;
  reasons: ("name_exact" | "name_nickname" | "name_initial" | "name_fuzzy" | "first_name_only" | "household_alias" | "service_overlap" | "place_mentioned" | "suffix_conflict")[];
}

export interface SourceReport {
  source: LedgerSource;
  searched: boolean;
  /** false when the query failed or the source isn't enabled — then the overall result can't be "no_match". */
  error: string | null;
  windowStart: string;
  windowEnd: string;
  recordsScanned: number;
  hits: MatchHit[];
}

export interface LedgerReport {
  reviewId: string;
  overall: "match" | "possible_match" | "no_match" | "incomplete";
  sources: SourceReport[];
}

export const POSSIBLE_THRESHOLD = 0.45;
export const MATCH_THRESHOLD = 0.85;

export interface LedgerWindow {
  /** Service can predate the review by a long time; default 540 days before, 7 days after (late-synced records). */
  daysBefore?: number;
  daysAfter?: number;
}

export function matchWindow(reviewedAt: string, w: LedgerWindow = {}): { start: string; end: string } {
  const t0 = Date.parse(reviewedAt);
  return {
    start: new Date(t0 - (w.daysBefore ?? 540) * 86_400_000).toISOString(),
    end: new Date(t0 + (w.daysAfter ?? 7) * 86_400_000).toISOString(),
  };
}

export function scoreRecord(
  review: { reviewerName: string; body: string | null },
  rec: LedgerRecord,
): MatchHit | null {
  let best: NameScore = { score: 0, kind: "none", suffixConflict: false };
  let viaAlias = false;
  for (let i = 0; i < rec.names.length; i++) {
    const s = scoreName(review.reviewerName, rec.names[i]);
    if (s.score > best.score) {
      best = s;
      viaAlias = i > 0;
    }
  }
  if (best.score < 0.3) return null; // context alone never creates a match

  const svc = serviceOverlap(review.body, rec.service);
  const place = placeMentioned(review.body, rec.address);
  const total = clamp(best.score + (svc > 0 ? 0.1 + 0.1 * svc : 0) + (place ? 0.12 : 0), 0, 1);
  if (total < POSSIBLE_THRESHOLD) return null;

  const reasons: MatchHit["reasons"] = [];
  const kindReason = { exact: "name_exact", nickname: "name_nickname", initial: "name_initial", fuzzy: "name_fuzzy", first_name_only: "first_name_only" } as const;
  if (best.kind !== "none") reasons.push(kindReason[best.kind]);
  if (viaAlias) reasons.push("household_alias");
  if (svc > 0) reasons.push("service_overlap");
  if (place) reasons.push("place_mentioned");
  if (best.suffixConflict) reasons.push("suffix_conflict");

  return { source: rec.source, recordId: rec.id, band: total >= MATCH_THRESHOLD ? "match" : "possible", score: Math.round(total * 100) / 100, reasons };
}

export interface LedgerInput {
  review: { id: string; reviewerName: string; body: string | null; reviewedAt: string };
  /** Per source: the records returned by the server-side query for this window, or an error. */
  sources: Partial<Record<LedgerSource, { records: LedgerRecord[] } | { error: string }>>;
  window?: LedgerWindow;
}

/**
 * Searches every source in LEDGER_SOURCES. A source with no entry, or an error, is reported as
 * not searched and forces "incomplete" — "no matching record" is only ever claimed when ALL
 * sources were searched successfully.
 */
export function evaluateLedger(input: LedgerInput): LedgerReport {
  const win = matchWindow(input.review.reviewedAt, input.window);
  const reports: SourceReport[] = LEDGER_SOURCES.map((source) => {
    const res = input.sources[source];
    const base = { source, windowStart: win.start, windowEnd: win.end };
    if (!res) return { ...base, searched: false, error: "not_searched", recordsScanned: 0, hits: [] };
    if ("error" in res) return { ...base, searched: false, error: res.error, recordsScanned: 0, hits: [] };
    const inWin = res.records.filter((r) => {
      if (!r.at) return true; // undated customer rows are kept: dropping them could hide a genuine customer
      const x = Date.parse(r.at);
      return Number.isFinite(x) ? x >= Date.parse(win.start) && x <= Date.parse(win.end) : true;
    });
    const hits = inWin
      .map((r) => scoreRecord(input.review, r))
      .filter((h): h is MatchHit => h !== null)
      .sort((a, b) => b.score - a.score);
    return { ...base, searched: true, error: null, recordsScanned: inWin.length, hits };
  });

  const allHits = reports.flatMap((r) => r.hits);
  let overall: LedgerReport["overall"] = "no_match";
  if (reports.some((r) => !r.searched)) overall = "incomplete";
  if (allHits.some((h) => h.band === "possible")) overall = "possible_match";
  if (allHits.some((h) => h.band === "match")) overall = "match";
  return { reviewId: input.review.id, overall, sources: reports };
}
