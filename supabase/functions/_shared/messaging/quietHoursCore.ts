// supabase/functions/_shared/messaging/quietHoursCore.ts
//
// Pure, dependency-free decision engine for quiet hours + timezone-aware
// sending. No Deno / npm / network imports on purpose: it is unit-tested
// with vitest and also imported by the dashboard preview UI, so the rule
// the UI shows is byte-for-byte the rule the server enforces.
//
// NOT LEGAL ADVICE. Compliance floor: for SMS and calls the recipient's
// local window can never be wider than 08:00–21:00 (the TCPA default),
// no matter what the business configures — a business can only NARROW it.
// Stricter state rules (e.g. FL/OK/WA/MD/TX) are configured per business
// via the window and holiday blackouts.

export type Channel = "sms" | "email" | "call";
/** marketing: campaigns/nurture. service: reminders, invoices, updates.
 *  emergency: safety / active-emergency dispatch. */
export type Purpose = "marketing" | "service" | "emergency";

export interface QuietHoursSettings {
  enabled: boolean;
  /** Business IANA timezone, e.g. "America/Chicago". */
  timezone: string;
  /** Quiet period start, "HH:MM" local. May be later than `end` (overnight). */
  start: string;
  /** Quiet period end, "HH:MM" local. */
  end: string;
  /** Channels the quiet window applies to. */
  channels: Channel[];
  /** Extra weekdays (0=Sun..6=Sat) that are fully quiet, e.g. [0] for Sundays. */
  quietWeekdays: number[];
  /** Skip US federal holidays (computed). */
  useFederalHolidays: boolean;
  /** Extra blackout dates "YYYY-MM-DD" (business holidays / closures). */
  blackoutDates: string[];
  /** Whether purpose=emergency may bypass the window. */
  allowEmergencyOverride: boolean;
}

export const DEFAULT_QUIET_HOURS: QuietHoursSettings = {
  enabled: true,
  timezone: "America/New_York",
  start: "20:00",
  end: "08:00",
  channels: ["sms", "email", "call"],
  quietWeekdays: [],
  useFederalHolidays: true,
  blackoutDates: [],
  allowEmergencyOverride: true,
};

/** Hard legal-style floor for sms + call, recipient local time. */
export const COMPLIANCE_FLOOR = { start: "21:00", end: "08:00" } as const;

export type TzSource = "customer" | "address" | "phone" | "business";

export interface ResolvedTimezone {
  timezone: string;
  source: TzSource;
}

export type Decision =
  | {
      allowed: true;
      reason: "OPEN" | "NOT_COVERED" | "DISABLED" | "EMERGENCY_OVERRIDE" | "MANUAL_OVERRIDE";
      timezone: string;
      tzSource: TzSource;
      localTime: string;
    }
  | {
      allowed: false;
      reason: "QUIET_HOURS" | "COMPLIANCE_FLOOR" | "HOLIDAY" | "QUIET_WEEKDAY";
      sendAt: string; // ISO UTC — earliest instant the message may go out
      timezone: string;
      tzSource: TzSource;
      localTime: string;
      detail: string;
    };

export interface DecideInput {
  channel: Channel;
  purpose: Purpose;
  settings: QuietHoursSettings;
  tz: ResolvedTimezone;
  now: Date;
  /** Owner-confirmed one-off override for non-marketing sends. */
  manualOverride?: { reason: string } | null;
}

// --------------------------------------------------------------------------
// Timezone primitives (Intl only — DST-safe, no libraries)
// --------------------------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=Sun..6=Sat
  dateKey: string; // YYYY-MM-DD
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function zonedParts(date: Date, tz: string): ZonedParts {
  const m: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(date)) m[p.type] = p.value;
  const year = Number(m.year);
  const month = Number(m.month);
  const day = Number(m.day);
  return {
    year,
    month,
    day,
    hour: Number(m.hour) % 24,
    minute: Number(m.minute),
    second: Number(m.second),
    weekday: Math.max(0, WEEKDAYS.indexOf(m.weekday)),
    dateKey: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** Convert a wall-clock time in `tz` to a UTC instant. Handles DST gaps/overlaps. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const diff = wall - seen;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

export function parseHHMM(v: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return NaN;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 24 || mi < 0 || mi > 59 || (h === 24 && mi !== 0)) return NaN;
  return h * 60 + mi;
}

