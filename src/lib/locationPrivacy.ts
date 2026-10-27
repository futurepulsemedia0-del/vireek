import { supabase } from '@/lib/supabase';
import { setTrackingGate, type TrackingGateReason } from '@/lib/trackingGate';

/**
 * Technician location privacy — dashboard + field client library.
 *
 * Thin wrapper over supabase/migrations/20271210000000_technician_location_privacy.sql.
 * The database is the authority: it gates which points are stored (off duty / no consent)
 * and which roles can read locations (restrictive RLS). Everything here is presentation
 * plus small pure helpers that mirror the server rules for previews and tests.
 */

export type VisibilityLevel = 'none' | 'current' | 'full';
export type RoleKind = 'base_role' | 'custom_role';
export type ConsentAction = 'granted' | 'revoked';
export type ConsentStatus = 'granted' | 'outdated' | 'revoked' | 'none';

export const LEVELS: VisibilityLevel[] = ['none', 'current', 'full'];

export const LEVEL_LABEL: Record<VisibilityLevel, string> = {
  none: 'No access',
  current: 'Live position only',
  full: 'Live position and history',
};

export const LEVEL_HINT: Record<VisibilityLevel, string> = {
  none: 'Cannot see where technicians are.',
  current: 'Sees the live map, but not breadcrumbs or past trips.',
  full: 'Sees the live map plus location history.',
};

export interface RoleOption {
  kind: RoleKind;
  key: string;
  label: string;
}

export interface VisibilityRule {
  role_kind: RoleKind;
  role_key: string;
  level: VisibilityLevel;
}

export interface LocationPrivacySettings {
  configured: boolean;
  trackOnlyOnShift: boolean;
  requireConsent: boolean;
  noticeVersion: number;
  defaultVisibility: VisibilityLevel;
  hideVehicleOffDuty: boolean;
  rules: VisibilityRule[];
  roles: RoleOption[];
}

export interface SaveLocationPrivacyInput {
  trackOnlyOnShift: boolean;
  requireConsent: boolean;
  defaultVisibility: VisibilityLevel;
  hideVehicleOffDuty: boolean;
  rules: VisibilityRule[];
  bumpNotice: boolean;
}

export interface ConsentOverviewRow {
  teamMemberId: string;
  name: string;
  email: string;
  role: string;
  action: ConsentAction | null;
  version: number | null;
  at: string | null;
  onShift: boolean;
}

export interface ConsentLogEntry {
  id: string;
  memberName: string | null;
  memberEmail: string;
  action: ConsentAction;
  noticeVersion: number;
  source: 'app' | 'web';
  createdAt: string;
}

export interface MyTrackingStatus {
  allowed: boolean;
  reason: TrackingGateReason;
  onShift: boolean;
  consentCurrent: boolean;
  requiresConsent: boolean;
  trackOnlyOnShift: boolean;
  noticeVersion: number;
}

// ------------------------------------------------------------------
// Pure helpers (unit-tested)
// ------------------------------------------------------------------

export function isLevel(v: unknown): v is VisibilityLevel {
  return v === 'none' || v === 'current' || v === 'full';
}

export function ruleKey(kind: RoleKind, key: string): string {
  return `${kind}:${key}`;
}

/** Mirrors location_visibility_level(): custom-role rule, then base-role rule, then default. */
export function effectiveLevel(
  rules: VisibilityRule[],
  member: { role: string; customRoleId?: string | null },
  defaultLevel: VisibilityLevel,
): VisibilityLevel {
  if (member.customRoleId) {
    const custom = rules.find((r) => r.role_kind === 'custom_role' && r.role_key === member.customRoleId);
    if (custom) return custom.level;
  }
  const base = rules.find((r) => r.role_kind === 'base_role' && r.role_key === member.role);
  return base ? base.level : defaultLevel;
}

/** Rules → editor map. A missing key means "use the default". */
export function rulesToMap(rules: VisibilityRule[]): Record<string, VisibilityLevel> {
  const map: Record<string, VisibilityLevel> = {};
  for (const r of rules) map[ruleKey(r.role_kind, r.role_key)] = r.level;
  return map;
}

/** Editor map → rules for the roles that still exist; "inherit" rows are dropped. */
export function mapToRules(map: Record<string, VisibilityLevel | 'inherit'>, roles: RoleOption[]): VisibilityRule[] {
  const out: VisibilityRule[] = [];
  for (const role of roles) {
    const level = map[ruleKey(role.kind, role.key)];
    if (isLevel(level)) out.push({ role_kind: role.kind, role_key: role.key, level });
  }
  return out;
}

/** How a technician's latest consent row reads against the current notice version. */
export function consentStatus(
  row: Pick<ConsentOverviewRow, 'action' | 'version'>,
  noticeVersion: number,
): ConsentStatus {
  if (!row.action) return 'none';
  if (row.action === 'revoked') return 'revoked';
  return (row.version ?? 0) >= noticeVersion ? 'granted' : 'outdated';
}

export const CONSENT_LABEL: Record<ConsentStatus, string> = {
  granted: 'Consented',
  outdated: 'Needs re-consent',
  revoked: 'Revoked',
  none: 'No consent yet',
};

export interface ConsentSummary {
  total: number;
  granted: number;
  pending: number;
  revoked: number;
  onShiftWithoutConsent: number;
}

export function summarizeConsent(rows: ConsentOverviewRow[], noticeVersion: number): ConsentSummary {
  const s: ConsentSummary = { total: rows.length, granted: 0, pending: 0, revoked: 0, onShiftWithoutConsent: 0 };
  for (const r of rows) {
    const st = consentStatus(r, noticeVersion);
    if (st === 'granted') s.granted += 1;
    else if (st === 'revoked') s.revoked += 1;
    else s.pending += 1;
    if (r.onShift && st !== 'granted') s.onShiftWithoutConsent += 1;
  }
  return s;
}

