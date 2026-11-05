// Voice resilience: shared types and PURE view-model helpers for /dashboard/voice-resilience.
// No React, no network: everything here is unit-tested. The API client lives in voiceResilienceApi.ts.
// Server contract: supabase/functions/voice-resilience-admin (actions status, set_org, wizard_*).

export type Level = 0 | 1 | 2 | 3 | 4;
export const LEVELS: readonly Level[] = [0, 1, 2, 3, 4];
export type Tone = 'ok' | 'warn' | 'critical';

export function isLevel(n: unknown): n is Level {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 4;
}

/** Text + tone, never colour alone (WCAG 1.4.1): the UI always renders the level name next to the badge. */
export function levelTone(level: Level): Tone {
  return level === 0 ? 'ok' : level <= 2 ? 'warn' : 'critical';
}

export type FallbackOutcome = 'entered' | 'voicemail' | 'forwarded' | 'static' | 'emergency_forwarded' | 'abandoned';

export interface FallbackCall {
  call_sid: string;
  level: Level;
  outcome: FallbackOutcome;
  is_emergency: boolean;
  created_at: string;
}

export type CheckStatus = 'pending' | 'passed' | 'failed' | 'answered_by_human' | 'expired' | 'error';
export type CheckKind = 'forward_on' | 'forward_off';
export type CarrierFamily = 'gsm_standard' | 'verizon' | 'landline_voip_pbx';
export type Lang = 'en' | 'es';

export interface OrgSettings {
  user_id: string;
  forced_level: Level | null;
  forced_until: string | null;
  reduced_assistant_id: string | null;
  static_message: string | null;
  language: Lang;
  forward_numbers: string[];
  front_door_enabled: boolean;
  alert_sms: boolean;
}

export interface VoiceStatus {
  org: OrgSettings | null;
  platform_level: Level;
  since: string | null;
  recent_fallback_calls: FallbackCall[];
  checks: { id: string; kind: CheckKind; status: CheckStatus; started_at: string; finished_at: string | null }[];
}

export interface ForwardCode {
  kind: 'no_answer' | 'unreachable' | 'busy';
  activate: string;
  cancel: string;
  status: string | null;
  confidence: 'standard' | 'commonly_documented' | 'ask_carrier';
  note: string;
}

// ---------------------------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------------------------

const E164 = /^\+[1-9]\d{6,14}$/;
export const isE164 = (s: string): boolean => E164.test(s);
export const MAX_FORWARD_NUMBERS = 5;
export const MAX_STATIC_MESSAGE = 500;

/** Accepts E.164, or a 10/11-digit North American number (normalised to +1…). Anything else is invalid, never guessed. */
export function normalizePhone(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const digits = t.replace(/[^\d]/g, '');
  if (t.startsWith('+')) return isE164(`+${digits}`) ? `+${digits}` : null;
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1') && /^[2-9]/.test(digits[1])) return `+${digits}`;
  return null;
}

export function parseNumberList(raw: string): { numbers: string[]; invalid: string[] } {
  const parts = raw.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean);
  const numbers: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    const n = normalizePhone(p);
    if (!n) invalid.push(p);
    else if (!numbers.includes(n)) numbers.push(n);
  }
  return { numbers, invalid };
}

/** "+15551234567" -> "+1 555 ••• 4567" (for the wizard summary and live regions; never reads a whole number aloud). */
export function maskPhone(n: string): string {
  if (!isE164(n)) return '••••';
  return `${n.slice(0, Math.min(n.length - 7, 4))} ••• ${n.slice(-4)}`;
}

// ---------------------------------------------------------------------------------------------
// Settings form
// ---------------------------------------------------------------------------------------------

export interface SettingsDraft {
  forwardNumbersText: string;
  staticMessage: string;
  language: Lang;
  reducedAssistantId: string;
  alertSms: boolean;
  frontDoorEnabled: boolean;
}

export const draftFromSettings = (s: OrgSettings | null): SettingsDraft => ({
  forwardNumbersText: (s?.forward_numbers ?? []).join('\n'),
  staticMessage: s?.static_message ?? '',
  language: s?.language ?? 'en',
  reducedAssistantId: s?.reduced_assistant_id ?? '',
  alertSms: s?.alert_sms ?? true,
  frontDoorEnabled: s?.front_door_enabled ?? false,
});

export type SettingsErrorKey = 'forwardInvalid' | 'forwardTooMany' | 'staticTooLong' | 'assistantInvalid';
export type SettingsErrors = Partial<Record<'forwardNumbers' | 'staticMessage' | 'reducedAssistantId', { key: SettingsErrorKey; values?: Record<string, string | number> }>>;

const ASSISTANT_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function validateSettings(d: SettingsDraft): SettingsErrors {
  const errors: SettingsErrors = {};
  const { numbers, invalid } = parseNumberList(d.forwardNumbersText);
  if (invalid.length) errors.forwardNumbers = { key: 'forwardInvalid', values: { list: invalid.slice(0, 3).join(', ') } };
  else if (numbers.length > MAX_FORWARD_NUMBERS) errors.forwardNumbers = { key: 'forwardTooMany', values: { max: MAX_FORWARD_NUMBERS } };
  if (d.staticMessage.trim().length > MAX_STATIC_MESSAGE) errors.staticMessage = { key: 'staticTooLong', values: { max: MAX_STATIC_MESSAGE } };
  const a = d.reducedAssistantId.trim();
  if (a && !ASSISTANT_ID.test(a)) errors.reducedAssistantId = { key: 'assistantInvalid' };
  return errors;
}

