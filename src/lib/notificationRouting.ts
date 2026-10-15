// Notification routing — pure client-side types, labels, validation and rule
// descriptions. No network here (see notificationRoutingApi.ts) so it is trivially
// unit-testable. Keep unions in sync with
// supabase/functions/_shared/notify/routing.ts.

export type Severity = 'info' | 'warning' | 'high' | 'critical';
export type Channel = 'push' | 'sms' | 'email' | 'slack';
export type TargetType = 'owner' | 'role' | 'on_call' | 'member';
export type TargetRole = 'admin' | 'technician' | 'member';

export interface RoutingRule {
  id: string;
  user_id: string;
  name: string;
  is_active: boolean;
  priority: number;
  notification_types: string[];
  min_severity: Severity;
  target_type: TargetType;
  target_role: TargetRole | null;
  target_member_id: string | null;
  schedule_id: string | null;
  channels: Channel[];
  active_days: number[];
  window_start: string | null;
  window_end: string | null;
  timezone: string;
  escalate_if_unacked: boolean;
  cooldown_minutes: number;
  created_at: string;
  updated_at: string;
}

export interface RuleDraft {
  id?: string;
  name: string;
  is_active: boolean;
  priority: number;
  notification_types: string[];
  min_severity: Severity;
  target_type: TargetType;
  target_role: TargetRole | '';
  target_member_id: string;
  schedule_id: string;
  channels: Channel[];
  active_days: number[];
  window_enabled: boolean;
  window_start: string; // "HH:MM"
  window_end: string;
  timezone: string;
  escalate_if_unacked: boolean;
  cooldown_minutes: number;
}

export interface DeliveryRow {
  id: string;
  notification_id: string;
  rule_id: string | null;
  notification_type: string;
  severity: Severity;
  channel: Channel;
  recipient_label: string | null;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  error: string | null;
  created_at: string;
}

export interface RoutingSettings {
  slack_configured: boolean;
  slack_hint: string | null;
  fallback_to_push: boolean;
}

export interface PreviewResult {
  dry_run: true;
  type: string;
  severity: Severity;
  at: string;
  matched_rules: { id: string; name: string }[];
  fallback_to_push: boolean;
  escalations: { rule: string; schedule_id: string }[];
  deliveries: { rule: string; channel: Channel; recipient: string; skip_reason: string | null }[];
}

export const SEVERITIES: readonly Severity[] = ['info', 'warning', 'high', 'critical'];
export const CHANNELS: readonly Channel[] = ['push', 'sms', 'email', 'slack'];

export const SEVERITY_LABELS: Record<Severity, string> = {
  info: 'Info',
  warning: 'Warning',
  high: 'High',
  critical: 'Critical',
};

export const SEVERITY_DESCRIPTIONS: Record<Severity, string> = {
  info: 'Everything',
  warning: 'Warnings and above',
  high: 'High and critical only',
  critical: 'Critical only',
};

export const SEVERITY_COLORS: Record<Severity, string> = {
  info: 'bg-bg-tertiary text-text-secondary',
  warning: 'bg-warning-500/10 text-warning-500',
  high: 'bg-error-500/10 text-error-500',
  critical: 'bg-danger/10 text-danger',
};

export const CHANNEL_LABELS: Record<Channel, string> = {
  push: 'Push',
  sms: 'SMS',
  email: 'Email',
  slack: 'Slack',
};

export const TARGET_LABELS: Record<TargetType, string> = {
  owner: 'Account owner',
  role: 'Everyone with a role',
  on_call: 'Whoever is on call',
  member: 'A specific person',
};

export const ROLE_LABELS: Record<TargetRole, string> = {
  admin: 'Admins',
  technician: 'Technicians',
  member: 'Team members',
};

export const DELIVERY_STATUS_COLORS: Record<DeliveryRow['status'], string> = {
  pending: 'bg-bg-tertiary text-text-secondary',
  sent: 'bg-success-500/10 text-success-500',
  failed: 'bg-error-500/10 text-error-500',
  skipped: 'bg-warning-500/10 text-warning-500',
};

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

