/* ------------------------------------------------------------------ */
/*  supportHours — defines when a real human on the Vireek team is    */
/*  actively monitoring chat/email, vs. the AI assistant answering    */
/*  alone. Used by SiteAssistant to show an honest status instead of  */
/*  a permanent "online" dot — the AI is available 24/7, a human is   */
/*  not, and this file is the single place to change that schedule.   */
/* ------------------------------------------------------------------ */

/** IANA time zone the hours below are defined in. Change this if the
 *  team's base time zone changes — everything else derives from it. */
export const SUPPORT_TIME_ZONE = 'America/New_York';

/** 0 = Sunday … 6 = Saturday. Each entry is [startHour, endHour) in
 *  24h local time (SUPPORT_TIME_ZONE). Omit a day to mark it fully
 *  offline (weekends, by default). */
export const SUPPORT_HOURS: Partial<Record<number, [number, number]>> = {
  1: [9, 18], // Monday
  2: [9, 18], // Tuesday
  3: [9, 18], // Wednesday
  4: [9, 18], // Thursday
  5: [9, 18], // Friday
};

/** Human-readable label shown in the widget — keep this in sync with
 *  SUPPORT_HOURS above if you change it. */
export const SUPPORT_HOURS_LABEL = 'Mon–Fri, 9am–6pm ET';

export interface SupportStatus {
  online: boolean;
  label: string;
}

/**
 * Returns whether a human is currently inside the configured support
 * window, computed from the real local time in SUPPORT_TIME_ZONE (not
 * the visitor's own browser time zone) — so a visitor in Tokyo and a
 * visitor in Chicago see the same, correct answer.
 */
export function getSupportStatus(now: Date = new Date()): SupportStatus {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SUPPORT_TIME_ZONE,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);

  const weekdayShort = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayShort);

  const window = SUPPORT_HOURS[dayIndex];
  const online = !!window && hour >= window[0] && hour < window[1];

  return {
    online,
    label: online ? 'Our team is online now' : `Our team is offline — back ${SUPPORT_HOURS_LABEL}`,
  };
}


const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function formatHour(hour: number): string {
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}${hour >= 12 ? 'pm' : 'am'}`;
}

/**
 * When the team is next in its window, e.g. "tomorrow at 9am EST" / "Monday at 9am EST".
 * Returns null while the team is online now. Derived only from SUPPORT_HOURS and
 * SUPPORT_TIME_ZONE (the zone label follows daylight saving), so it can never drift from them.
 */
export function getNextSupportOpening(now: Date = new Date()): string | null {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SUPPORT_TIME_ZONE,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(now);

  const weekdayShort = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const zone = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayShort);
  if (dayIndex < 0) return null;

  const today = SUPPORT_HOURS[dayIndex];
  if (today && hour >= today[0] && hour < today[1]) return null;

  for (let offset = 0; offset <= 7; offset += 1) {
    const index = (dayIndex + offset) % 7;
    const hours = SUPPORT_HOURS[index];
    if (!hours) continue;
    if (offset === 0 && hour >= hours[0]) continue;
    const when = offset === 0 ? 'today' : offset === 1 ? 'tomorrow' : WEEKDAY_NAMES[index];
    return `${when} at ${formatHour(hours[0])} ${zone}`.trim();
  }
  return null;
}
