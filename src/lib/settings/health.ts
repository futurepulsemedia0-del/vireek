import { getEntry, type SettingsEntry } from './registry';

/** Evidence the caller measured. Missing (undefined) means "not measured": never reported as a gap. */
export interface HealthSignals {
  hasBackupEmergencyContact?: boolean;
  mfaOrPasskeyEnabled?: boolean;
  hoursConfigured?: boolean;
  smsComplianceComplete?: boolean;
  notificationChannelsEnabled?: number;
  apiKeys?: { id: string; createdAt: string; lastUsedAt: string | null }[];
  now?: Date;
}

export interface Recommendation {
  id: string;
  settingId: SettingsEntry['id'];
  severity: 'important' | 'suggested';
  title: string;
  why: string;
}

const DAY = 86_400_000;

export function evaluateHealth(s: HealthSignals, dismissed: ReadonlySet<string> = new Set()): Recommendation[] {
  const now = (s.now ?? new Date()).getTime();
  const out: Recommendation[] = [];
  const add = (r: Recommendation) => {
    if (!getEntry(r.settingId)) throw new Error(`health rule points at unknown setting ${r.settingId}`);
    if (!dismissed.has(r.id)) out.push(r);
  };
  if (s.hasBackupEmergencyContact === false)
    add({ id: 'no-backup-contact', settingId: 'business-profile', severity: 'important', title: 'Add a backup emergency contact', why: 'If your main contact does not answer, emergency calls have nowhere else to go.' });
  if (s.mfaOrPasskeyEnabled === false)
    add({ id: 'no-mfa', settingId: 'security', severity: 'important', title: 'Turn on two-step sign-in or a passkey', why: 'A stolen password alone would not be enough to get into your account.' });
  if (s.hoursConfigured === false)
    add({ id: 'no-hours', settingId: 'business-profile', severity: 'important', title: 'Set your business hours', why: 'Sarah needs them to tell callers whether you are open and when to book.' });
  if (s.smsComplianceComplete === false)
    add({ id: 'sms-incomplete', settingId: 'sms-compliance', severity: 'important', title: 'Finish SMS registration', why: 'Carriers may block texts until registration is complete.' });
  if (s.notificationChannelsEnabled === 0)
    add({ id: 'all-notifications-off', settingId: 'account', severity: 'suggested', title: 'Turn on at least one notification channel', why: 'Right now you would not hear about missed calls or emergencies.' });
  for (const k of s.apiKeys ?? []) {
    const age = (now - new Date(k.createdAt).getTime()) / DAY;
    const idle = k.lastUsedAt ? (now - new Date(k.lastUsedAt).getTime()) / DAY : age;
    if (idle > 90 || age > 365)
      add({ id: `stale-key-${k.id}`, settingId: 'api-keys', severity: 'suggested', title: 'Review an API key that is old or unused', why: 'Keys nobody uses are risk without benefit. Revoke them or rotate them.' });
  }
  return out;
}
