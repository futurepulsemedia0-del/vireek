import { supabase } from '@/lib/supabase';

/**
 * AI Security Center - dashboard client library.
 *
 * Reads go through RLS (account-scoped, managers only). Every write goes through a SECURITY DEFINER
 * RPC from supabase/migrations/20270110000000_ai_security_center.sql, which also writes the audit
 * trail. The runtime enforcement itself lives in
 * supabase/functions/_shared/ai-core/aiSecurity.ts.
 */

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export type PiiMode = 'off' | 'sensitive' | 'full';
export type InjectionMode = 'monitor' | 'sanitize' | 'block';
export type SandboxMode = 'off' | 'audit' | 'enforce';

export const AI_PROVIDERS = ['anthropic', 'gemini', 'groq', 'cerebras', 'cloudflare', 'openrouter'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const DATA_DOMAINS = ['customers', 'financial', 'location', 'equipment', 'recordings', 'contracts', 'business_decisions'] as const;
export type DataDomain = (typeof DATA_DOMAINS)[number];

export const DOMAIN_LABELS: Record<DataDomain, string> = {
  customers: 'Customer data',
  financial: 'Financial data',
  location: 'Technician location',
  equipment: 'Equipment data',
  recordings: 'Call recordings',
  contracts: 'Contracts',
  business_decisions: 'Business decisions',
};

export interface AiSecuritySettings {
  pii_mode: PiiMode;
  injection_mode: InjectionMode;
  injection_block_score: number;
  sandbox_mode: SandboxMode;
  allowed_providers: AiProvider[] | null;
  anomaly_alerts_enabled: boolean;
  api_key_max_age_days: number;
}

export const DEFAULT_SETTINGS: AiSecuritySettings = {
  pii_mode: 'sensitive',
  injection_mode: 'sanitize',
  injection_block_score: 70,
  sandbox_mode: 'audit',
  allowed_providers: null,
  anomaly_alerts_enabled: true,
  api_key_max_age_days: 90,
};

export interface AgentSandboxPolicy {
  id: string;
  agent_source: string;
  enabled: boolean;
  allowed_domains: DataDomain[];
  max_records_per_run: number | null;
  allow_external_send: boolean;
  allow_write: boolean;
  updated_at: string;
}

export type EventType = 'prompt_injection' | 'pii_redacted' | 'output_leak' | 'sandbox_violation' | 'provider_denied' | 'anomaly' | 'policy_change';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type EventStatus = 'logged' | 'open' | 'acknowledged' | 'resolved' | 'false_positive';

export interface SecurityEvent {
  id: string;
  event_type: EventType;
  severity: Severity;
  source: string;
  task: string | null;
  agent_source: string | null;
  risk_score: number | null;
  detail: Record<string, unknown>;
  status: EventStatus;
  resolved_at: string | null;
  created_at: string;
}

export interface EventCountRow {
  day: string;
  event_type: EventType;
  severity: Severity;
  total: number;
}

export interface IsolationRow {
  table_name: string;
  rls_enabled: boolean;
  policy_count: number;
  open_policy_count: number;
  risk: 'critical' | 'high' | 'ok';
}

export interface ApiKeySummary {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  created_at: string;
}

export interface IdentityBaseline {
  sso_enforced: boolean;
  require_mfa_for_team: boolean;
  ip_restriction_enabled: boolean;
  session_idle_minutes: number;
  session_max_hours: number;
}

export const EVENT_LABELS: Record<EventType, string> = {
  prompt_injection: 'Prompt injection',
  pii_redacted: 'PII / secret protected',
  output_leak: 'Output leak blocked',
  sandbox_violation: 'Sandbox violation',
  provider_denied: 'Provider denied',
  anomaly: 'Anomaly',
  policy_change: 'Policy change',
};

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export const SEVERITY_STYLES: Record<Severity, string> = {
  critical: 'bg-danger/15 text-danger',
  high: 'bg-danger/10 text-danger',
  medium: 'bg-warning-500/15 text-warning-500',
  low: 'bg-accent/10 text-accent',
  info: 'bg-bg-tertiary text-text-secondary',
};

/** Agents/edge functions known to put business data in front of a model. Extended at runtime from agent_action_catalog. */
export const BUILT_IN_AGENTS = [
  'ai-assistant-query',
  'site-assistant',
  'live-copilot',
  'diagnosis-copilot',
  'workflow-engine-executor',
  'outbound-dialer',
  'followup-agent-dispatcher',
  'business-decision-engine',
  'self-healing-orchestrator',
  'next-best-actions',
] as const;

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return 'Something went wrong';
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchSettings(): Promise<AiSecuritySettings> {
  const { data, error } = await supabase.from('ai_security_settings').select('*').maybeSingle();
  if (error) throw error;
  if (!data) return DEFAULT_SETTINGS;
  return {
    pii_mode: data.pii_mode,
    injection_mode: data.injection_mode,
    injection_block_score: data.injection_block_score,
    sandbox_mode: data.sandbox_mode,
    allowed_providers: data.allowed_providers ?? null,
    anomaly_alerts_enabled: data.anomaly_alerts_enabled,
    api_key_max_age_days: data.api_key_max_age_days,
  };
}

export async function fetchSandboxPolicies(): Promise<AgentSandboxPolicy[]> {
  const { data, error } = await supabase.from('ai_agent_sandbox_policies').select('*').order('agent_source');
  if (error) throw error;
  return (data as AgentSandboxPolicy[]) ?? [];
}

export async function fetchEvents(options?: { limit?: number }): Promise<SecurityEvent[]> {
  const { data, error } = await supabase
    .from('ai_security_events')
    .select('id,event_type,severity,source,task,agent_source,risk_score,detail,status,resolved_at,created_at')
    .neq('event_type', 'policy_change')
    .order('created_at', { ascending: false })
    .limit(options?.limit ?? 200);
  if (error) throw error;
  return (data as SecurityEvent[]) ?? [];
}

export async function fetchEventCounts(days = 14): Promise<EventCountRow[]> {
  const { data, error } = await supabase.rpc('ai_security_event_counts', { p_days: days });
  if (error) throw error;
  return (data as EventCountRow[]) ?? [];
}

export async function runIsolationAudit(): Promise<IsolationRow[]> {
  const { data, error } = await supabase.rpc('ai_security_isolation_audit');
  if (error) throw error;
  return (data as IsolationRow[]) ?? [];
}

export async function fetchActiveApiKeys(): Promise<ApiKeySummary[]> {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id,name,key_prefix,last_used_at,created_at')
    .is('revoked_at', null)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data as ApiKeySummary[]) ?? [];
}

