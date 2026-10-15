// supabase/functions/_shared/data-import/normalize.ts
//
// Pure, dependency-free value normalizers for the import engine (v2).
// Everything here is deterministic and unit-tested (plan.test.ts) — the
// validation preview and the real import call the exact same functions, so
// what the user previews is what gets written.

export function cleanText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- phone

export interface NormalizedPhone {
  /** Stored value: E.164 for US/CA numbers and anything with an explicit +country code. */
  e164: string;
  /** Matching key — last 10 digits (or all digits when shorter), format-insensitive. */
  key: string;
}

/** Returns null when the value can't be a real phone number. */
export function normalizePhone(raw: string | undefined): NormalizedPhone | null {
  const text = cleanText(raw);
  if (!text) return null;
  const hasPlus = text.startsWith("+");
  // Strip extensions ("x123", "ext. 4") before extracting digits.
  const base = text.replace(/\s*(?:ext\.?|x|#)\s*\d+\s*$/i, "");
  let digits = base.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;

  if (!hasPlus && digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (!hasPlus && digits.length === 10) {
    return { e164: `+1${digits}`, key: digits };
  }
  if (hasPlus) return { e164: `+${digits}`, key: digits.slice(-10) };
  // 7-9 or 12-15 digits with no country code: keep digits, can't safely add +1.
  return { e164: digits, key: digits.slice(-10) };
}

/** Matching key for an already-stored phone (any historical format). */
export function phoneKey(stored: string | null | undefined): string | null {
  const digits = cleanText(stored).replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

// ---------------------------------------------------------------- email

const EMAIL_RE = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}$/;

export function normalizeEmail(raw: string | undefined): string | null {
  const text = cleanText(raw).toLowerCase();
  if (!text) return null;
  return EMAIL_RE.test(text) ? text : null;
}

// ------------------------------------------------------------ name/address

const ABBREVIATIONS: [RegExp, string][] = [
  [/\bstreet\b/g, "st"], [/\bavenue\b/g, "ave"], [/\broad\b/g, "rd"], [/\bdrive\b/g, "dr"],
  [/\blane\b/g, "ln"], [/\bboulevard\b/g, "blvd"], [/\bcourt\b/g, "ct"], [/\bcircle\b/g, "cir"],
  [/\bsuite\b/g, "ste"], [/\bapartment\b/g, "apt"], [/\bnorth\b/g, "n"], [/\bsouth\b/g, "s"],
  [/\beast\b/g, "e"], [/\bwest\b/g, "w"],
];

/** Loose comparison key for names and addresses ("123 Main Street, Apt 4" == "123 main st apt 4"). */
export function looseKey(value: string | null | undefined): string {
  let text = cleanText(value).toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, rep] of ABBREVIATIONS) text = text.replace(re, rep);
  return text;
}

export function joinAddress(parts: { street?: string; city?: string; state?: string; zip?: string }): string {
  const street = cleanText(parts.street);
  const city = cleanText(parts.city);
  const stateZip = [cleanText(parts.state), cleanText(parts.zip)].filter(Boolean).join(" ");
  return [street, city, stateZip].filter(Boolean).join(", ");
}

// ---------------------------------------------------------------- money

/** Returns a number, or null when empty. Returns undefined when present but unparseable. */
export function parseMoney(raw: string | undefined): number | null | undefined {
  const text = cleanText(raw);
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || /^-/.test(text);
  const stripped = text.replace(/[^0-9.,]/g, "");
  if (!stripped || !/\d/.test(stripped)) return undefined;
  // "1.234,56" (EU) vs "1,234.56" (US): the LAST separator is the decimal point.
  const lastDot = stripped.lastIndexOf(".");
  const lastComma = stripped.lastIndexOf(",");
  let normalized: string;
  if (lastComma > lastDot) {
    const decimals = stripped.length - lastComma - 1;
    normalized = decimals === 3 && lastDot === -1 ? stripped.replace(/,/g, "") : stripped.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = stripped.replace(/,/g, "");
  }
  const value = Number(normalized);
  if (!Number.isFinite(value)) return undefined;
  return Math.round((negative ? -value : value) * 100) / 100;
}

// ---------------------------------------------------------------- dates

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Interprets wall-clock fields in `tz` and returns the UTC instant (handles DST). */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let result = guess - tzOffsetMs(guess, tz);
  const corrected = guess - tzOffsetMs(result, tz);
  if (corrected !== result) result = corrected;
  return new Date(result);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function to24h(hour: number, meridiem: string | undefined): number {
  if (!meridiem) return hour;
  const pm = meridiem.toLowerCase() === "pm";
  if (pm && hour < 12) return hour + 12;
  if (!pm && hour === 12) return 0;
  return hour;
}

/**
 * Parses the date formats competitor exports actually use. Wall-clock times
 * without an explicit offset are interpreted in the business's timezone.
 * Returns null for empty, undefined for unparseable.
 */
export function parseDateTime(raw: string | undefined, tz: string): string | null | undefined {
  const text = cleanText(raw);
  if (!text) return null;

  const valid = (y: number, mo: number, d: number, h: number, mi: number, s: number): string | undefined => {
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59 || y < 1990 || y > 2100) return undefined;
    const date = zonedToUtc(y, mo, d, h, mi, s, tz);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  };

  // ISO with explicit zone → trust it.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const ms = Date.parse(text.replace(" ", "T"));
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }

  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (m) return valid(+m[1], +m[2], +m[3], to24h(+(m[4] ?? 0), m[7]), +(m[5] ?? 0), +(m[6] ?? 0));

  // US style M/D/YYYY [h:mm[:ss] [AM|PM]] (also M-D-YYYY and 2-digit years)
  m = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return valid(year, +m[1], +m[2], to24h(+(m[4] ?? 0), m[7]), +(m[5] ?? 0), +(m[6] ?? 0));
  }

  // "Mar 14, 2024 2:30 PM" / "14 March 2024"
  m = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:[,\s]+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    return valid(+m[3], mo, +m[2], to24h(+(m[4] ?? 0), m[7]), +(m[5] ?? 0), +(m[6] ?? 0));
  }
  m = text.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    return valid(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1], to24h(+(m[4] ?? 0), m[7]), +(m[5] ?? 0), +(m[6] ?? 0));
  }

  // Excel serial number that survived as text (General-formatted cell).
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial > 20000 && serial < 80000) {
      const ms = Math.round((serial - 25569) * 86400 * 1000);
      const d = new Date(ms);
      return valid(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
    }
  }
  return undefined;
}

