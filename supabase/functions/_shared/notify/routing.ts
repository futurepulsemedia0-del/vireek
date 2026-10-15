// Pure notification-routing logic: no I/O, no Deno APIs — unit-tested with
// vitest (routing.test.ts) and used by supabase/functions/notification-router.
//
// Keep the exported unions in sync with src/lib/notificationRouting.ts.

export type Severity = "info" | "warning" | "high" | "critical";
export type Channel = "push" | "sms" | "email" | "slack";
export type TargetType = "owner" | "role" | "on_call" | "member";

export const SEVERITY_ORDER: readonly Severity[] = ["info", "warning", "high", "critical"];

export interface RoutingRule {
  id: string;
  name: string;
  is_active: boolean;
  priority: number;
  notification_types: string[];
  min_severity: Severity;
  target_type: TargetType;
  target_role: string | null;
  target_member_id: string | null;
  schedule_id: string | null;
  channels: Channel[];
  active_days: number[]; // 0 = Sunday … 6 = Saturday, in the rule's timezone
  window_start: string | null; // "HH:MM" or "HH:MM:SS"
  window_end: string | null;
  timezone: string;
  escalate_if_unacked: boolean;
  cooldown_minutes: number;
}

export interface NotificationInput {
  type: string;
  severity: Severity;
}

export interface Recipient {
  key: string; // 'owner' | 'member:<id>'
  label: string;
  phone: string | null;
  email: string | null;
}

export interface MemberRecipient extends Recipient {
  memberId: string;
  role: string;
}

export interface Directory {
  owner: Recipient;
  members: MemberRecipient[]; // active members only
  onCallByScheduleId: Record<string, string | null>; // schedule -> team_member id
}

export type SkipReason = "no_phone" | "no_email" | "slack_not_configured" | "no_recipient";

export interface PlannedDelivery {
  ruleId: string;
  channel: Channel;
  recipient: Recipient | null; // null for the shared Slack channel
  recipientKey: string; // 'channel' for Slack
  skipReason: SkipReason | null;
}

export interface PlannedEscalation {
  ruleId: string;
  scheduleId: string;
}

export interface RoutingPlan {
  matchedRuleIds: string[];
  deliveries: PlannedDelivery[];
  escalations: PlannedEscalation[];
  unmatched: boolean;
}

// ---------- severity ----------

export function isSeverity(v: unknown): v is Severity {
  return typeof v === "string" && (SEVERITY_ORDER as readonly string[]).includes(v);
}

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

// Existing notification producers do not set `severity`; infer it from `type`.
const TYPE_SEVERITY: Record<string, Severity> = {
  emergency_call: "critical",
  missed_call: "high",
  warranty_alert: "warning",
  usage_alert: "warning",
  payment_failed: "high",
  new_lead: "info",
  job_update: "info",
  quote_viewed: "info",
  ai_insight: "info",
  system: "info",
};

export function inferSeverity(type: string, explicit?: string | null): Severity {
  if (isSeverity(explicit)) return explicit;
  const t = type.toLowerCase();
  if (TYPE_SEVERITY[t]) return TYPE_SEVERITY[t];
  if (t.includes("emergency") || t.includes("critical")) return "critical";
  if (t.includes("failed") || t.includes("missed") || t.includes("overdue")) return "high";
  if (t.includes("alert") || t.includes("warning")) return "warning";
  return "info";
}

// ---------- schedule window ----------

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function parseTimeToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Local weekday (0=Sun) and minutes-since-midnight in `timeZone`; null if the zone is invalid. */
export function localParts(now: Date, timeZone: string): { day: number; minutes: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    const day = WEEKDAYS[get("weekday")];
    const minutes = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
    if (day === undefined || Number.isNaN(minutes)) return null;
    return { day, minutes };
  } catch {
    return null;
  }
}

/**
 * Is `now` inside the rule's day/time window?
 * - No window (both null)      -> every minute of the allowed days.
 * - start == end               -> whole day.
 * - start > end (overnight)    -> the after-midnight part belongs to the day the window STARTED.
 * - Invalid timezone / time    -> fails OPEN (matches): an alert must never be dropped by bad config.
 */