function addDaysKey(y: number, m: number, d: number, n: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// --------------------------------------------------------------------------
// Holidays (US federal, computed — no table to maintain)
// --------------------------------------------------------------------------

function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

function lastWeekday(year: number, month: number, weekday: number): number {
  const last = new Date(Date.UTC(year, month, 0));
  return last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
}

/** Observed US federal holidays + Christmas Eve / Thanksgiving Friday courtesy days. */
export function federalHolidayKeys(year: number): Set<string> {
  const k = (m: number, d: number) => `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const keys = new Set<string>();
  const observed = (m: number, d: number) => {
    const wd = new Date(Date.UTC(year, m - 1, d)).getUTCDay();
    if (wd === 6) {
      const t = addDaysKey(year, m, d, -1);
      keys.add(k(t.m, t.d));
    } else if (wd === 0) {
      const t = addDaysKey(year, m, d, 1);
      keys.add(k(t.m, t.d));
    } else keys.add(k(m, d));
  };
  observed(1, 1); // New Year's Day
  keys.add(k(1, nthWeekday(year, 1, 1, 3))); // MLK
  keys.add(k(2, nthWeekday(year, 2, 1, 3))); // Presidents' Day
  keys.add(k(5, lastWeekday(year, 5, 1))); // Memorial Day
  observed(6, 19); // Juneteenth
  observed(7, 4); // Independence Day
  keys.add(k(9, nthWeekday(year, 9, 1, 1))); // Labor Day
  keys.add(k(10, nthWeekday(year, 10, 1, 2))); // Columbus / Indigenous Peoples' Day
  observed(11, 11); // Veterans Day
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  keys.add(k(11, thanksgiving));
  keys.add(k(11, thanksgiving + 1)); // day after
  keys.add(k(12, 24)); // Christmas Eve (courtesy)
  observed(12, 25); // Christmas
  return keys;
}

export function isHoliday(dateKey: string, settings: QuietHoursSettings): boolean {
  if (settings.blackoutDates.includes(dateKey)) return true;
  if (!settings.useFederalHolidays) return false;
  const year = Number(dateKey.slice(0, 4));
  // Jan 1 observed on a Saturday falls in the previous year's Dec 31.
  return federalHolidayKeys(year).has(dateKey) || federalHolidayKeys(year + 1).has(dateKey);
}

// --------------------------------------------------------------------------
// Customer timezone detection: explicit > address (state/ZIP) > phone area code > business
// --------------------------------------------------------------------------

const STATE_TZ: Record<string, string> = {
  CT: "America/New_York", DE: "America/New_York", DC: "America/New_York", GA: "America/New_York",
  MA: "America/New_York", MD: "America/New_York", ME: "America/New_York", NH: "America/New_York",
  NJ: "America/New_York", NY: "America/New_York", NC: "America/New_York", OH: "America/New_York",
  PA: "America/New_York", RI: "America/New_York", SC: "America/New_York", VT: "America/New_York",
  VA: "America/New_York", WV: "America/New_York", FL: "America/New_York", MI: "America/Detroit",
  IN: "America/Indiana/Indianapolis", KY: "America/New_York",
  AL: "America/Chicago", AR: "America/Chicago", IL: "America/Chicago", IA: "America/Chicago",
  LA: "America/Chicago", MN: "America/Chicago", MS: "America/Chicago", MO: "America/Chicago",
  OK: "America/Chicago", WI: "America/Chicago", TX: "America/Chicago", TN: "America/Chicago",
  KS: "America/Chicago", NE: "America/Chicago", ND: "America/Chicago", SD: "America/Chicago",
  CO: "America/Denver", MT: "America/Denver", NM: "America/Denver", UT: "America/Denver",
  WY: "America/Denver", ID: "America/Boise", AZ: "America/Phoenix",
  CA: "America/Los_Angeles", NV: "America/Los_Angeles", OR: "America/Los_Angeles", WA: "America/Los_Angeles",
  AK: "America/Anchorage", HI: "Pacific/Honolulu", PR: "America/Puerto_Rico", VI: "America/Puerto_Rico",
  ON: "America/Toronto", QC: "America/Toronto", BC: "America/Vancouver", AB: "America/Edmonton",
  MB: "America/Winnipeg", SK: "America/Regina", NS: "America/Halifax", NB: "America/Moncton",
  NL: "America/St_Johns",
};

/** First ZIP digit -> most likely zone, used only when no state is parseable. */
const ZIP3_OVERRIDES: Record<string, string> = {
  // Split states where the state default is wrong for part of the state.
  "799": "America/Denver", // El Paso TX
  "798": "America/Chicago",
  "835": "America/Los_Angeles", // N. Idaho panhandle
  "836": "America/Boise",
};

/** Area codes in states that span timezones, or notable exceptions to STATE_TZ. */
const AREA_CODE_TZ: Record<string, string> = {
  // East
  "212": "America/New_York", "646": "America/New_York", "718": "America/New_York", "917": "America/New_York",
  "305": "America/New_York", "786": "America/New_York", "407": "America/New_York", "813": "America/New_York",
  "404": "America/New_York", "470": "America/New_York", "617": "America/New_York", "202": "America/New_York",
  "215": "America/New_York", "267": "America/New_York", "412": "America/New_York", "703": "America/New_York",
  "704": "America/New_York", "919": "America/New_York", "216": "America/New_York", "614": "America/New_York",
  "313": "America/Detroit", "248": "America/Detroit", "734": "America/Detroit", "616": "America/Detroit",
  "317": "America/Indiana/Indianapolis", "502": "America/New_York", "859": "America/New_York",
  "416": "America/Toronto", "647": "America/Toronto", "514": "America/Toronto",
  // Central
  "312": "America/Chicago", "773": "America/Chicago", "214": "America/Chicago", "469": "America/Chicago",
  "713": "America/Chicago", "281": "America/Chicago", "832": "America/Chicago", "512": "America/Chicago",
  "210": "America/Chicago", "615": "America/Chicago", "901": "America/Chicago", "504": "America/Chicago",
  "314": "America/Chicago", "816": "America/Chicago", "612": "America/Chicago", "414": "America/Chicago",
  "405": "America/Chicago", "918": "America/Chicago", "205": "America/Chicago", "251": "America/Chicago",
  "850": "America/Chicago", // FL panhandle is Central
  "915": "America/Denver", // El Paso
  "423": "America/New_York", "865": "America/New_York", // East Tennessee
  // Mountain
  "303": "America/Denver", "720": "America/Denver", "801": "America/Denver", "505": "America/Denver",
  "406": "America/Denver", "307": "America/Denver", "208": "America/Boise", "602": "America/Phoenix",
  "480": "America/Phoenix", "623": "America/Phoenix", "520": "America/Phoenix", "928": "America/Phoenix",
  // Pacific
  "213": "America/Los_Angeles", "310": "America/Los_Angeles", "323": "America/Los_Angeles",
  "415": "America/Los_Angeles", "408": "America/Los_Angeles", "510": "America/Los_Angeles",
  "619": "America/Los_Angeles", "714": "America/Los_Angeles", "818": "America/Los_Angeles",
  "916": "America/Los_Angeles", "702": "America/Los_Angeles", "725": "America/Los_Angeles",
  "503": "America/Los_Angeles", "971": "America/Los_Angeles", "206": "America/Los_Angeles",
  "253": "America/Los_Angeles", "425": "America/Los_Angeles", "360": "America/Los_Angeles",
  "509": "America/Los_Angeles", "604": "America/Vancouver", "778": "America/Vancouver",
  // Other
  "907": "America/Anchorage", "808": "Pacific/Honolulu", "787": "America/Puerto_Rico", "939": "America/Puerto_Rico",
};

export function timezoneFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const upper = address.toUpperCase();
  // "..., TX 75001" or "..., TX" at the end / before a ZIP.
  const m = /[,\s]([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,?\s*(?:USA|US|CANADA|CA))?\s*$/.exec(upper.trim());
  const zip = /\b(\d{5})(?:-\d{4})?\b/.exec(upper);
  if (zip) {
    const o = ZIP3_OVERRIDES[zip[1].slice(0, 3)];
    if (o) return o;
  }
  if (m && STATE_TZ[m[1]]) return STATE_TZ[m[1]];
  return null;
}

export function timezoneFromPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.length === 10 ? digits : null;
  if (!national) return null;
  return AREA_CODE_TZ[national.slice(0, 3)] ?? null;
}

export function resolveCustomerTimezone(input: {
  explicit?: string | null;
  address?: string | null;
  phone?: string | null;
  businessTimezone: string;
}): ResolvedTimezone {
  if (isValidTimezone(input.explicit)) return { timezone: input.explicit, source: "customer" };
  const fromAddr = timezoneFromAddress(input.address);
  if (fromAddr && isValidTimezone(fromAddr)) return { timezone: fromAddr, source: "address" };
  const fromPhone = timezoneFromPhone(input.phone);
  if (fromPhone && isValidTimezone(fromPhone)) return { timezone: fromPhone, source: "phone" };
  return {
    timezone: isValidTimezone(input.businessTimezone) ? input.businessTimezone : DEFAULT_QUIET_HOURS.timezone,
    source: "business",
  };
}

// --------------------------------------------------------------------------
// The decision
// --------------------------------------------------------------------------

function inQuiet(minute: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** Quiet interval actually enforced for a channel (business window ∪ compliance floor). */
function quietFor(channel: Channel, s: QuietHoursSettings): Array<{ start: number; end: number; floor: boolean }> {
  const out: Array<{ start: number; end: number; floor: boolean }> = [];
  const own = { start: parseHHMM(s.start), end: parseHHMM(s.end) };
  if (s.enabled && s.channels.includes(channel) && Number.isFinite(own.start) && Number.isFinite(own.end)) {
    out.push({ ...own, floor: false });
  }
  if (channel === "sms" || channel === "call") {
    out.push({ start: parseHHMM(COMPLIANCE_FLOOR.start), end: parseHHMM(COMPLIANCE_FLOOR.end), floor: true });
  }
  return out;
}

function localLabel(p: ZonedParts): string {
  return `${p.dateKey} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

interface Block {
  reason: "QUIET_HOURS" | "COMPLIANCE_FLOOR" | "HOLIDAY" | "QUIET_WEEKDAY";
  /** Instant at which this particular block lifts (may be re-blocked after). */
  until: Date;
  detail: string;
}

function blockAt(at: Date, channel: Channel, purpose: Purpose, s: QuietHoursSettings, tz: string): Block | null {
  const p = zonedParts(at, tz);
  const minute = p.hour * 60 + p.minute;
  const startOfNextDay = () => {
    const n = addDaysKey(p.year, p.month, p.day, 1);
    return zonedToUtc(n.y, n.m, n.d, 0, 0, tz);
  };

  // Holidays / weekdays only bind when the business window applies to this channel.
  const ownApplies = s.enabled && s.channels.includes(channel);
  if (ownApplies && purpose !== "emergency") {
    if (isHoliday(p.dateKey, s)) {
      return { reason: "HOLIDAY", until: startOfNextDay(), detail: `Holiday blackout on ${p.dateKey}` };
    }
    if (s.quietWeekdays.includes(p.weekday)) {
      return { reason: "QUIET_WEEKDAY", until: startOfNextDay(), detail: "Quiet weekday" };
    }
  }

  for (const q of quietFor(channel, s)) {
    if (!inQuiet(minute, q.start, q.end)) continue;
    // Next time local clock hits q.end.
    const endH = Math.floor(q.end / 60);
    const endM = q.end % 60;
    let day = { y: p.year, m: p.month, d: p.day };
    let until = zonedToUtc(day.y, day.m, day.d, endH, endM, tz);
    if (until.getTime() <= at.getTime()) {
      day = addDaysKey(day.y, day.m, day.d, 1);
      until = zonedToUtc(day.y, day.m, day.d, endH, endM, tz);
    }
    return {
      reason: q.floor ? "COMPLIANCE_FLOOR" : "QUIET_HOURS",
      until,
      detail: q.floor ? "Outside 08:00–21:00 recipient local time" : `Quiet hours ${s.start}–${s.end}`,
    };
  }
  return null;
}

export function decideSend(input: DecideInput): Decision {
  const { channel, purpose, settings, tz, now, manualOverride } = input;
  const p = zonedParts(now, tz.timezone);
  const base = { timezone: tz.timezone, tzSource: tz.source, localTime: localLabel(p) };

  const first = blockAt(now, channel, purpose, settings, tz.timezone);
  if (!first) {
    const covered = settings.enabled && settings.channels.includes(channel);
    return {
      allowed: true,
      reason: !settings.enabled ? "DISABLED" : covered ? "OPEN" : "NOT_COVERED",
      ...base,
    };
  }

  // Emergency: may bypass the business window (never silently skips the audit — caller logs it).
  if (purpose === "emergency" && settings.allowEmergencyOverride) {
    return { allowed: true, reason: "EMERGENCY_OVERRIDE", ...base };
  }
  // Owner-confirmed manual override: service messages only, never marketing.
  if (manualOverride?.reason?.trim() && purpose === "service") {
    return { allowed: true, reason: "MANUAL_OVERRIDE", ...base };
  }

  // Walk forward to the first instant with no block (holiday chains, back-to-back quiet days).
  let cursor = first.until;
  let guard = 0;
  while (guard++ < 45) {
    const b = blockAt(cursor, channel, purpose, settings, tz.timezone);
    if (!b) break;
    cursor = b.until;
  }
  return { allowed: false, reason: first.reason, sendAt: cursor.toISOString(), detail: first.detail, ...base };
}

/** Deterministic 0..maxMinutes jitter so a whole queue doesn't fire at 08:00:00. */
export function jitterMs(seed: string, maxMinutes = 20): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % (maxMinutes * 60)) * 1000;
}

