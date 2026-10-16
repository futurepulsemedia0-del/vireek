// Types + pure helpers for /dashboard/settings/slack-teams. Shapes mirror the
// camelCase DTOs returned by supabase/functions/chat-integrations.

export type ChatProvider = 'slack' | 'teams';
export type AlertEventType = 'emergency' | 'new_job' | 'missed_call' | 'low_csat';

export const CHAT_PROVIDERS: readonly ChatProvider[] = ['slack', 'teams'];
export const ALERT_EVENT_TYPES: readonly AlertEventType[] = ['emergency', 'new_job', 'missed_call', 'low_csat'];
export const CSAT_DEFAULT_THRESHOLD = 3;

export interface ChatConnection {
  id: string;
  provider: ChatProvider;
  status: 'connected' | 'error';
  workspaceName: string | null;
  connectedByName: string | null;
  lastError: string | null;
  connectedAt: string;
}

export interface ChatRule {
  provider: ChatProvider;
  eventType: AlertEventType;
  enabled: boolean;
  channelId: string | null;
  channelName: string | null;
  containerId: string | null;
  containerName: string | null;
  threshold: number | null;
}

export interface ChatChannel {
  id: string;
  name: string;
  containerId: string | null;
  containerName: string | null;
  isPrivate: boolean;
}

export interface ChatDelivery {
  id: string;
  provider: ChatProvider;
  eventType: string;
  status: 'sent' | 'failed';
  channelName: string | null;
  error: string | null;
  createdAt: string;
}

export interface ChatListResponse {
  configured: Record<ChatProvider, boolean>;
  connections: ChatConnection[];
  rules: ChatRule[];
  deliveries: ChatDelivery[];
  error?: string;
}

export const PROVIDER_META: Record<ChatProvider, { label: string; workspaceNoun: string; channelPrefix: string; blurb: string }> = {
  slack: {
    label: 'Slack',
    workspaceNoun: 'workspace',
    channelPrefix: '#',
    blurb: 'Post alerts to the Slack channels your crew already watches.',
  },
  teams: {
    label: 'Microsoft Teams',
    workspaceNoun: 'organization',
    channelPrefix: '',
    blurb: 'Post alerts to Teams channels. Messages appear as the person who connected.',
  },
};

export const EVENT_META: Record<AlertEventType, { label: string; description: string }> = {
  emergency: { label: 'Emergencies', description: 'The moment a caller is flagged as an emergency.' },
  new_job: { label: 'New jobs', description: 'Every time a job is booked or created.' },
  missed_call: { label: 'Missed calls', description: 'When a call ends up missed.' },
  low_csat: { label: 'Low CSAT', description: 'When a call rating is at or below your threshold.' },
};

export const CSAT_THRESHOLD_OPTIONS = [1, 2, 3, 4] as const;

export const OAUTH_REASON_MESSAGES: Record<string, string> = {
  denied: 'The connection was cancelled before it finished.',
  invalid_state: 'That sign-in link expired. Please try connecting again.',
  missing_code: 'The provider did not return an authorization code. Please try again.',
  not_configured: 'This provider is not configured on the server yet.',
  exchange_failed: 'We could not finish connecting. Please try again.',
};

/** Reads ?slack=connected | ?teams=error&reason=… after the OAuth redirect. */
export function oauthResultFromParams(params: URLSearchParams): { provider: ChatProvider; ok: boolean; reason: string | null } | null {
  for (const provider of CHAT_PROVIDERS) {
    const value = params.get(provider);
    if (value === 'connected') return { provider, ok: true, reason: null };
    if (value === 'error') return { provider, ok: false, reason: params.get('reason') };
  }
  return null;
}

// ------------------------------------------------------------ rule drafts

export interface RuleDraft {
  eventType: AlertEventType;
  enabled: boolean;
  /** Select value, see channelKey(). Empty string = nothing chosen. */
  channelKey: string;
  channelName: string;
  containerName: string;
  threshold: number;
}

/** Slack channels are keyed by id; Teams channels by `teamId::channelId`. */
export function channelKey(channel: { id: string; containerId: string | null }): string {
  return channel.containerId ? `${channel.containerId}::${channel.id}` : channel.id;
}

export function splitChannelKey(key: string): { channelId: string; containerId: string | null } {
  const at = key.indexOf('::');
  return at === -1 ? { channelId: key, containerId: null } : { containerId: key.slice(0, at), channelId: key.slice(at + 2) };
}

/** Always returns the four alert types in a stable order, filling gaps with safe defaults. */
export function rulesToDrafts(provider: ChatProvider, rules: ChatRule[]): RuleDraft[] {
  return ALERT_EVENT_TYPES.map((eventType) => {
    const rule = rules.find((r) => r.provider === provider && r.eventType === eventType);
    return {
      eventType,
      enabled: rule?.enabled ?? false,
      channelKey: rule?.channelId ? channelKey({ id: rule.channelId, containerId: rule.containerId }) : '',
      channelName: rule?.channelName ?? '',
      containerName: rule?.containerName ?? '',
      threshold: rule?.threshold ?? CSAT_DEFAULT_THRESHOLD,
    };
  });
}

export function validateDrafts(drafts: RuleDraft[]): Partial<Record<AlertEventType, string>> {
  const errors: Partial<Record<AlertEventType, string>> = {};
  for (const d of drafts) {
    if (d.enabled && !d.channelKey) errors[d.eventType] = 'Pick a channel to turn this alert on.';
  }
  return errors;
}

export function draftsDirty(a: RuleDraft[], b: RuleDraft[]): boolean {
  return a.some((d, i) => {
    const o = b[i];
    return !o || d.enabled !== o.enabled || d.channelKey !== o.channelKey || (d.eventType === 'low_csat' && d.threshold !== o.threshold);
  });
}

/** Body for the save_rules action. */
export function draftsToPayload(drafts: RuleDraft[]) {
  return drafts.map((d) => {
    const { channelId, containerId } = d.channelKey ? splitChannelKey(d.channelKey) : { channelId: null, containerId: null };
    return {
      eventType: d.eventType,
      enabled: d.enabled,
      channelId,
      channelName: channelId ? d.channelName || null : null,
      containerId,
      containerName: containerId ? d.containerName || null : null,
      threshold: d.eventType === 'low_csat' ? d.threshold : null,
    };
  });
}

export function channelLabel(provider: ChatProvider, channel: Pick<ChatChannel, 'name' | 'isPrivate'>): string {
  return `${PROVIDER_META[provider].channelPrefix}${channel.name}${channel.isPrivate ? ' (private)' : ''}`;
}

export function eventLabel(eventType: string): string {
  return EVENT_META[eventType as AlertEventType]?.label ?? eventType.replace(/_/g, ' ');
}

export function timeAgo(iso: string, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (Number.isNaN(seconds)) return '';
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
