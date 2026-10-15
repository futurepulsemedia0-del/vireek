// Pure types + helpers for the Slack / Microsoft Teams notification settings UI.
// Data access lives in chatNotificationsApi.ts (kept separate so this file is trivially unit-testable).

export type ChatProvider = 'slack' | 'teams';

export const CHAT_EVENT_TYPES = [
  'emergency_call',
  'missed_call',
  'new_job',
  'job_completed',
  'low_csat',
  'payment_failed',
] as const;
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

export interface ChatEventDef {
  id: ChatEventType;
  label: string;
  description: string;
  /** Buttons the message can carry (mirrors the server-side catalogue). */
  buttons: ('acknowledge' | 'assign')[];
}

export const CHAT_EVENTS: ChatEventDef[] = [
  { id: 'emergency_call', label: 'Emergency call', description: 'Sarah flags a call as an emergency.', buttons: ['acknowledge', 'assign'] },
  { id: 'missed_call', label: 'Missed call', description: 'A call was not answered.', buttons: ['acknowledge', 'assign'] },
  { id: 'new_job', label: 'New job', description: 'A job is booked.', buttons: ['assign'] },
  { id: 'job_completed', label: 'Job completed', description: 'A job is marked completed.', buttons: [] },
  { id: 'low_csat', label: 'Low CSAT', description: 'A customer leaves a low rating.', buttons: ['acknowledge'] },
  { id: 'payment_failed', label: 'Payment failed', description: 'A customer payment or your subscription payment fails.', buttons: ['acknowledge'] },
];

export const CHAT_PROVIDERS: { id: ChatProvider; name: string; description: string }[] = [
  { id: 'slack', name: 'Slack', description: 'Post alerts to Slack channels with Acknowledge and Assign buttons.' },
  { id: 'teams', name: 'Microsoft Teams', description: 'Send actionable cards to Teams channels via the Vireek app.' },
];

export interface ChatConnection {
  id: string;
  provider: ChatProvider;
  external_id: string;
  external_name: string | null;
  status: 'connected' | 'error' | 'disconnected';
  last_error: string | null;
}

export interface ChatRoute {
  id: string;
  connection_id: string;
  event_type: ChatEventType;
  channel_id: string;
  channel_name: string | null;
  enabled: boolean;
  actions_enabled: boolean;
  include_contact_details: boolean;
  csat_threshold: number;
}

export interface ChatChannel {
  id: string;
  name: string;
  isPrivate?: boolean;
  group?: string | null;
}

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface ChatDelivery {
  id: string;
  provider: ChatProvider;
  channel_name: string | null;
  status: DeliveryStatus;
  attempts: number;
  error: string | null;
  created_at: string;
  event: { event_type: ChatEventType } | null;
}

export type Tone = 'success' | 'danger' | 'warning' | 'neutral';

export function eventLabel(type: string): string {
  return CHAT_EVENTS.find((e) => e.id === type)?.label ?? type;
}

export function routeFor(routes: ChatRoute[], connectionId: string, eventType: ChatEventType): ChatRoute | undefined {
  return routes.find((r) => r.connection_id === connectionId && r.event_type === eventType);
}

export function summarizeRouting(routes: ChatRoute[], connectionId: string): { active: number; total: number } {
  const mine = routes.filter((r) => r.connection_id === connectionId);
  return { active: mine.filter((r) => r.enabled && r.channel_id).length, total: CHAT_EVENT_TYPES.length };
}

export function connectionHealth(c: ChatConnection | undefined): { label: string; tone: Tone } {
  if (!c || c.status === 'disconnected') return { label: 'Not connected', tone: 'neutral' };
  if (c.status === 'error') return { label: 'Needs reconnect', tone: 'danger' };
  return { label: 'Connected', tone: 'success' };
}

export function deliveryTone(status: DeliveryStatus): Tone {
  switch (status) {
    case 'sent': return 'success';
    case 'failed': return 'danger';
    case 'pending': return 'warning';
    default: return 'neutral';
  }
}

const OAUTH_REASONS: Record<string, string> = {
  access_denied: 'You cancelled the authorization.',
  invalid_state: 'The sign-in link expired. Please try again.',
  workspace_in_use: 'That workspace is already connected to another Vireek account.',
  enterprise_unsupported: 'Slack Enterprise Grid org-wide installs are not supported yet — install to a single workspace.',
  server_not_configured: 'This feature is not fully configured on the server yet.',
  exchange_failed: 'We could not finish the connection. Please try again.',
  missing_code_or_state: 'The authorization response was incomplete. Please try again.',
};

export function oauthReasonMessage(reason: string | null): string {
  return (reason && OAUTH_REASONS[reason]) || 'Could not complete the connection. Please try again.';
}

/** Teams cards can only be posted where the Vireek app is installed, so channels may legitimately be empty. */
export function needsTeamsInstall(c: ChatConnection | undefined, channelCount: number): boolean {
  return !!c && c.provider === 'teams' && c.status === 'connected' && channelCount === 0;
}
