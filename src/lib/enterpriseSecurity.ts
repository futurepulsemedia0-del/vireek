import { supabase } from '@/lib/supabase';
import { UserPermissions } from '@/contexts/AuthContext';

// ============================================================
// CUSTOM ROLES
// ============================================================

export interface CustomRole {
  id: string;
  user_id: string;
  name: string;
  permissions: Partial<UserPermissions>;
  created_at: string;
}

export const ROLE_PERMISSION_LABELS: Record<keyof UserPermissions, string> = {
  can_view_billing: 'View billing',
  can_manage_numbers: 'Manage phone numbers',
  can_manage_team: 'Manage team',
  can_edit_business_profile: 'Edit business profile',
  can_view_all_jobs: 'View all jobs',
  can_view_audit_log: 'View audit log',
  can_manage_security: 'Manage security settings',
};

export async function fetchCustomRoles(): Promise<CustomRole[]> {
  const { data, error } = await supabase.from('custom_roles').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return (data as CustomRole[]) || [];
}

export async function saveCustomRole(userId: string, name: string, permissions: Partial<UserPermissions>, existingId?: string): Promise<void> {
  const payload = { user_id: userId, name: name.trim(), permissions };
  const query = existingId ? supabase.from('custom_roles').update(payload).eq('id', existingId) : supabase.from('custom_roles').insert(payload);
  const { error } = await query;
  if (error) throw error;
}

export async function deleteCustomRole(id: string): Promise<void> {
  const { error } = await supabase.from('custom_roles').delete().eq('id', id);
  if (error) throw error;
}

export async function assignCustomRole(teamMemberId: string, customRoleId: string | null): Promise<void> {
  const { error } = await supabase.from('team_members').update({ custom_role_id: customRoleId }).eq('id', teamMemberId);
  if (error) throw error;
}

// ============================================================
// IP ALLOWLIST
// ============================================================

export interface IpAllowRule {
  id: string;
  cidr: string;
  label: string | null;
  created_at: string;
}

export async function fetchIpAllowRules(): Promise<IpAllowRule[]> {
  const { data, error } = await supabase.from('ip_allow_rules').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return (data as IpAllowRule[]) || [];
}

const CIDR_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/([0-9]|[1-2][0-9]|3[0-2]))?$/;

export async function addIpAllowRule(userId: string, cidr: string, label: string): Promise<void> {
  const trimmed = cidr.trim();
  if (!CIDR_REGEX.test(trimmed)) throw new Error('Enter a valid IPv4 address or CIDR (e.g. 203.0.113.4 or 203.0.113.0/24).');
  const normalized = trimmed.includes('/') ? trimmed : `${trimmed}/32`;
  const { error } = await supabase.from('ip_allow_rules').insert({ user_id: userId, cidr: normalized, label: label.trim() || null });
  if (error) throw error;
}

export async function deleteIpAllowRule(id: string): Promise<void> {
  const { error } = await supabase.from('ip_allow_rules').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// SECURITY POLICY
// ============================================================

export interface SecurityPolicy {
  id: string;
  user_id: string;
  sso_enforced: boolean;
  require_mfa_for_team: boolean;
  ip_restriction_enabled: boolean;
  session_idle_minutes: number;
  session_max_hours: number;
  updated_at: string;
}

export async function fetchSecurityPolicy(): Promise<SecurityPolicy | null> {
  const { data, error } = await supabase.from('security_policies').select('*').maybeSingle();
  if (error) throw error;
  return data as SecurityPolicy | null;
}

export async function saveSecurityPolicy(userId: string, patch: Partial<Omit<SecurityPolicy, 'id' | 'user_id' | 'updated_at'>>): Promise<void> {
  const { error } = await supabase
    .from('security_policies')
    .upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw error;
}

// ============================================================
// SSO DOMAINS
// ============================================================

export interface SsoDomain {
  id: string;
  domain: string;
  status: 'pending' | 'active' | 'disabled';
  created_at: string;
}

export async function fetchSsoDomains(): Promise<SsoDomain[]> {
  const { data, error } = await supabase.from('sso_domains').select('id, domain, status, created_at').order('created_at', { ascending: true });
  if (error) throw error;
  return (data as SsoDomain[]) || [];
}

export async function registerSsoDomain(domain: string, metadataUrl: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('admin-sso', { body: { action: 'register', domain, metadataUrl } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
}

export async function removeSsoDomain(domain: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('admin-sso', { body: { action: 'remove', domain } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
}

export async function signInWithSsoDomain(domain: string): Promise<string> {
  const { data, error } = await supabase.auth.signInWithSSO({ domain });
  if (error) throw error;
  if (!data?.url) throw new Error('This domain has no SSO connection configured.');
  return data.url;
}

// ============================================================
// SCIM TOKENS
// ============================================================

export interface ScimToken {
  id: string;
  name: string;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export async function fetchScimTokens(): Promise<ScimToken[]> {
  const { data, error } = await supabase.from('scim_tokens').select('id, name, last_used_at, created_at, revoked_at').order('created_at', { ascending: false });
  if (error) throw error;
  return (data as ScimToken[]) || [];
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Returns the raw token — shown once, never retrievable again. */
export async function createScimToken(userId: string, name: string): Promise<string> {
  const raw = `scim_${crypto.randomUUID().replace(/-/g, '')}`;
  const hash = await sha256Hex(raw);
  const { error } = await supabase.from('scim_tokens').insert({ user_id: userId, name: name.trim() || 'SCIM token', token_hash: hash });
  if (error) throw error;
  return raw;
}

export async function revokeScimToken(id: string): Promise<void> {
  const { error } = await supabase.from('scim_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

// ============================================================
// SESSION POLICY ENFORCEMENT (client-side)
// ============================================================

const IDLE_KEY = 'vrk_last_activity';

/** Call once near the top of any protected layout. Signs the user out when
 * they've been idle longer than the account's policy, or when their
 * session has exceeded the max-session-duration. Silently no-ops when no
 * policy row exists (default = unrestricted). */
export function trackActivity(): void {
  localStorage.setItem(IDLE_KEY, String(Date.now()));
}

export function getIdleMinutes(): number {
  const last = Number(localStorage.getItem(IDLE_KEY) ?? Date.now());
  return (Date.now() - last) / 60000;
}