// --------------------------------------------------------------------------
// Settings normalisation (DB jsonb -> safe settings)
// --------------------------------------------------------------------------

export function normalizeSettings(raw: unknown, businessTimezone?: string | null): QuietHoursSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_QUIET_HOURS;
  const tz = isValidTimezone(businessTimezone) ? businessTimezone : isValidTimezone(r.timezone as string) ? (r.timezone as string) : d.timezone;
  const time = (v: unknown, fb: string) => (typeof v === "string" && Number.isFinite(parseHHMM(v)) ? v : fb);
  const channels = Array.isArray(r.channels) ? (r.channels.filter((c) => c === "sms" || c === "email" || c === "call") as Channel[]) : d.channels;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    timezone: tz,
    start: time(r.start, d.start),
    end: time(r.end, d.end),
    channels,
    quietWeekdays: Array.isArray(r.quietWeekdays) ? r.quietWeekdays.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 6) : d.quietWeekdays,
    useFederalHolidays: typeof r.useFederalHolidays === "boolean" ? r.useFederalHolidays : d.useFederalHolidays,
    blackoutDates: Array.isArray(r.blackoutDates) ? r.blackoutDates.filter((s): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)) : d.blackoutDates,
    allowEmergencyOverride: typeof r.allowEmergencyOverride === "boolean" ? r.allowEmergencyOverride : d.allowEmergencyOverride,
  };
}