// Types the app already emits (see NotificationsContext). Empty selection = every type.
export const NOTIFICATION_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'emergency_call', label: 'Emergency call' },
  { value: 'missed_call', label: 'Missed call' },
  { value: 'new_lead', label: 'New lead' },
  { value: 'usage_alert', label: 'Usage alert' },
  { value: 'warranty_alert', label: 'Warranty alert' },
  { value: 'job_update', label: 'Job update' },
  { value: 'quote_viewed', label: 'Quote viewed' },
  { value: 'ai_insight', label: 'AI insight' },
  { value: 'system', label: 'System' },
];

const SKIP_REASON_LABELS: Record<string, string> = {
  no_phone: 'No phone number on file',
  no_email: 'No email on file',
  slack_not_configured: 'Slack is not connected',
  no_recipient: 'No one to notify (empty rotation or missing person)',
  no_push_device: 'No device has enabled push',
};

export function skipReasonLabel(reason: string | null | undefined): string {
  if (!reason) return '';
  return SKIP_REASON_LABELS[reason] ?? reason;
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  } catch {
    return 'America/New_York';
  }
}

export function emptyDraft(over: Partial<RuleDraft> = {}): RuleDraft {
  return {
    name: '',
    is_active: true,
    priority: 100,
    notification_types: [],
    min_severity: 'high',
    target_type: 'owner',
    target_role: '',
    target_member_id: '',
    schedule_id: '',
    channels: ['push'],
    active_days: [...ALL_DAYS],
    window_enabled: false,
    window_start: '18:00',
    window_end: '08:00',
    timezone: browserTimezone(),
    escalate_if_unacked: false,
    cooldown_minutes: 0,
    ...over,
  };
}

export function ruleToDraft(r: RoutingRule): RuleDraft {
  return {
    id: r.id,
    name: r.name,
    is_active: r.is_active,
    priority: r.priority,
    notification_types: r.notification_types,
    min_severity: r.min_severity,
    target_type: r.target_type,
    target_role: r.target_role ?? '',
    target_member_id: r.target_member_id ?? '',
    schedule_id: r.schedule_id ?? '',
    channels: r.channels,
    active_days: r.active_days,
    window_enabled: r.window_start !== null && r.window_end !== null,
    window_start: (r.window_start ?? '18:00').slice(0, 5),
    window_end: (r.window_end ?? '08:00').slice(0, 5),
    timezone: r.timezone,
    escalate_if_unacked: r.escalate_if_unacked,
    cooldown_minutes: r.cooldown_minutes,
  };
}

/** Row payload for insert/update. Fields not applicable to the chosen target are nulled. */
export function draftToRow(d: RuleDraft) {
  const needsSchedule = d.target_type === 'on_call' || d.escalate_if_unacked;
  return {
    name: d.name.trim(),
    is_active: d.is_active,
    priority: Math.round(d.priority),
    notification_types: d.notification_types,
    min_severity: d.min_severity,
    target_type: d.target_type,
    target_role: d.target_type === 'role' ? d.target_role || null : null,
    target_member_id: d.target_type === 'member' ? d.target_member_id || null : null,
    schedule_id: needsSchedule ? d.schedule_id || null : null,
    channels: d.channels,
    active_days: [...d.active_days].sort((a, b) => a - b),
    window_start: d.window_enabled ? d.window_start : null,
    window_end: d.window_enabled ? d.window_end : null,
    timezone: d.timezone.trim(),
    escalate_if_unacked: d.escalate_if_unacked,
    cooldown_minutes: Math.round(d.cooldown_minutes),
  };
}

export type RuleRow = ReturnType<typeof draftToRow>;

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz.trim().length > 0;
  } catch {
    return false;
  }
}

export type DraftErrors = Partial<Record<'name' | 'channels' | 'target' | 'schedule' | 'days' | 'window' | 'timezone' | 'cooldown' | 'priority', string>>;

