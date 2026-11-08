/**
 * Settings Center registry — the single list of every settings screen (pure data + pure helpers).
 *
 * A test (settingsRegistry.test.ts) compares it with the routes in App.tsx, so a settings page that is
 * added without being listed here, or listed here without a route, fails CI. Titles live in the
 * `settingsCenter` i18n namespace under `items.<id>`.
 */

export const SETTINGS_GROUPS = ['business', 'communication', 'security', 'developer'] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export interface SettingsEntry {
  id: string;
  href: string;
  group: SettingsGroup;
  /** English search aliases (the translated title is searched too). */
  keywords: readonly string[];
  /** Mirrors the nav: hidden from people without this permission. Each page still enforces its own guard. */
  permission?: 'can_edit_business_profile';
}

const s = (id: string, href: string, group: SettingsGroup, keywords: string[], permission?: SettingsEntry['permission']): SettingsEntry =>
  permission ? { id, href, group, keywords, permission } : { id, href, group, keywords };

export const SETTINGS_REGISTRY: readonly SettingsEntry[] = [
  // Business
  s('branding', '/dashboard/settings/branding', 'business', ['logo', 'colors', 'brand']),
  s('locations', '/dashboard/settings/locations', 'business', ['branch', 'office', 'address']),
  s('regionalPacks', '/dashboard/settings/regional-packs', 'business', ['region', 'country', 'tax', 'language']),
  s('bookingSettings', '/dashboard/booking-settings', 'business', ['booking', 'schedule', 'availability']),
  s('statuses', '/dashboard/settings/statuses', 'business', ['status', 'stage', 'pipeline', 'workflow', 'sla']),
  s('customFields', '/dashboard/custom-fields', 'business', ['field', 'custom', 'attribute'], 'can_edit_business_profile'),
  s('jobQualityGate', '/dashboard/job-quality-gate', 'business', ['quality', 'checklist', 'completion']),
  s('tradePacks', '/dashboard/trade-packs', 'business', ['trade', 'industry', 'template', 'starter'], 'can_edit_business_profile'),
  s('trustBadge', '/dashboard/settings/trust-badge', 'business', ['badge', 'reviews', 'trust']),
  // Communication
  s('assistant', '/dashboard/settings/assistant', 'communication', ['ai', 'receptionist', 'assistant']),
  s('voice', '/dashboard/settings/voice', 'communication', ['voice', 'phone', 'greeting']),
  s('voiceStudio', '/dashboard/settings/voice-studio', 'communication', ['voice', 'studio', 'recording']),
  s('callTracking', '/dashboard/settings/call-tracking', 'communication', ['call', 'tracking', 'numbers']),
  s('email', '/dashboard/settings/email', 'communication', ['email', 'smtp', 'sender']),
  s('smsCompliance', '/dashboard/settings/sms-compliance', 'communication', ['sms', 'text', 'compliance', '10dlc']),
  s('messagingChannels', '/dashboard/settings/messaging-channels', 'communication', ['whatsapp', 'messenger', 'channels']),
  s('richMessaging', '/dashboard/settings/rich-messaging', 'communication', ['rcs', 'rich', 'messaging']),
  s('slackTeams', '/dashboard/settings/slack-teams', 'communication', ['slack', 'teams', 'notifications']),
  s('chatWidget', '/dashboard/settings/chat-widget', 'communication', ['chat', 'widget', 'website']),
  s('websiteWidgets', '/dashboard/settings/website-widgets', 'communication', ['widget', 'website', 'embed']),
  // Security & data
  s('security', '/dashboard/settings/security', 'security', ['password', '2fa', 'mfa']),
  s('sessions', '/dashboard/settings/sessions', 'security', ['session', 'devices', 'sign out']),
  s('enterpriseSecurity', '/dashboard/settings/enterprise-security', 'security', ['sso', 'saml', 'scim', 'enterprise']),
  s('auditLog', '/dashboard/settings/audit-log', 'security', ['audit', 'log', 'history']),
  s('siemStreaming', '/dashboard/settings/siem-streaming', 'security', ['siem', 'stream', 'logs']),
  s('dataGovernance', '/dashboard/settings/data-governance', 'security', ['retention', 'privacy', 'export', 'delete', 'gdpr']),
  // Developer
  s('apiKeys', '/dashboard/settings/api-keys', 'developer', ['api', 'key', 'token']),
  s('apiUsage', '/dashboard/settings/api-usage', 'developer', ['api', 'usage', 'limits']),
  s('oauthApps', '/dashboard/settings/oauth-apps', 'developer', ['oauth', 'app', 'integration']),
];

export interface SettingsViewer {
  isOwner: boolean;
  canEditBusinessProfile: boolean;
}

export function visibleSettings(entries: readonly SettingsEntry[], viewer: SettingsViewer): SettingsEntry[] {
  return entries.filter((e) => !e.permission || viewer.isOwner || viewer.canEditBusinessProfile);
}

const norm = (v: string) => v.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Every query word must appear in the (translated) title or one of the keywords. Empty query = everything. */
export function searchSettings(entries: readonly SettingsEntry[], query: string, titleOf: (id: string) => string): SettingsEntry[] {
  const words = norm(query).split(' ').filter(Boolean);
  if (words.length === 0) return [...entries];
  return entries.filter((e) => {
    const hay = norm([titleOf(e.id), ...e.keywords].join(' '));
    return words.every((w) => hay.includes(w));
  });
}

export function groupSettings(entries: readonly SettingsEntry[]): { group: SettingsGroup; items: SettingsEntry[] }[] {
  return SETTINGS_GROUPS.map((group) => ({ group, items: entries.filter((e) => e.group === group) })).filter((g) => g.items.length > 0);
}