/** Only changed fields are sent, so an untouched form never overwrites values set elsewhere. Returns null when nothing changed. */
export function buildSavePayload(d: SettingsDraft, initial: OrgSettings | null): Record<string, unknown> | null {
  const base = draftFromSettings(initial);
  const out: Record<string, unknown> = {};
  const nums = parseNumberList(d.forwardNumbersText).numbers;
  if (nums.join('|') !== parseNumberList(base.forwardNumbersText).numbers.join('|')) out.forward_numbers = nums;
  if (d.staticMessage.trim() !== base.staticMessage.trim()) out.static_message = d.staticMessage.trim() || null;
  if (d.language !== base.language) out.language = d.language;
  if (d.reducedAssistantId.trim() !== base.reducedAssistantId.trim()) out.reduced_assistant_id = d.reducedAssistantId.trim() || null;
  if (d.alertSms !== base.alertSms) out.alert_sms = d.alertSms;
  if (d.frontDoorEnabled !== base.frontDoorEnabled) out.front_door_enabled = d.frontDoorEnabled;
  return Object.keys(out).length ? out : null;
}

/** Overrides: server accepts level 0-4 for 1-1440 minutes. */
export function validateForcedLevel(level: number, minutes: number): boolean {
  return isLevel(level) && Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
}

export function forcedLevelActive(s: OrgSettings | null, now: number): boolean {
  if (!s || s.forced_level == null) return false;
  return !s.forced_until || Date.parse(s.forced_until) > now;
}

// ---------------------------------------------------------------------------------------------
// Carrier wizard
// ---------------------------------------------------------------------------------------------

export interface WizardView {
  tone: Tone | 'info';
  titleKey: string;
  bodyKey: string;
  terminal: boolean;
  canRetry: boolean;
}

export function wizardView(status: CheckStatus, kind: CheckKind): WizardView {
  const on = kind === 'forward_on';
  switch (status) {
    case 'pending':
      return { tone: 'info', titleKey: on ? 'wizard.result.pendingOn.title' : 'wizard.result.pendingOff.title', bodyKey: on ? 'wizard.result.pendingOn.body' : 'wizard.result.pendingOff.body', terminal: false, canRetry: false };
    case 'passed':
      return { tone: 'ok', titleKey: on ? 'wizard.result.passedOn.title' : 'wizard.result.passedOff.title', bodyKey: on ? 'wizard.result.passedOn.body' : 'wizard.result.passedOff.body', terminal: true, canRetry: false };
    case 'failed':
      return { tone: 'critical', titleKey: on ? 'wizard.result.failedOn.title' : 'wizard.result.failedOff.title', bodyKey: on ? 'wizard.result.failedOn.body' : 'wizard.result.failedOff.body', terminal: true, canRetry: true };
    case 'answered_by_human':
      return { tone: 'warn', titleKey: 'wizard.result.answered.title', bodyKey: 'wizard.result.answered.body', terminal: true, canRetry: true };
    case 'expired':
      return { tone: 'warn', titleKey: 'wizard.result.expired.title', bodyKey: 'wizard.result.expired.body', terminal: true, canRetry: true };
    default:
      return { tone: 'critical', titleKey: 'wizard.result.error.title', bodyKey: 'wizard.result.error.body', terminal: true, canRetry: true };
  }
}

export const POLL_MAX_MS = 2 * 60_000;
/** 3 s for the first 30 s (the forward usually lands then), 5 s afterwards. */
export const pollDelayMs = (elapsedMs: number): number => (elapsedMs < 30_000 ? 3_000 : 5_000);
export const pollExpired = (elapsedMs: number): boolean => elapsedMs >= POLL_MAX_MS;

export const CARRIER_FAMILIES: readonly CarrierFamily[] = ['gsm_standard', 'verizon', 'landline_voip_pbx'];

/** A code with an empty `activate` means "no universal code": show guidance, never an empty dial string. */
export const hasDialCode = (c: ForwardCode): boolean => c.activate.trim().length > 0;

export const OUTCOME_KEY: Record<FallbackOutcome, string> = {
  entered: 'status.outcome.entered',
  voicemail: 'status.outcome.voicemail',
  forwarded: 'status.outcome.forwarded',
  static: 'status.outcome.static',
  emergency_forwarded: 'status.outcome.emergencyForwarded',
  abandoned: 'status.outcome.abandoned',
};

/** Maps server error text to a stable key; unknown errors never leak raw server text into the UI. */
export function errorKeyFor(message: string | undefined, status?: number): string {
  if (status === 429 || /too many/i.test(message ?? '')) return 'errors.tooMany';
  if (status === 403 || /forbidden|must be the phone number|not on your account/i.test(message ?? '')) return 'errors.forbidden';
  if (status === 503 || /not configured/i.test(message ?? '')) return 'errors.notConfigured';
  return 'errors.generic';
}

/** Translation function shape the presentational components depend on (react-i18next's `t` satisfies it). */
export type TFn = (key: string, options?: Record<string, unknown>) => string;

/** The level that governs THIS account's calls right now (org pin beats the platform level while active). */
export function effectiveLevelFor(status: Pick<VoiceStatus, 'org' | 'platform_level'>, now: number): { level: Level; pinned: boolean } {
  if (forcedLevelActive(status.org, now) && status.org?.forced_level != null) return { level: status.org.forced_level, pinned: true };
  return { level: status.platform_level, pinned: false };
}
