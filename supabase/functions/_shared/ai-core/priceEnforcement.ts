// ---------------------------------------------------------------------------
// Price Book Enforcement (feature: Price Book Enforcement)
//
// Sarah already has a `lookup_price` Vapi tool (see
// supabase/functions/vapi-webhook/index.ts, toolLookupPrice) that hands her
// a real, tenant-configured price during the call. But a tool RESULT isn't
// a guarantee of what she actually SAYS — an LLM can paraphrase a number
// wrong, round it in the wrong direction, or simply answer from its own
// system-prompt "memory" of pricing without calling the tool at all. This
// module is the enforcement layer: after the call, it deterministically
// checks what price(s) Sarah actually said against (a) what lookup_price
// actually returned this call, and (b) the full active price book —
// with NO further LLM call, on purpose. An AI grading its own AI output
// would just repeat the same failure mode this feature exists to catch;
// a plain regex-and-arithmetic check is slower to fool.
//
// Called from the end-of-call-report handler in vapi-webhook/index.ts,
// alongside (not instead of) analyzeCallIntelligence.
// ---------------------------------------------------------------------------

export interface PriceBookItemLite {
  service_name: string;
  pricing_model: "flat" | "starting_at" | "range" | "hourly";
  price_cents: number;
  price_max_cents: number | null;
}

export interface PriceLookupLite {
  query: string;
  matched_items: PriceBookItemLite[];
}

export interface PriceMismatch {
  stated_text: string;
  stated_cents: number;
  context_snippet: string;
  closest_catalog_match: {
    service_name: string;
    price_cents: number;
    price_max_cents: number | null;
  } | null;
}

export type PriceAccuracyStatus = "verified" | "mismatch" | "unverified" | "not_applicable";