export function gateCopy(reason: TrackingGateReason): { title: string; body: string } {
  switch (reason) {
    case 'off_duty':
      return { title: 'Location sharing is paused', body: 'You are off duty. Your location is only shared while you are clocked in.' };
    case 'no_consent':
      return { title: 'Location consent needed', body: 'Review the notice and agree before sharing your location with dispatch.' };
    default:
      return { title: 'Location sharing is on', body: 'Dispatch sees your position while you are on duty.' };
  }
}

export const CONSENT_NOTICE_LINES = [
  'Vireek records your location only while you are clocked in to work.',
  'Dispatch and managers you work for can see it, according to the visibility set by the account owner.',
  'You can withdraw consent at any time; location sharing stops immediately.',
  'Your consent choice is kept as a record, with the date and notice version.',
] as const;

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function errorMessage(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    const m = (e as { message: string }).message.trim();
    if (m) return m;
  }
  return fallback;
}

// ------------------------------------------------------------------
// RPC wrappers
// ------------------------------------------------------------------

export async function fetchLocationPrivacy(): Promise<LocationPrivacySettings> {
  const { data, error } = await supabase.rpc('get_location_privacy');
  if (error) throw error;
  const d = (data ?? {}) as Record<string, unknown>;
  const rules = (Array.isArray(d.rules) ? d.rules : []) as Record<string, unknown>[];
  const roles = (Array.isArray(d.roles) ? d.roles : []) as Record<string, unknown>[];
  return {
    configured: d.configured === true,
    trackOnlyOnShift: d.track_only_on_shift === true,
    requireConsent: d.require_consent === true,
    noticeVersion: Math.max(1, num(d.notice_version, 1)),
    defaultVisibility: isLevel(d.default_visibility) ? d.default_visibility : 'full',
    hideVehicleOffDuty: d.hide_vehicle_off_duty === true,
    rules: rules
      .filter((r) => isLevel(r.level) && (r.role_kind === 'base_role' || r.role_kind === 'custom_role'))
      .map((r) => ({ role_kind: r.role_kind as RoleKind, role_key: String(r.role_key), level: r.level as VisibilityLevel })),
    roles: roles
      .filter((r) => r.kind === 'base_role' || r.kind === 'custom_role')
      .map((r) => ({ kind: r.kind as RoleKind, key: String(r.key), label: String(r.label ?? r.key) })),
  };
}

export async function saveLocationPrivacy(input: SaveLocationPrivacyInput): Promise<void> {
  const { error } = await supabase.rpc('save_location_privacy', {
    p_track_only_on_shift: input.trackOnlyOnShift,
    p_require_consent: input.requireConsent,
    p_default_visibility: input.defaultVisibility,
    p_hide_vehicle_off_duty: input.hideVehicleOffDuty,
    p_rules: input.rules,
    p_bump_notice: input.bumpNotice,
  });
  if (error) throw error;
}

export async function fetchConsentOverview(): Promise<ConsentOverviewRow[]> {
  const { data, error } = await supabase.rpc('get_location_consent_overview');
  if (error) throw error;
  return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
    teamMemberId: String(r.team_member_id),
    name: String(r.member_name ?? r.member_email ?? ''),
    email: String(r.member_email ?? ''),
    role: String(r.role ?? ''),
    action: r.consent_action === 'granted' || r.consent_action === 'revoked' ? r.consent_action : null,
    version: r.consent_version === null || r.consent_version === undefined ? null : num(r.consent_version),
    at: (r.consent_at as string | null) ?? null,
    onShift: r.on_shift === true,
  }));
}

export async function fetchConsentLog(limit = 100): Promise<ConsentLogEntry[]> {
  const { data, error } = await supabase
    .from('location_consent_log')
    .select('id, member_name, member_email, action, notice_version, source, created_at')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));
  if (error) throw error;
  return ((data as Record<string, unknown>[] | null) ?? []).map((r) => ({
    id: String(r.id),
    memberName: (r.member_name as string | null) ?? null,
    memberEmail: String(r.member_email ?? ''),
    action: r.action as ConsentAction,
    noticeVersion: num(r.notice_version, 1),
    source: r.source === 'web' ? 'web' : 'app',
    createdAt: String(r.created_at),
  }));
}

export async function recordLocationConsent(action: ConsentAction, source: 'app' | 'web' = 'app'): Promise<string> {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 300) : null;
  const { data, error } = await supabase.rpc('record_location_consent', {
    p_action: action,
    p_source: source,
    p_user_agent: ua,
  });
  if (error) throw error;
  return data as string;
}

/** Asks the server whether this technician may be tracked now, and primes the client gate. */
export async function fetchMyTrackingStatus(): Promise<MyTrackingStatus> {
  const { data, error } = await supabase.rpc('get_my_location_tracking_status');
  if (error) throw error;
  const d = (data ?? {}) as Record<string, unknown>;
  const reason: TrackingGateReason = d.reason === 'off_duty' || d.reason === 'no_consent' ? d.reason : 'allowed';
  setTrackingGate(reason);
  return {
    allowed: reason === 'allowed',
    reason,
    onShift: d.on_shift === true,
    consentCurrent: d.consent_current === true,
    requiresConsent: d.requires_consent === true,
    trackOnlyOnShift: d.track_only_on_shift === true,
    noticeVersion: Math.max(1, num(d.notice_version, 1)),
  };
}
