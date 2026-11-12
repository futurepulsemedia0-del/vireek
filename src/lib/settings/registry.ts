/**
 * Settings registry: single source of truth for every settings page.
 * Dependency-free on purpose (no '@/' imports) so scripts and tests can load it directly.
 *
 * Permissions below mirror what the hub cards (SettingsPage.tsx) and DashboardNav.tsx
 * enforce today. They are UI-level only; real enforcement stays in RLS / edge functions.
 */

export type PermissionKey =
  | 'can_view_billing'
  | 'can_manage_numbers'
  | 'can_manage_team'
  | 'can_edit_business_profile'
  | 'can_view_all_jobs'
  | 'can_view_audit_log'
  | 'can_manage_security'
  | 'can_issue_refunds'
  | 'can_export_data';

export type SettingsGroupId =
  | 'account'
  | 'business'
  | 'team'
  | 'calls'
  | 'booking'
  | 'communication'
  | 'integrations'
  | 'security'
  | 'data'
  | 'billing';

export type SettingScope = 'user' | 'organization' | 'location' | 'device';
export type RiskLevel = 'low' | 'medium' | 'high';
/** 'owner' = Owners only; 'any' = every signed-in user; otherwise a grantable permission. */
export type RequiredPermission = 'owner' | 'any' | PermissionKey;

export interface SettingsEntry {
  /** Stable id, kebab-case. Used for deep links (#id), audit labels and search. */
  id: string;
  label: string;
  /** Plain language, one sentence, sentence case, no jargon. */
  description: string;
  group: SettingsGroupId;
  keywords: readonly string[];
  /** Canonical route. Must exist in App.tsx. */
  route: string;
  /** Optional in-page anchor (element id). Only set once the element exists. */
  anchor?: string;
  scope: SettingScope;
  permission: RequiredPermission;
  /** Plan gate. Not wired yet: plan data was not located in AuthContext. */
  plan?: string;
  risk: RiskLevel;
  learnMore?: string;
}

export interface SettingsGroup {
  id: SettingsGroupId;
  label: string;
  /** Personal vs organization separation in the hub. */
  section: 'personal' | 'organization';
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: 'account', label: 'My account', section: 'personal' },
  { id: 'business', label: 'Business', section: 'organization' },
  { id: 'team', label: 'Team and access', section: 'organization' },
  { id: 'calls', label: 'Calls and AI', section: 'organization' },
  { id: 'booking', label: 'Booking and scheduling', section: 'organization' },
  { id: 'communication', label: 'Communication', section: 'organization' },
  { id: 'integrations', label: 'Integrations and developers', section: 'organization' },
  { id: 'security', label: 'Security and compliance', section: 'organization' },
  { id: 'data', label: 'Data and privacy', section: 'organization' },
  { id: 'billing', label: 'Billing and payments', section: 'organization' },
];

const e = (x: SettingsEntry): SettingsEntry => x;
const BP: PermissionKey = 'can_edit_business_profile';