// ------------------------------------------------------------- statuses

const JOB_STATUS_SYNONYMS: Record<string, string> = {
  scheduled: "scheduled", booked: "scheduled", upcoming: "scheduled", unscheduled: "scheduled", pending: "scheduled",
  "to be scheduled": "scheduled", dispatched: "en_route", "en route": "en_route", enroute: "en_route",
  "on my way": "en_route", "on the way": "en_route", "in progress": "in_progress", working: "in_progress",
  started: "in_progress", active: "in_progress", "in-progress": "in_progress",
  completed: "completed", complete: "completed", done: "completed", closed: "completed", finished: "completed",
  "complete rated": "completed", "complete unrated": "completed", "requires invoicing": "completed",
  invoiced: "completed", paid: "completed", archived: "completed", "late": "scheduled",
  cancelled: "cancelled", canceled: "cancelled", "user canceled": "cancelled", "pro canceled": "cancelled",
  "on hold": "scheduled", hold: "scheduled",
};

export function mapJobStatus(raw: string | undefined): string | null | undefined {
  const text = cleanText(raw).toLowerCase();
  if (!text) return null;
  return JOB_STATUS_SYNONYMS[text];
}

const INVOICE_STATUS_SYNONYMS: Record<string, string> = {
  paid: "paid", "paid in full": "paid", closed: "paid", settled: "paid", complete: "paid", completed: "paid",
  sent: "sent", open: "sent", unpaid: "sent", outstanding: "sent", "past due": "sent", overdue: "sent",
  partial: "sent", "partially paid": "sent", "awaiting payment": "sent", due: "sent", issued: "sent", invoiced: "sent",
  "not sent": "not_sent", draft: "not_sent", none: "not_sent", "not invoiced": "not_sent", pending: "not_sent",
  "requires invoicing": "not_sent", void: "not_sent", voided: "not_sent",
};

export function mapInvoiceStatus(raw: string | undefined): string | null | undefined {
  const text = cleanText(raw).toLowerCase();
  if (!text) return null;
  return INVOICE_STATUS_SYNONYMS[text];
}

export function mapCustomerType(raw: string | undefined): "residential" | "commercial" | null | undefined {
  const text = cleanText(raw).toLowerCase();
  if (!text) return null;
  if (/commercial|business|company|b2b|corporate|property manage|landlord|industrial/.test(text)) return "commercial";
  if (/residential|homeowner|home|individual|consumer|b2c|personal|tenant/.test(text)) return "residential";
  return undefined;
}