export interface PriceAccuracyResult {
  price_accuracy_status: PriceAccuracyStatus;
  price_accuracy_details: PriceMismatch[];
  price_lookups_performed: number;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const DOLLAR_PATTERN = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/g;
const WORDS_DOLLARS_PATTERN = /\b(\d{1,3}(?:,\d{3})*)\s+dollars\b/gi;

/**
 * Pulls only the assistant's (Sarah's) turns out of a Vapi transcript.
 * Vapi transcripts are plain text with "AI:" / "User:" speaker prefixes
 * per line. If no speaker prefixes are found (a transcript format we
 * don't recognize), we fall back to scanning the whole blob — noisier
 * (it can pick up a price the CALLER said), but still better than
 * silently skipping enforcement on an unfamiliar format.
 */
function extractAssistantTurns(transcript: string): string {
  const lines = transcript.split("\n");
  const assistantLines = lines.filter((line) => /^\s*(AI|Assistant|Sarah)\s*:/i.test(line));
  if (assistantLines.length === 0) return transcript;
  return assistantLines.join("\n");
}

function extractPriceMentions(assistantText: string): { statedCents: number; statedText: string; contextSnippet: string }[] {
  const mentions: { statedCents: number; statedText: string; contextSnippet: string }[] = [];

  const addMention = (matchText: string, numeric: string, index: number) => {
    const cents = Math.round(parseFloat(numeric.replace(/,/g, "")) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return;
    const start = Math.max(0, index - 40);
    const end = Math.min(assistantText.length, index + matchText.length + 40);
    mentions.push({
      statedCents: cents,
      statedText: matchText.trim(),
      contextSnippet: assistantText.slice(start, end).trim(),
    });
  };

  for (const match of assistantText.matchAll(DOLLAR_PATTERN)) {
    addMention(match[0], match[1], match.index ?? 0);
  }
  for (const match of assistantText.matchAll(WORDS_DOLLARS_PATTERN)) {
    addMention(match[0], match[1], match.index ?? 0);
  }

  return mentions;
}

// ---------------------------------------------------------------------------
// Matching — deliberately generous tolerances. This is a "flag for human
// review" signal, not an autonomous block, so the cost of a false positive
// (owner ignores a real bug's worth of noise) outweighs the cost of a false
// negative (one bad quote slips through to the coaching report instead).
// ---------------------------------------------------------------------------

function isWithinTolerance(statedCents: number, item: PriceBookItemLite): boolean {
  switch (item.pricing_model) {
    case "flat": {
      const tolerance = Math.max(500, Math.round(item.price_cents * 0.05));
      return Math.abs(statedCents - item.price_cents) <= tolerance;
    }
    case "range": {
      const max = item.price_max_cents ?? item.price_cents;
      const tolerance = Math.round((max - item.price_cents) * 0.1) + 500;
      return statedCents >= item.price_cents - tolerance && statedCents <= max + tolerance;
    }
    case "starting_at":
      // A real job can legitimately land well above the starting price —
      // only flag amounts that fall BELOW what the book says is the floor.
      return statedCents >= item.price_cents * 0.95;
    case "hourly":
      // Ambiguous on its own (rate vs. a multi-hour total) — generous
      // window on both sides to avoid false positives.
      return statedCents >= item.price_cents * 0.9 && statedCents <= item.price_cents * 8;
    default:
      return false;
  }
}

function findClosestItem(statedCents: number, items: PriceBookItemLite[]): PriceBookItemLite | null {
  if (items.length === 0) return null;
  let closest = items[0];
  let closestDistance = Infinity;
  for (const item of items) {
    const reference = item.price_max_cents !== null
      ? (statedCents < item.price_cents ? item.price_cents : statedCents > item.price_max_cents ? item.price_max_cents : statedCents)
      : item.price_cents;
    const distance = Math.abs(statedCents - reference);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = item;
    }
  }
  return closest;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function verifyPriceAccuracy(
  transcript: string | null,
  priceBookItems: PriceBookItemLite[],
  lookups: PriceLookupLite[],
): PriceAccuracyResult {
  const lookupsPerformed = lookups.length;

  if (!transcript || priceBookItems.length === 0) {
    return { price_accuracy_status: "not_applicable", price_accuracy_details: [], price_lookups_performed: lookupsPerformed };
  }

  const assistantText = extractAssistantTurns(transcript);
  const mentions = extractPriceMentions(assistantText);

  if (mentions.length === 0) {
    return { price_accuracy_status: "not_applicable", price_accuracy_details: [], price_lookups_performed: lookupsPerformed };
  }

  const lookupItems = lookups.flatMap((l) => l.matched_items);

  const mismatches: PriceMismatch[] = [];
  for (const mention of mentions) {
    const matchedInLookups = lookupItems.some((item) => isWithinTolerance(mention.statedCents, item));
    const matchedInFullBook = matchedInLookups || priceBookItems.some((item) => isWithinTolerance(mention.statedCents, item));

    if (!matchedInFullBook) {
      const closest = findClosestItem(mention.statedCents, priceBookItems);
      mismatches.push({
        stated_text: mention.statedText,
        stated_cents: mention.statedCents,
        context_snippet: mention.contextSnippet,
        closest_catalog_match: closest
          ? { service_name: closest.service_name, price_cents: closest.price_cents, price_max_cents: closest.price_max_cents }
          : null,
      });
    }
  }

  if (mismatches.length > 0) {
    return { price_accuracy_status: "mismatch", price_accuracy_details: mismatches, price_lookups_performed: lookupsPerformed };
  }

  if (lookupsPerformed === 0) {
    // Every stated number happens to match something in the book, but
    // Sarah never actually called lookup_price this call — she recited
    // it rather than grounding it live. Correct today; unverified against
    // drift the moment the price book changes.
    return { price_accuracy_status: "unverified", price_accuracy_details: [], price_lookups_performed: 0 };
  }

  return { price_accuracy_status: "verified", price_accuracy_details: [], price_lookups_performed: lookupsPerformed };
}