export function isWithinWindow(
  rule: Pick<RoutingRule, "active_days" | "window_start" | "window_end" | "timezone">,
  now: Date,
): boolean {
  const local = localParts(now, rule.timezone);
  if (!local) return true;

  const start = rule.window_start ? parseTimeToMinutes(rule.window_start) : null;
  const end = rule.window_end ? parseTimeToMinutes(rule.window_end) : null;
  const days = rule.active_days.length > 0 ? rule.active_days : [0, 1, 2, 3, 4, 5, 6];

  if (start === null || end === null || start === end) return days.includes(local.day);

  if (start < end) {
    return days.includes(local.day) && local.minutes >= start && local.minutes < end;
  }
  // overnight window
  if (local.minutes >= start) return days.includes(local.day);
  if (local.minutes < end) return days.includes((local.day + 6) % 7);
  return false;
}

// ---------- matching ----------

export function ruleMatches(rule: RoutingRule, n: NotificationInput, now: Date): boolean {
  if (!rule.is_active) return false;
  if (rule.notification_types.length > 0 && !rule.notification_types.includes(n.type)) return false;
  if (severityRank(n.severity) < severityRank(rule.min_severity)) return false;
  return isWithinWindow(rule, now);
}

export function resolveRecipients(rule: RoutingRule, dir: Directory): Recipient[] {
  switch (rule.target_type) {
    case "owner":
      return [dir.owner];
    case "role":
      return dir.members.filter((m) => m.role === rule.target_role);
    case "member":
      return dir.members.filter((m) => m.memberId === rule.target_member_id);
    case "on_call": {
      const id = rule.schedule_id ? dir.onCallByScheduleId[rule.schedule_id] : null;
      return id ? dir.members.filter((m) => m.memberId === id) : [];
    }
    default:
      return [];
  }
}