export const SETTINGS_REGISTRY: readonly SettingsEntry[] = [
  // My account
  e({ id: 'account', label: 'Profile, language and notifications', description: 'Your name, language, regional formats and how Vireek notifies you.', group: 'account', keywords: ['profile', 'language', 'locale', 'timezone', 'notifications', 'alerts', 'push', 'email alerts', 'quiet hours', 'briefing'], route: '/dashboard/settings/account', scope: 'user', permission: 'any', risk: 'low' }),
  e({ id: 'sessions', label: 'My sessions', description: 'See where you are signed in and sign out other devices.', group: 'account', keywords: ['devices', 'logout', 'sign out', 'signed in'], route: '/dashboard/settings/sessions', scope: 'user', permission: 'any', risk: 'medium' }),
  e({ id: 'assistant', label: 'Assistant persona', description: 'The name and tone Sarah uses with your callers.', group: 'account', keywords: ['sarah', 'persona', 'tone', 'greeting', 'name'], route: '/dashboard/settings/assistant', scope: 'user', permission: 'any', risk: 'low' }),
  e({ id: 'dashboard-builder', label: 'Dashboard layout', description: 'Choose which tiles appear on your dashboard.', group: 'account', keywords: ['widgets', 'tiles', 'home', 'layout'], route: '/dashboard/dashboard-builder', scope: 'user', permission: 'can_manage_team', risk: 'low' }),
  // Business
  e({ id: 'business-profile', label: 'Business profile', description: 'Your business name, contact details, service area and hours.', group: 'business', keywords: ['company', 'address', 'hours', 'phone', 'service area', 'opening hours'], route: '/dashboard/business-profile', scope: 'organization', permission: BP, risk: 'medium' }),
  e({ id: 'branding', label: 'Branding', description: 'Logo and colors shown to customers.', group: 'business', keywords: ['logo', 'colors', 'theme', 'brand'], route: '/dashboard/settings/branding', scope: 'organization', permission: BP, risk: 'low' }),
  e({ id: 'locations', label: 'Locations', description: 'The branches and service areas your business operates from.', group: 'business', keywords: ['branches', 'offices', 'sites', 'dallas'], route: '/dashboard/settings/locations', scope: 'organization', permission: BP, risk: 'medium' }),
  e({ id: 'regional-packs', label: 'Regional and compliance packs', description: 'Rules and wording for the countries and regions you serve.', group: 'business', keywords: ['region', 'country', 'compliance', 'tcpa', 'gdpr', 'tax'], route: '/dashboard/settings/regional-packs', scope: 'organization', permission: BP, risk: 'medium' }),
  e({ id: 'trust-badge', label: 'Trust badge', description: 'The verified badge you can show on your website.', group: 'business', keywords: ['badge', 'verified', 'reviews'], route: '/dashboard/settings/trust-badge', scope: 'organization', permission: BP, risk: 'low' }),
  // Team and access
  e({ id: 'team', label: 'Team members and roles', description: 'Invite people and choose what each role can do.', group: 'team', keywords: ['members', 'invite', 'roles', 'permissions', 'technicians', 'users', 'staff'], route: '/dashboard/team', scope: 'organization', permission: 'can_manage_team', risk: 'high' }),
  // Calls and AI
  e({ id: 'voice', label: 'Voice', description: 'How Sarah sounds on calls.', group: 'calls', keywords: ['speech', 'accent', 'speed'], route: '/dashboard/settings/voice', scope: 'organization', permission: BP, risk: 'low' }),
  e({ id: 'voice-studio', label: 'Voice studio', description: 'Preview voices and create a custom voice.', group: 'calls', keywords: ['clone', 'custom voice', 'record'], route: '/dashboard/settings/voice-studio', scope: 'organization', permission: BP, risk: 'medium' }),
  e({ id: 'call-tracking', label: 'Call tracking numbers', description: 'Numbers that show which ad or page a call came from.', group: 'calls', keywords: ['dynamic numbers', 'tracking', 'phone numbers', 'attribution', 'forwarding'], route: '/dashboard/settings/call-tracking', scope: 'organization', permission: BP, risk: 'high' }),
  // Booking
  e({ id: 'booking', label: 'Booking', description: 'Booking rules, arrival windows and availability.', group: 'booking', keywords: ['arrival window', 'capacity', 'scheduling', 'availability', 'online booking'], route: '/dashboard/booking-settings', scope: 'organization', permission: BP, risk: 'medium' }),
  e({ id: 'job-quality-gate', label: 'Job quality gate', description: 'Checks a job must pass before it can be closed.', group: 'booking', keywords: ['checklist', 'closeout', 'quality'], route: '/dashboard/job-quality-gate', scope: 'organization', permission: BP, risk: 'low' }),
  // Communication
  e({ id: 'email', label: 'Email', description: 'Sender domains, signature and email delivery.', group: 'communication', keywords: ['smtp', 'domain', 'signature', 'dkim', 'sender', 'billing contact'], route: '/dashboard/settings/email', scope: 'organization', permission: BP, risk: 'medium' }),
  e({ id: 'sms-compliance', label: 'SMS compliance', description: 'Registration and opt-out rules for text messages.', group: 'communication', keywords: ['10dlc', 'opt out', 'stop', 'text messages', 'registration'], route: '/dashboard/settings/sms-compliance', scope: 'organization', permission: 'owner', risk: 'high' }),
  e({ id: 'messaging-channels', label: 'Messaging channels', description: 'Which messaging channels customers can reach you on.', group: 'communication', keywords: ['whatsapp', 'sms', 'facebook', 'channels'], route: '/dashboard/settings/messaging-channels', scope: 'organization', permission: BP, risk: 'medium' }),
  e({ id: 'rich-messaging', label: 'Rich messaging', description: 'Templates with buttons and images for customer messages.', group: 'communication', keywords: ['templates', 'buttons', 'rcs'], route: '/dashboard/settings/rich-messaging', scope: 'organization', permission: BP, risk: 'low' }),
  e({ id: 'chat-widget', label: 'Chat widget', description: 'The chat window on your website.', group: 'communication', keywords: ['live chat', 'website chat', 'widget'], route: '/dashboard/settings/chat-widget', scope: 'organization', permission: BP, risk: 'low' }),
  e({ id: 'website-widgets', label: 'Website widgets', description: 'Booking and call buttons to embed on your site.', group: 'communication', keywords: ['embed', 'snippet', 'button'], route: '/dashboard/settings/website-widgets', scope: 'organization', permission: BP, risk: 'low' }),
  e({ id: 'slack-teams', label: 'Slack and Teams', description: 'Send urgent alerts to a Slack or Teams channel.', group: 'communication', keywords: ['slack', 'microsoft teams', 'alerts', 'channel', 'emergency alerts'], route: '/dashboard/settings/slack-teams', scope: 'organization', permission: 'can_manage_team', risk: 'medium' }),
  // Integrations
  e({ id: 'api-keys', label: 'API keys', description: 'Create and revoke keys for your own integrations.', group: 'integrations', keywords: ['token', 'developer', 'secret', 'api'], route: '/dashboard/settings/api-keys', scope: 'organization', permission: 'owner', risk: 'high' }),
  e({ id: 'oauth-apps', label: 'Connected apps', description: 'Apps that can sign in with your Vireek account.', group: 'integrations', keywords: ['oauth', 'authorize', 'third party'], route: '/dashboard/settings/oauth-apps', scope: 'organization', permission: 'owner', risk: 'high' }),
  e({ id: 'api-usage', label: 'API usage', description: 'How many API requests your keys have made.', group: 'integrations', keywords: ['requests', 'limits', 'quota'], route: '/dashboard/settings/api-usage', scope: 'organization', permission: 'any', risk: 'low' }),
  // Security
  e({ id: 'security', label: 'Security', description: 'Password, two-step sign-in and passkeys.', group: 'security', keywords: ['password', 'mfa', '2fa', 'two factor', 'passkey', 'login'], route: '/dashboard/settings/security', scope: 'organization', permission: 'owner', risk: 'high' }),
  e({ id: 'enterprise-security', label: 'Enterprise security', description: 'Single sign-on, IP allowlist and session limits.', group: 'security', keywords: ['sso', 'saml', 'ip allowlist', 'idle timeout', 'session policy'], route: '/dashboard/settings/enterprise-security', scope: 'organization', permission: 'owner', risk: 'high' }),
  e({ id: 'audit-log', label: 'Audit log', description: 'A record of who changed what and when.', group: 'security', keywords: ['history', 'changes', 'activity', 'who changed'], route: '/dashboard/settings/audit-log', scope: 'organization', permission: 'owner', risk: 'low' }),
  e({ id: 'access-history', label: 'Sensitive access history', description: 'Who viewed sensitive customer data, and when.', group: 'security', keywords: ['sensitive access', 'data access', 'who viewed'], route: '/dashboard/settings/access-history', scope: 'organization', permission: 'owner', risk: 'low' }),
  e({ id: 'job-statuses', label: 'Job statuses', description: 'Choose which job statuses your team uses.', group: 'booking', keywords: ['statuses', 'job stages', 'workflow stages'], route: '/dashboard/settings/statuses', scope: 'organization', permission: 'owner', risk: 'low' }),
  e({ id: 'settings-center', label: 'Settings search', description: 'Search every setting you can open.', group: 'account', keywords: ['find setting', 'settings search'], route: '/dashboard/settings/center', scope: 'user', permission: 'any', risk: 'low' }),
  e({ id: 'siem-streaming', label: 'Security log streaming', description: 'Send audit events to your security monitoring tool.', group: 'security', keywords: ['siem', 'splunk', 'datadog', 'stream', 'logs'], route: '/dashboard/settings/siem-streaming', scope: 'organization', permission: 'owner', risk: 'high' }),
  // Data
  e({ id: 'data-governance', label: 'Data governance', description: 'Retention, export and deletion of your data.', group: 'data', keywords: ['retention', 'export', 'delete', 'privacy', 'gdpr', 'erase'], route: '/dashboard/settings/data-governance', scope: 'organization', permission: 'owner', risk: 'high' }),
  // Billing
  e({ id: 'billing', label: 'Billing', description: 'Plan, invoices and payment method.', group: 'billing', keywords: ['invoice', 'payment method', 'subscription', 'plan', 'card', 'billing contact'], route: '/dashboard/billing', scope: 'organization', permission: 'can_view_billing', risk: 'high' }),
  e({ id: 'payment-pricing', label: 'Customer payment options', description: 'Fees, discounts and payment methods offered to your customers.', group: 'billing', keywords: ['surcharge', 'discount', 'cash', 'card fees', 'pricing'], route: '/dashboard/payment-pricing', scope: 'organization', permission: BP, risk: 'medium' }),
];