export async function fetchIdentityBaseline(): Promise<IdentityBaseline> {
  const { data, error } = await supabase
    .from('security_policies')
    .select('sso_enforced,require_mfa_for_team,ip_restriction_enabled,session_idle_minutes,session_max_hours')
    .maybeSingle();
  if (error) throw error;
  return (
    (data as IdentityBaseline | null) ?? {
      sso_enforced: false,
      require_mfa_for_team: false,
      ip_restriction_enabled: false,
      session_idle_minutes: 0,
      session_max_hours: 0,
    }
  );
}

export async function fetchKnownAgents(): Promise<string[]> {
  const set = new Set<string>(BUILT_IN_AGENTS);
  const { data } = await supabase.from('agent_action_catalog').select('agent_source');
  for (const row of (data as { agent_source: string }[] | null) ?? []) set.add(row.agent_source);
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// Writes (all via SECURITY DEFINER RPCs)
// ---------------------------------------------------------------------------

export async function saveSettings(s: AiSecuritySettings): Promise<void> {
  const { error } = await supabase.rpc('upsert_ai_security_settings', {
    p_pii_mode: s.pii_mode,
    p_injection_mode: s.injection_mode,
    p_injection_block_score: s.injection_block_score,
    p_sandbox_mode: s.sandbox_mode,
    p_allowed_providers: s.allowed_providers && s.allowed_providers.length ? s.allowed_providers : null,
    p_anomaly_alerts_enabled: s.anomaly_alerts_enabled,
    p_api_key_max_age_days: s.api_key_max_age_days,
  });
  if (error) throw error;
}

export async function saveSandboxPolicy(p: Omit<AgentSandboxPolicy, 'id' | 'updated_at'>): Promise<void> {
  const { error } = await supabase.rpc('upsert_ai_agent_sandbox_policy', {
    p_agent_source: p.agent_source,
    p_enabled: p.enabled,
    p_allowed_domains: p.allowed_domains,
    p_max_records: p.max_records_per_run,
    p_allow_external_send: p.allow_external_send,
    p_allow_write: p.allow_write,
  });
  if (error) throw error;
}

export async function deleteSandboxPolicy(agentSource: string): Promise<void> {
  const { error } = await supabase.rpc('delete_ai_agent_sandbox_policy', { p_agent_source: agentSource });
  if (error) throw error;
}

export async function setEventStatus(id: string, status: 'acknowledged' | 'resolved' | 'false_positive'): Promise<void> {
  const { error } = await supabase.rpc('set_ai_security_event_status', { p_event_id: id, p_status: status });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Pure logic (unit-tested)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export interface KeyHygieneIssue {
  id: string;
  name: string;
  key_prefix: string;
  issue: 'rotation_due' | 'unused';
  ageDays: number;
}

export function apiKeyHygiene(keys: ApiKeySummary[], maxAgeDays: number, now = Date.now()): KeyHygieneIssue[] {
  const out: KeyHygieneIssue[] = [];
  for (const k of keys) {
    const ageDays = Math.floor((now - new Date(k.created_at).getTime()) / DAY_MS);
    const idleDays = k.last_used_at ? Math.floor((now - new Date(k.last_used_at).getTime()) / DAY_MS) : null;
    if (ageDays > maxAgeDays) out.push({ id: k.id, name: k.name, key_prefix: k.key_prefix, issue: 'rotation_due', ageDays });
    else if ((idleDays === null && ageDays > 30) || (idleDays !== null && idleDays > 90)) {
      out.push({ id: k.id, name: k.name, key_prefix: k.key_prefix, issue: 'unused', ageDays });
    }
  }
  return out;
}

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface PostureCheck {
  id: string;
  title: string;
  detail: string;
  weight: number;
  earned: number; // 0..1
  status: CheckStatus;
  tab: 'policies' | 'sandbox' | 'events' | 'isolation';
}

export interface PostureInput {
  settings: AiSecuritySettings;
  sandboxPolicies: AgentSandboxPolicy[];
  knownAgents: string[];
  identity: IdentityBaseline;
  isolation: IsolationRow[] | null; // null = audit not run yet
  keyIssues: KeyHygieneIssue[];
  openEvents: Pick<SecurityEvent, 'severity' | 'status'>[];
}

export interface Posture {
  score: number;
  label: 'Hardened' | 'Strong' | 'Needs work' | 'At risk';
  checks: PostureCheck[];
}

function statusOf(earned: number): CheckStatus {
  return earned >= 0.85 ? 'pass' : earned >= 0.4 ? 'warn' : 'fail';
}

export function computePosture(input: PostureInput): Posture {
  const { settings, sandboxPolicies, knownAgents, identity, isolation, keyIssues, openEvents } = input;
  const checks: PostureCheck[] = [];
  const add = (c: Omit<PostureCheck, 'status'>) => checks.push({ ...c, status: statusOf(c.earned) });

  add({
    id: 'injection',
    title: 'Prompt-injection defense',
    detail: { block: 'Blocking high-risk prompts.', sanitize: 'Risky input is isolated as untrusted data. Switch to Block for the strictest posture.', monitor: 'Detection only - attacks are logged but not stopped.' }[settings.injection_mode],
    weight: 15,
    earned: { block: 1, sanitize: 0.85, monitor: 0.4 }[settings.injection_mode],
    tab: 'policies',
  });

  add({
    id: 'pii',
    title: 'PII & secret protection',
    detail: { full: 'Sensitive data is redacted; contact data is tokenized before it reaches a model.', sensitive: 'Cards, SSNs, IBANs and API secrets are redacted before reaching a model.', off: 'Personal data and secrets can reach AI providers unfiltered.' }[settings.pii_mode],
    weight: 15,
    earned: { full: 1, sensitive: 0.85, off: 0 }[settings.pii_mode],
    tab: 'policies',
  });

  const hasSandboxPolicies = sandboxPolicies.length > 0;
  add({
    id: 'sandbox',
    title: 'Agent sandbox enforcement',
    detail:
      settings.sandbox_mode === 'enforce'
        ? hasSandboxPolicies
          ? 'Agents are held to least-privilege policies.'
          : 'Enforcing, but no agent has an explicit policy - built-in defaults apply.'
        : settings.sandbox_mode === 'audit'
          ? 'Violations are logged but not blocked. Move to Enforce once the log is quiet.'
          : 'Sandbox is off - agents can use any data domain.',
    weight: 15,
    earned: settings.sandbox_mode === 'enforce' ? (hasSandboxPolicies ? 1 : 0.7) : settings.sandbox_mode === 'audit' ? 0.5 : 0,
    tab: 'sandbox',
  });

  const coverage = knownAgents.length ? Math.min(1, sandboxPolicies.length / knownAgents.length) : 1;
  add({
    id: 'coverage',
    title: 'Agent policy coverage',
    detail: `${sandboxPolicies.length} of ${knownAgents.length} known agents have an explicit sandbox policy.`,
    weight: 10,
    earned: coverage,
    tab: 'sandbox',
  });

  add({
    id: 'providers',
    title: 'Model access control',
    detail: settings.allowed_providers?.length ? `AI calls restricted to ${settings.allowed_providers.join(', ')}.` : 'Any configured AI provider may receive your data.',
    weight: 5,
    earned: settings.allowed_providers?.length ? 1 : 0.5,
    tab: 'policies',
  });

  const identityScore = (identity.require_mfa_for_team ? 0.5 : 0) + (identity.sso_enforced ? 0.3 : 0) + (identity.ip_restriction_enabled ? 0.2 : 0);
  add({
    id: 'identity',
    title: 'Identity & access',
    detail: `MFA for team ${identity.require_mfa_for_team ? 'required' : 'not required'}, SSO ${identity.sso_enforced ? 'enforced' : 'not enforced'}, IP restriction ${identity.ip_restriction_enabled ? 'on' : 'off'}.`,
    weight: 10,
    earned: identityScore,
    tab: 'policies',
  });

  const sessionsLimited = identity.session_idle_minutes > 0 && identity.session_max_hours > 0;
  add({
    id: 'sessions',
    title: 'Session limits',
    detail: sessionsLimited ? 'Idle and maximum session lifetimes are enforced.' : 'No idle or maximum session lifetime configured.',
    weight: 5,
    earned: sessionsLimited ? 1 : 0,
    tab: 'policies',
  });

  const crit = isolation?.filter((r) => r.risk === 'critical').length ?? 0;
  const high = isolation?.filter((r) => r.risk === 'high').length ?? 0;
  add({
    id: 'isolation',
    title: 'Tenant isolation',
    detail: isolation === null ? 'Not verified yet - run the isolation audit.' : crit + high === 0 ? `All ${isolation.length} tenant tables have row-level security and no open policies.` : `${crit} table(s) without RLS and ${high} with an open policy.`,
    weight: 10,
    earned: isolation === null ? 0.3 : crit > 0 ? 0 : high > 0 ? 0.4 : 1,
    tab: 'isolation',
  });

  add({
    id: 'keys',
    title: 'API key hygiene',
    detail: keyIssues.length ? `${keyIssues.length} key(s) need rotation or revocation.` : 'No stale or unused API keys.',
    weight: 5,
    earned: keyIssues.length === 0 ? 1 : keyIssues.length === 1 ? 0.6 : 0.2,
    tab: 'isolation',
  });

  const open = openEvents.filter((e) => e.status === 'open');
  const openCrit = open.filter((e) => e.severity === 'critical').length;
  const openHigh = open.filter((e) => e.severity === 'high').length;
  const openMed = open.filter((e) => e.severity === 'medium').length;
  add({
    id: 'incidents',
    title: 'Open incidents',
    detail: open.length ? `${openCrit} critical, ${openHigh} high, ${openMed} medium awaiting review.` : 'No open security incidents.',
    weight: 10,
    earned: openCrit > 0 ? 0 : openHigh > 0 ? 0.4 : openMed > 0 ? 0.8 : 1,
    tab: 'events',
  });

  const total = checks.reduce((n, c) => n + c.weight, 0);
  const score = Math.round((checks.reduce((n, c) => n + c.weight * c.earned, 0) / total) * 100);
  const label = score >= 90 ? 'Hardened' : score >= 75 ? 'Strong' : score >= 55 ? 'Needs work' : 'At risk';
  return { score, label, checks };
}
