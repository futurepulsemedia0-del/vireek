import { supabase } from '@/lib/supabase';

/**
 * AI Agent Marketplace — dashboard client library.
 *
 * Read surface + RPC writes on top of the tables in
 * supabase/migrations/20270210000000_agent_marketplace.sql. All writes go
 * through SECURITY DEFINER RPCs (no direct table writes exist), and agent
 * execution goes through the `agent-runtime` edge function.
 */

export type AgentCategory =
  | 'hvac' | 'plumbing' | 'electrical' | 'collections' | 'revenue' | 'dispatch' | 'warranty' | 'compliance' | 'general';
export type ScopeRisk = 'low' | 'medium' | 'high';
export type PricingModel = 'free' | 'per_run' | 'monthly';

export const CATEGORY_LABELS: Record<AgentCategory, string> = {
  hvac: 'HVAC', plumbing: 'Plumbing', electrical: 'Electrical', collections: 'Collections',
  revenue: 'Revenue', dispatch: 'Dispatch', warranty: 'Warranty', compliance: 'Compliance', general: 'General',
};

export interface AgentManifest {
  scopes: string[];
  triggers: string[];
  limits?: { timeout_ms?: number; max_actions?: number };
  system_prompt?: string;
}

export interface MarketplaceScope {
  slug: string;
  label: string;
  description: string;
  kind: 'read' | 'act';
  risk: ScopeRisk;
  governance_slug: string | null;
}

export interface MarketplaceAgent {
  id: string;
  slug: string;
  publisher_id: string | null;
  publisher_name: string;
  name: string;
  tagline: string;
  description: string;
  category: AgentCategory;
  runtime: 'builtin' | 'webhook';
  endpoint_url: string | null;
  status: 'draft' | 'in_review' | 'published' | 'suspended';
  pricing_model: PricingModel;
  price_cents: number;
  platform_fee_bps: number;
  current_version_id: string | null;
  suspended_reason: string | null;
}

export interface MarketplaceVersion {
  id: string;
  agent_id: string;
  version: string;
  manifest: AgentManifest;
  manifest_hash: string;
  status: 'submitted' | 'approved' | 'rejected' | 'deprecated';
  review_notes: string | null;
  created_at: string;
}

export interface MarketplaceInstall {
  id: string;
  user_id: string;
  agent_id: string;
  version_id: string;
  status: 'active' | 'paused' | 'revoked';
  granted_scopes: string[];
  max_runs_per_day: number;
  max_monthly_spend_cents: number;
  installed_at: string;
  updated_at: string;
}

export interface MarketplaceRun {
  id: string;
  install_id: string;
  agent_id: string;
  trigger: string;
  status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'blocked';
  summary: string | null;
  actions_proposed: number;
  actions_executed: number;
  actions_pending: number;
  actions_rejected: number;
  duration_ms: number | null;
  cost_cents: number;
  error: string | null;
  created_at: string;
}

export interface MarketplaceOutput {
  id: string;
  run_id: string;
  install_id: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  entity_type: 'job' | 'customer' | null;
  entity_id: string | null;
  created_at: string;
}

export interface MarketplaceLedgerEntry {
  id: string;
  install_id: string;
  agent_id: string;
  entry_type: 'usage' | 'subscription' | 'adjustment';
  amount_cents: number;
  platform_fee_cents: number;
  publisher_payout_cents: number;
  period: string;
  description: string | null;
  created_at: string;
}

export interface MarketplaceAuditEntry {
  id: number;
  agent_id: string | null;
  install_id: string | null;
  event: string;
  detail: Record<string, unknown>;
  hash: string;
  created_at: string;
}

export interface ReviewQueueItem {
  version_id: string;
  agent_id: string;
  agent_name: string;
  agent_slug: string;
  publisher_name: string;
  endpoint_url: string | null;
  version: string;
  manifest: AgentManifest;
  manifest_hash: string;
  created_at: string;
}

// ---------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------

export function formatPrice(agent: Pick<MarketplaceAgent, 'pricing_model' | 'price_cents'>): string {
  if (agent.pricing_model === 'free' || agent.price_cents === 0) return 'Free';
  const dollars = (agent.price_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return agent.pricing_model === 'per_run' ? `$${dollars} / run` : `$${dollars} / month`;
}

export function currentPeriod(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function spendForPeriod(entries: MarketplaceLedgerEntry[], period: string, installId?: string): number {
  return entries
    .filter((e) => e.period === period && (!installId || e.install_id === installId))
    .reduce((sum, e) => sum + e.amount_cents, 0);
}

/** Dollars (string from an input) -> whole cents, or null when invalid/negative. */
export function dollarsToCents(input: string): number | null {
  const t = input.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

export function centsToDollarsInput(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export function scopesAddedBy(installed: string[], next: string[]): string[] {
  return next.filter((s) => !installed.includes(s));
}

export function needsUpgrade(install: Pick<MarketplaceInstall, 'version_id'>, agent: Pick<MarketplaceAgent, 'current_version_id'>): boolean {
  return Boolean(agent.current_version_id) && agent.current_version_id !== install.version_id;
}

export function parseManifestInput(text: string): { ok: true; manifest: AgentManifest } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Manifest is not valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, error: 'Manifest must be a JSON object.' };
  const m = parsed as Record<string, unknown>;
  if (!Array.isArray(m.scopes) || m.scopes.length === 0 || !m.scopes.every((s) => typeof s === 'string')) {
    return { ok: false, error: 'manifest.scopes must be a non-empty array of strings.' };
  }
  if (!Array.isArray(m.triggers) || m.triggers.length === 0 || !m.triggers.every((s) => typeof s === 'string')) {
    return { ok: false, error: 'manifest.triggers must be a non-empty array of strings.' };
  }
  return { ok: true, manifest: parsed as AgentManifest };
}

export const MANIFEST_TEMPLATE = JSON.stringify(
  {
    scopes: ['read:jobs', 'act:record_insight'],
    triggers: ['job.scheduled', 'manual'],
    limits: { timeout_ms: 8000, max_actions: 3 },
  },
  null,
  2,
);

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

async function rows<T>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data as T[]) ?? [];
}