export const SETTINGS_HUB_ROUTE = '/dashboard/settings';

/** Legacy URL -> canonical URL. Kept so old links never break. */
export const SETTINGS_REDIRECTS: Readonly<Record<string, string>> = {};

export function getEntry(id: string): SettingsEntry | undefined {
  return SETTINGS_REGISTRY.find((x) => x.id === id);
}

export function getEntryByPath(pathname: string): SettingsEntry | undefined {
  const clean = pathname.replace(/\/+$/, '');
  return SETTINGS_REGISTRY.find((x) => x.route === clean);
}

/** Longest-prefix match, so /dashboard/team/org-chart resolves to 'team'. */
export function getEntryForPath(pathname: string): SettingsEntry | undefined {
  const clean = pathname.replace(/\/+$/, '');
  let best: SettingsEntry | undefined;
  for (const x of SETTINGS_REGISTRY) {
    if ((clean === x.route || clean.startsWith(x.route + '/')) && (!best || x.route.length > best.route.length)) best = x;
  }
  return best;
}

/** True for the hub and any registered settings page. Replaces the hand-written
 *  special case in DashboardNav.isActive. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === SETTINGS_HUB_ROUTE || pathname.startsWith(SETTINGS_HUB_ROUTE + '/') || Boolean(getEntryForPath(pathname));
}

export function deepLink(id: string): string | undefined {
  const x = getEntry(id);
  if (!x) return undefined;
  return `${x.route}${x.anchor ? `#${x.anchor}` : ''}`;
}

export function breadcrumbs(pathname: string): { label: string; href?: string }[] {
  const x = getEntryForPath(pathname);
  const crumbs: { label: string; href?: string }[] = [{ label: 'Settings', href: SETTINGS_HUB_ROUTE }];
  if (!x) return crumbs;
  const g = SETTINGS_GROUPS.find((y) => y.id === x.group);
  if (g) crumbs.push({ label: g.label });
  crumbs.push({ label: x.label });
  return crumbs;
}

/** Problems in the registry itself; empty array = valid. Used by tests and CI. */
export function validateRegistry(entries: readonly SettingsEntry[] = SETTINGS_REGISTRY): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  const routeAnchor = new Set<string>();
  const groups = new Set(SETTINGS_GROUPS.map((g) => g.id));
  for (const x of entries) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(x.id)) errs.push(`bad id: ${x.id}`);
    if (ids.has(x.id)) errs.push(`duplicate id: ${x.id}`);
    ids.add(x.id);
    if (!groups.has(x.group)) errs.push(`${x.id}: unknown group ${x.group}`);
    if (!x.route.startsWith('/dashboard/')) errs.push(`${x.id}: route must start with /dashboard/`);
    const key = `${x.route}#${x.anchor ?? ''}`;
    if (routeAnchor.has(key)) errs.push(`${x.id}: duplicate route+anchor ${key}`);
    routeAnchor.add(key);
    if (!x.label.trim() || x.label !== x.label.trim()) errs.push(`${x.id}: bad label`);
    if (!x.description.trim().endsWith('.')) errs.push(`${x.id}: description should be one sentence ending with a period`);
    if (x.description.length > 120) errs.push(`${x.id}: description over 120 chars`);
    if (x.keywords.length === 0) errs.push(`${x.id}: needs keywords`);
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(x.label + x.description)) errs.push(`${x.id}: no emoji in copy`);
  }
  return errs;
}