export function validateDraft(d: RuleDraft): DraftErrors {
  const e: DraftErrors = {};
  const name = d.name.trim();
  if (!name) e.name = 'Give the rule a name.';
  else if (name.length > 80) e.name = 'Keep the name under 80 characters.';

  if (d.channels.length === 0) e.channels = 'Pick at least one channel.';

  if (d.target_type === 'role' && !d.target_role) e.target = 'Choose a role.';
  if (d.target_type === 'member' && !d.target_member_id) e.target = 'Choose a person.';
  if (d.target_type === 'on_call' && !d.schedule_id) e.schedule = 'Choose an on-call schedule.';
  if (d.escalate_if_unacked && !d.schedule_id) e.schedule = 'Escalation needs an on-call schedule with tiers.';

  if (d.active_days.length === 0) e.days = 'Pick at least one day.';
  if (d.window_enabled && (!TIME_RE.test(d.window_start) || !TIME_RE.test(d.window_end))) e.window = 'Enter valid start and end times.';
  if (!isValidTimezone(d.timezone)) e.timezone = 'Use an IANA timezone such as America/New_York.';

  if (!Number.isFinite(d.cooldown_minutes) || d.cooldown_minutes < 0 || d.cooldown_minutes > 1440) e.cooldown = 'Between 0 and 1440 minutes.';
  if (!Number.isFinite(d.priority) || d.priority < 0 || d.priority > 10000) e.priority = 'Between 0 and 10000.';
  return e;
}

export function hasErrors(e: DraftErrors): boolean {
  return Object.keys(e).length > 0;
}

export function formatDays(days: number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  if (set.length === 7) return 'every day';
  if (set.join() === '1,2,3,4,5') return 'weekdays';
  if (set.join() === '0,6') return 'weekends';
  return set.map((d) => DAY_LABELS[d]).join(', ');
}

export function formatWindow(start: string | null, end: string | null): string {
  if (!start || !end) return 'any time';
  return `${start.slice(0, 5)}–${end.slice(0, 5)}`;
}

export interface DescribeLookup {
  memberName: (id: string) => string | null;
  scheduleName: (id: string) => string | null;
}

/** One human sentence per rule, shown in the list. */
export function describeRule(r: RoutingRule, lookup: DescribeLookup): string {
  const what = r.notification_types.length === 0
    ? 'any alert'
    : r.notification_types.map((t) => NOTIFICATION_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t).join(', ');
  const sev = r.min_severity === 'info' ? '' : ` at ${SEVERITY_LABELS[r.min_severity].toLowerCase()} severity or above`;

  let who: string;
  switch (r.target_type) {
    case 'owner': who = 'the account owner'; break;
    case 'role': who = r.target_role ? ROLE_LABELS[r.target_role].toLowerCase() : 'a role'; break;
    case 'member': who = (r.target_member_id && lookup.memberName(r.target_member_id)) || 'a team member'; break;
    case 'on_call': who = `whoever is on call${r.schedule_id && lookup.scheduleName(r.schedule_id) ? ` (${lookup.scheduleName(r.schedule_id)})` : ''}`; break;
  }

  const via = r.channels.map((c) => CHANNEL_LABELS[c]).join(' + ');
  const when = `${formatDays(r.active_days)}, ${formatWindow(r.window_start, r.window_end)}`;
  const esc = r.escalate_if_unacked ? ' Escalates if nobody acknowledges.' : '';
  return `${what}${sev} → ${who} via ${via}. ${when[0].toUpperCase()}${when.slice(1)}.${esc}`;
}

export interface RuleTemplate {
  id: string;
  title: string;
  blurb: string;
  draft: Partial<RuleDraft>;
}

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: 'critical-owner',
    title: 'Critical alerts → owner, instantly',
    blurb: 'Push + SMS to you for anything critical, any time.',
    draft: { name: 'Critical alerts to owner', min_severity: 'critical', target_type: 'owner', channels: ['push', 'sms'], priority: 10 },
  },
  {
    id: 'after-hours-on-call',
    title: 'After-hours emergencies → on-call, with escalation',
    blurb: 'Nights and weekends go to the on-call tech by SMS and escalate if unacknowledged.',
    draft: {
      name: 'After-hours emergencies',
      notification_types: ['emergency_call'],
      min_severity: 'high',
      target_type: 'on_call',
      channels: ['sms', 'push'],
      window_enabled: true,
      window_start: '18:00',
      window_end: '08:00',
      escalate_if_unacked: true,
      priority: 20,
    },
  },
  {
    id: 'daytime-admins',
    title: 'Daytime high-priority → admins',
    blurb: 'Weekdays 8–6, high-severity alerts reach admins by push and email.',
    draft: {
      name: 'Daytime alerts to admins',
      min_severity: 'high',
      target_type: 'role',
      target_role: 'admin',
      channels: ['push', 'email'],
      active_days: [1, 2, 3, 4, 5],
      window_enabled: true,
      window_start: '08:00',
      window_end: '18:00',
      priority: 50,
    },
  },
];