export const fetchScopes = () => rows<MarketplaceScope>(supabase.from('marketplace_scopes').select('*').order('kind').order('risk'));

export const fetchPublishedAgents = () =>
  rows<MarketplaceAgent>(supabase.from('marketplace_agents').select('*').eq('status', 'published').order('name'));

export const fetchMyPublishedAgents = (userId: string) =>
  rows<MarketplaceAgent>(supabase.from('marketplace_agents').select('*').eq('publisher_id', userId).order('created_at', { ascending: false }));

export const fetchVersionsForAgents = (agentIds: string[]) =>
  agentIds.length === 0
    ? Promise.resolve([] as MarketplaceVersion[])
    : rows<MarketplaceVersion>(supabase.from('marketplace_agent_versions').select('*').in('agent_id', agentIds).order('created_at', { ascending: false }));

export const fetchInstalls = () =>
  rows<MarketplaceInstall>(supabase.from('marketplace_agent_installs').select('*').neq('status', 'revoked').order('installed_at', { ascending: false }));

export const fetchRuns = (limit = 40) =>
  rows<MarketplaceRun>(supabase.from('marketplace_agent_runs').select('id, install_id, agent_id, trigger, status, summary, actions_proposed, actions_executed, actions_pending, actions_rejected, duration_ms, cost_cents, error, created_at').order('created_at', { ascending: false }).limit(limit));

export const fetchOutputs = (limit = 40) =>
  rows<MarketplaceOutput>(supabase.from('marketplace_agent_outputs').select('*').order('created_at', { ascending: false }).limit(limit));

export const fetchLedger = (limit = 200) =>
  rows<MarketplaceLedgerEntry>(supabase.from('marketplace_agent_ledger').select('*').order('created_at', { ascending: false }).limit(limit));

export const fetchAudit = (limit = 60) =>
  rows<MarketplaceAuditEntry>(supabase.from('marketplace_agent_audit').select('id, agent_id, install_id, event, detail, hash, created_at').order('id', { ascending: false }).limit(limit));

// ---------------------------------------------------------------------
// Writes (RPC only)
// ---------------------------------------------------------------------

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const installAgent = (agentId: string, scopes: string[], maxRunsPerDay: number, maxMonthlySpendCents: number) =>
  rpc<MarketplaceInstall>('install_marketplace_agent', {
    p_agent_id: agentId, p_granted_scopes: scopes, p_max_runs_per_day: maxRunsPerDay, p_max_monthly_spend_cents: maxMonthlySpendCents,
  });

export const updateInstall = (installId: string, scopes: string[], maxRunsPerDay: number, maxMonthlySpendCents: number, upgrade = false) =>
  rpc<MarketplaceInstall>('update_marketplace_install', {
    p_install_id: installId, p_granted_scopes: scopes, p_max_runs_per_day: maxRunsPerDay,
    p_max_monthly_spend_cents: maxMonthlySpendCents, p_upgrade: upgrade,
  });

export const setInstallStatus = (installId: string, status: 'active' | 'paused' | 'revoked') =>
  rpc<MarketplaceInstall>('set_marketplace_install_status', { p_install_id: installId, p_status: status });

export const verifyAuditChain = () => rpc<{ valid: boolean; checked: number; broken_at?: number }>('verify_marketplace_audit_chain');

export async function runAgentNow(installId: string): Promise<{ status: MarketplaceRun['status']; summary: string | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke('agent-runtime', { body: { action: 'run_now', installId } });
  if (error) throw new Error(error.message);
  const run = (data as { run?: { status: MarketplaceRun['status']; summary: string | null; error: string | null }; error?: string } | null);
  if (!run?.run) throw new Error(run?.error ?? 'The agent did not return a result.');
  return run.run;
}

export interface RegisterAgentInput {
  slug: string; publisherName: string; name: string; tagline: string; description: string;
  category: AgentCategory; endpointUrl: string; pricingModel: PricingModel; priceCents: number;
}

export const registerAgent = (i: RegisterAgentInput) =>
  rpc<{ agent_id: string; signing_secret: string }>('register_marketplace_agent', {
    p_slug: i.slug, p_publisher_name: i.publisherName, p_name: i.name, p_tagline: i.tagline, p_description: i.description,
    p_category: i.category, p_endpoint_url: i.endpointUrl, p_pricing_model: i.pricingModel, p_price_cents: i.priceCents,
  });

export const submitAgentVersion = (agentId: string, version: string, manifest: AgentManifest) =>
  rpc<MarketplaceVersion>('submit_marketplace_agent_version', { p_agent_id: agentId, p_version: version, p_manifest: manifest });

// Staff
export const fetchReviewQueue = () => rpc<ReviewQueueItem[]>('list_marketplace_review_queue');
export const reviewVersion = (versionId: string, approve: boolean, notes: string | null) =>
  rpc<MarketplaceVersion>('review_marketplace_agent_version', { p_version_id: versionId, p_approve: approve, p_notes: notes });