export function sortRules(rules: RoutingRule[]): RoutingRule[] {
  return [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

/**
 * Turns matching rules into a de-duplicated delivery plan.
 * One (channel, recipient) pair is delivered at most once per notification — the
 * lowest `priority` number wins. Missing contact data becomes an explicit "skipped"
 * row so the owner can see WHY someone was not reached.
 */
export function planRouting(
  rules: RoutingRule[],
  n: NotificationInput,
  dir: Directory,
  now: Date,
  opts: { slackConfigured: boolean },
): RoutingPlan {
  const matched = sortRules(rules).filter((r) => ruleMatches(r, n, now));
  const seen = new Set<string>();
  const deliveries: PlannedDelivery[] = [];
  const escalations: PlannedEscalation[] = [];
  const escalatedSchedules = new Set<string>();

  for (const rule of matched) {
    if (rule.escalate_if_unacked && rule.schedule_id && !escalatedSchedules.has(rule.schedule_id)) {
      escalatedSchedules.add(rule.schedule_id);
      escalations.push({ ruleId: rule.id, scheduleId: rule.schedule_id });
    }

    const recipients = resolveRecipients(rule, dir);
    for (const channel of rule.channels) {
      if (channel === "slack") {
        const key = "slack|channel";
        if (seen.has(key)) continue;
        seen.add(key);
        deliveries.push({
          ruleId: rule.id,
          channel,
          recipient: null,
          recipientKey: "channel",
          skipReason: opts.slackConfigured ? null : "slack_not_configured",
        });
        continue;
      }

      if (recipients.length === 0) {
        const key = `${channel}|none|${rule.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deliveries.push({ ruleId: rule.id, channel, recipient: null, recipientKey: `none:${rule.id}`, skipReason: "no_recipient" });
        continue;
      }

      for (const r of recipients) {
        const key = `${channel}|${r.key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let skipReason: SkipReason | null = null;
        if (channel === "sms" && !r.phone) skipReason = "no_phone";
        if (channel === "email" && !r.email) skipReason = "no_email";
        deliveries.push({ ruleId: rule.id, channel, recipient: r, recipientKey: r.key, skipReason });
      }
    }
  }

  return {
    matchedRuleIds: matched.map((r) => r.id),
    deliveries,
    escalations,
    unmatched: matched.length === 0,
  };
}

// ---------- cooldown ----------

/** true = the rule is still cooling down and must not fire again. */
export function isCoolingDown(cooldownMinutes: number, lastDeliveryAt: string | null, now: Date): boolean {
  if (cooldownMinutes <= 0 || !lastDeliveryAt) return false;
  const last = new Date(lastDeliveryAt).getTime();
  if (Number.isNaN(last)) return false;
  return now.getTime() - last < cooldownMinutes * 60_000;
}

// ---------- message formatting ----------

export interface MessageInput {
  title: string;
  message: string;
  severity: Severity;
  openUrl: string;
  ackUrl: string | null;
}

export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Slack mrkdwn only needs &, <, > escaped. */
export function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SEVERITY_LABEL: Record<Severity, string> = { info: "INFO", warning: "WARNING", high: "HIGH", critical: "CRITICAL" };

export function buildSms(m: MessageInput): string {
  const head = `Vireek ${SEVERITY_LABEL[m.severity]}: ${truncate(m.title, 70)} — `;
  const tail = m.ackUrl ? ` Acknowledge: ${m.ackUrl}` : ` ${m.openUrl}`;
  const room = Math.max(20, 300 - head.length - tail.length);
  return `${head}${truncate(m.message, room)}${tail}`;
}

export function buildEmail(m: MessageInput): { subject: string; html: string; text: string } {
  const subject = `[${SEVERITY_LABEL[m.severity]}] ${truncate(m.title, 120)}`;
  const link = m.ackUrl ?? m.openUrl;
  const linkLabel = m.ackUrl ? "Acknowledge" : "Open in Vireek";
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:560px">` +
    `<p style="margin:0 0 4px;font-size:12px;letter-spacing:.06em;color:#64748b">${SEVERITY_LABEL[m.severity]} ALERT</p>` +
    `<h2 style="margin:0 0 12px">${escapeHtml(m.title)}</h2>` +
    `<p style="margin:0 0 20px;line-height:1.5">${escapeHtml(m.message)}</p>` +
    `<a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none">${linkLabel}</a>` +
    `</div>`;
  const text = `${m.title}\n\n${m.message}\n\n${linkLabel}: ${link}`;
  return { subject, html, text };
}

export function buildSlackPayload(m: MessageInput): { text: string } {
  const icon = m.severity === "critical" ? ":rotating_light:" : m.severity === "high" ? ":warning:" : ":bell:";
  const link = m.ackUrl ? `<${m.ackUrl}|Acknowledge>` : `<${m.openUrl}|Open in Vireek>`;
  return { text: `${icon} *${SEVERITY_LABEL[m.severity]}* — *${escapeSlack(m.title)}*\n${escapeSlack(truncate(m.message, 500))}\n${link}` };
}

// ---------- rule validation (server + tests; mirrored in src/lib/notificationRouting.ts) ----------

export function validateRule(r: Partial<RoutingRule>): string[] {
  const errors: string[] = [];
  if (!r.name || r.name.trim().length < 1 || r.name.trim().length > 80) errors.push("name");
  if (!r.channels || r.channels.length === 0) errors.push("channels");
  if (r.target_type === "role" && !r.target_role) errors.push("target_role");
  if (r.target_type === "member" && !r.target_member_id) errors.push("target_member_id");
  if (r.target_type === "on_call" && !r.schedule_id) errors.push("schedule_id");
  if (r.escalate_if_unacked && !r.schedule_id) errors.push("escalation_schedule");
  if ((r.window_start == null) !== (r.window_end == null)) errors.push("window");
  if (r.window_start && parseTimeToMinutes(r.window_start) === null) errors.push("window_start");
  if (r.window_end && parseTimeToMinutes(r.window_end) === null) errors.push("window_end");
  if (r.active_days && (r.active_days.length === 0 || r.active_days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) errors.push("active_days");
  if (r.timezone && localParts(new Date(), r.timezone) === null) errors.push("timezone");
  return errors;
}
