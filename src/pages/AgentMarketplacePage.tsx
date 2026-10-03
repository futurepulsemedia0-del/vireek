/**
 * AI Agent Marketplace — /dashboard/agent-marketplace
 *
 * Install first-party or third-party agents under explicit permissions,
 * run caps and spend caps. Every action an agent proposes still passes
 * Agent Governance (approvals / limits / audit); the activity, billing and
 * tamper-evident audit views live here too. See
 * supabase/migrations/20270210000000_agent_marketplace.sql.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Blocks, CheckCircle2, Loader2, Pause, Play, Search, ShieldCheck, ShieldX, Sparkles, Trash2, Zap } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { formatCents } from '@/lib/agentGovernance';
import { InstallDialog } from '@/components/agent-marketplace/InstallDialog';
import { PublisherPanel } from '@/components/agent-marketplace/PublisherPanel';
import {
  CATEGORY_LABELS,
  currentPeriod,
  fetchAudit,
  fetchInstalls,
  fetchLedger,
  fetchOutputs,
  fetchPublishedAgents,
  fetchRuns,
  fetchScopes,
  fetchVersionsForAgents,
  formatPrice,
  installAgent,
  needsUpgrade,
  runAgentNow,
  setInstallStatus,
  spendForPeriod,
  updateInstall,
  verifyAuditChain,
  type AgentCategory,
  type MarketplaceAgent,
  type MarketplaceAuditEntry,
  type MarketplaceInstall,
  type MarketplaceLedgerEntry,
  type MarketplaceOutput,
  type MarketplaceRun,
  type MarketplaceScope,
  type MarketplaceVersion,
} from '@/lib/agentMarketplace';

type Tab = 'catalog' | 'installed' | 'activity' | 'billing' | 'audit' | 'publish';
const TABS: { id: Tab; label: string }[] = [
  { id: 'catalog', label: 'Catalog' },
  { id: 'installed', label: 'Installed' },
  { id: 'activity', label: 'Activity' },
  { id: 'billing', label: 'Billing' },
  { id: 'audit', label: 'Audit' },
  { id: 'publish', label: 'Publish' },
];

const RUN_STYLES: Record<string, string> = {
  queued: 'bg-bg-tertiary text-text-secondary',
  running: 'bg-accent/10 text-accent',
  succeeded: 'bg-success-500/10 text-success-500',
  partial: 'bg-warning-500/10 text-warning-500',
  failed: 'bg-danger/10 text-danger',
  blocked: 'bg-bg-tertiary text-text-secondary',
};
const SEVERITY_STYLES: Record<string, string> = {
  info: 'bg-accent/10 text-accent',
  warning: 'bg-warning-500/10 text-warning-500',
  critical: 'bg-danger/10 text-danger',
};

type DialogState =
  | { mode: 'install'; agent: MarketplaceAgent }
  | { mode: 'edit'; agent: MarketplaceAgent; install: MarketplaceInstall; upgrade: boolean }
  | null;

export function AgentMarketplacePage() {
  const { toast } = useToast();
  const { user, permissions, isOwner } = useAuth();
  const canManage = isOwner || permissions.can_manage_security;

  const [tab, setTab] = useState<Tab>('catalog');
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<MarketplaceAgent[]>([]);
  const [versions, setVersions] = useState<MarketplaceVersion[]>([]);
  const [scopes, setScopes] = useState<MarketplaceScope[]>([]);
  const [installs, setInstalls] = useState<MarketplaceInstall[]>([]);
  const [runs, setRuns] = useState<MarketplaceRun[]>([]);
  const [outputs, setOutputs] = useState<MarketplaceOutput[]>([]);
  const [ledger, setLedger] = useState<MarketplaceLedgerEntry[]>([]);
  const [audit, setAudit] = useState<MarketplaceAuditEntry[]>([]);
  const [chain, setChain] = useState<{ valid: boolean; checked: number; broken_at?: number } | null>(null);

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<AgentCategory | 'all'>('all');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [revoking, setRevoking] = useState<MarketplaceInstall | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, s, i, r, o, l, au] = await Promise.all([
        fetchPublishedAgents(), fetchScopes(), fetchInstalls(), fetchRuns(), fetchOutputs(), fetchLedger(), fetchAudit(),
      ]);
      setAgents(a);
      setScopes(s);
      setInstalls(i);
      setRuns(r);
      setOutputs(o);
      setLedger(l);
      setAudit(au);
      const versionIds = new Set([...a.map((x) => x.current_version_id), ...i.map((x) => x.version_id)].filter(Boolean) as string[]);
      const all = await fetchVersionsForAgents([...new Set([...a.map((x) => x.id), ...i.map((x) => x.agent_id)])]);
      setVersions(all.filter((v) => versionIds.has(v.id)));
    } catch {
      toast('Could not load the Agent Marketplace.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const versionById = useMemo(() => new Map(versions.map((v) => [v.id, v])), [versions]);
  const installedAgentIds = useMemo(() => new Set(installs.map((i) => i.agent_id)), [installs]);
  const scopeLabel = useMemo(() => new Map(scopes.map((s) => [s.slug, s.label])), [scopes]);
  const period = currentPeriod();
  const monthSpend = spendForPeriod(ledger, period);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) =>
      (category === 'all' || a.category === category) &&
      (!q || a.name.toLowerCase().includes(q) || a.tagline.toLowerCase().includes(q) || a.publisher_name.toLowerCase().includes(q)),
    );
  }, [agents, query, category]);

  const dialogVersion = useMemo(() => {
    if (!dialog) return null;
    // Editing without upgrading must show the version the install actually runs.
    const id = dialog.mode === 'edit' && !dialog.upgrade ? dialog.install.version_id : dialog.agent.current_version_id;
    return versionById.get(id ?? '') ?? null;
  }, [dialog, versionById]);

  const handleDialogSubmit = async (v: { scopes: string[]; maxRunsPerDay: number; maxMonthlySpendCents: number }) => {
    if (!dialog) return;
    if (dialog.mode === 'install') {
      await installAgent(dialog.agent.id, v.scopes, v.maxRunsPerDay, v.maxMonthlySpendCents);
      toast(`${dialog.agent.name} installed.`, 'success');
      setTab('installed');
    } else {
      await updateInstall(dialog.install.id, v.scopes, v.maxRunsPerDay, v.maxMonthlySpendCents, dialog.upgrade);
      toast('Permissions saved.', 'success');
    }
    setDialog(null);
    await load();
  };

  const handleStatus = async (install: MarketplaceInstall, status: 'active' | 'paused') => {
    try {
      await setInstallStatus(install.id, status);
      toast(status === 'paused' ? 'Agent paused.' : 'Agent resumed.', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update this agent.', 'error');
    }
  };

  const handleRevoke = async () => {
    if (!revoking) return;
    try {
      await setInstallStatus(revoking.id, 'revoked');
      toast('Agent removed.', 'success');
      setRevoking(null);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove this agent.', 'error');
    }
  };

  const handleRun = async (install: MarketplaceInstall) => {
    setRunning(install.id);
    try {
      const res = await runAgentNow(install.id);
      if (res.status === 'failed' || res.status === 'blocked') toast(res.error ?? 'The run did not complete.', 'error');
      else toast(res.summary ?? 'Run finished.', 'success');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'The run failed.', 'error');
    } finally {
      setRunning(null);
    }
  };

  const handleVerify = async () => {
    try {
      setChain(await verifyAuditChain());
    } catch {
      toast('Could not verify the audit trail.', 'error');
    }
  };

  if (loading) {
    return <DashboardLayout activeLabel="Agent Marketplace"><div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div></DashboardLayout>;
  }

  const card = 'rounded-2xl border border-border bg-bg-secondary p-5';
  const pill = 'rounded-full px-2.5 py-0.5 text-xs font-medium';

  return (
    <DashboardLayout activeLabel="Agent Marketplace">
      <div className="space-y-6 p-6">
        <div>
          <div className="flex items-center gap-2"><Blocks className="text-cta" size={20} /><p className="text-sm font-semibold text-text-primary">AI Agent Marketplace</p></div>
          <p className="mt-1 text-sm text-text-secondary">
            Install specialist agents with exactly the permissions you choose. Every action still goes through Agent Governance, and everything is logged.
          </p>
        </div>

        <div role="tablist" aria-label="Agent Marketplace sections" className="flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`focus-ring rounded-xl px-3.5 py-1.5 text-sm font-medium ${tab === t.id ? 'bg-cta text-white' : 'bg-bg-secondary text-text-secondary hover:bg-bg-tertiary'}`}
            >
              {t.label}{t.id === 'installed' && installs.length > 0 ? ` (${installs.length})` : ''}
            </button>
          ))}
        </div>

        {!canManage && tab !== 'publish' && (
          <p className="rounded-xl bg-warning-500/10 p-3 text-xs text-warning-500">You can browse and view activity. Installing or changing agents requires the account owner or a member with security permission.</p>
        )}

        {tab === 'catalog' && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[200px] flex-1">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" />
                <input aria-label="Search agents" className="focus-ring w-full rounded-xl border border-border bg-bg-secondary py-2 pl-9 pr-3 text-sm text-text-primary" placeholder="Search agents" value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
              <select aria-label="Category" className="focus-ring rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary" value={category} onChange={(e) => setCategory(e.target.value as AgentCategory | 'all')}>
                <option value="all">All categories</option>
                {(Object.keys(CATEGORY_LABELS) as AgentCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
              </select>
            </div>
            {filtered.length === 0 ? (
              <p className="text-sm text-text-secondary">No agents match your search.</p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((a) => {
                  const v = versionById.get(a.current_version_id ?? '');
                  const installed = installedAgentIds.has(a.id);
                  return (
                    <div key={a.id} className={`${card} flex flex-col`}>
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold text-text-primary">{a.name}</p>
                        <span className={`${pill} bg-bg-tertiary text-text-secondary`}>{CATEGORY_LABELS[a.category]}</span>
                      </div>
                      <p className="mb-1 text-xs text-text-secondary">
                        {a.publisher_id === null ? <span className="inline-flex items-center gap-1"><ShieldCheck size={11} className="text-cta" /> Built by Vireek</span> : <>by {a.publisher_name} · reviewed by Vireek</>}
                      </p>
                      <p className="mb-3 flex-1 text-sm text-text-secondary">{a.tagline}</p>
                      {v && (
                        <div className="mb-3 flex flex-wrap gap-1">
                          {v.manifest.scopes.map((s) => <span key={s} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-secondary">{scopeLabel.get(s) ?? s}</span>)}
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-text-primary">{formatPrice(a)}</span>
                        {installed ? (
                          <span className="flex items-center gap-1 text-xs font-medium text-success-500"><CheckCircle2 size={13} /> Installed</span>
                        ) : (
                          <button disabled={!canManage || !v} onClick={() => setDialog({ mode: 'install', agent: a })} className="focus-ring rounded-xl bg-cta px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">Review & install</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {tab === 'installed' && (
          installs.length === 0 ? (
            <p className="text-sm text-text-secondary">No agents installed yet. Browse the catalog to add your first one.</p>
          ) : (
            <div className="space-y-3">
              {installs.map((i) => {
                const a = agentById.get(i.agent_id);
                const v = versionById.get(i.version_id);
                const upgrade = a ? needsUpgrade(i, a) : false;
                const spent = spendForPeriod(ledger, period, i.id);
                return (
                  <div key={i.id} className={card}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-text-primary">{a?.name ?? 'Agent no longer listed'} {v && <span className="text-xs font-normal text-text-secondary">v{v.version}</span>}</p>
                        <p className="text-xs text-text-secondary">{i.max_runs_per_day} runs/day · cap {formatCents(i.max_monthly_spend_cents)}/mo · spent {formatCents(spent)} this month</p>
                      </div>
                      <span className={`${pill} ${i.status === 'active' ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}>{i.status}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {i.granted_scopes.map((s) => <span key={s} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] text-text-secondary">{scopeLabel.get(s) ?? s}</span>)}
                    </div>
                    {upgrade && <p className="mt-2 text-xs text-warning-500">A new version is available. Upgrading shows you any new permissions first.</p>}
                    {canManage && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {i.status === 'active' && (
                          <button disabled={running === i.id} onClick={() => handleRun(i)} className="focus-ring flex items-center gap-1.5 rounded-xl bg-cta px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
                            {running === i.id ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />} Run now
                          </button>
                        )}
                        {a && <button onClick={() => setDialog({ mode: 'edit', agent: a, install: i, upgrade })} className="focus-ring rounded-xl bg-bg-tertiary px-3 py-1.5 text-xs font-medium text-text-secondary">{upgrade ? 'Review upgrade' : 'Permissions & limits'}</button>}
                        {i.status === 'active'
                          ? <button onClick={() => handleStatus(i, 'paused')} className="focus-ring flex items-center gap-1.5 rounded-xl bg-bg-tertiary px-3 py-1.5 text-xs font-medium text-text-secondary"><Pause size={12} /> Pause</button>
                          : <button onClick={() => handleStatus(i, 'active')} className="focus-ring flex items-center gap-1.5 rounded-xl bg-bg-tertiary px-3 py-1.5 text-xs font-medium text-text-secondary"><Play size={12} /> Resume</button>}
                        <button onClick={() => setRevoking(i)} className="focus-ring flex items-center gap-1.5 rounded-xl bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger"><Trash2 size={12} /> Remove</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        )}

        {tab === 'activity' && (
          <div className="grid gap-6 lg:grid-cols-2">
            <div className={card}>
              <p className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary"><Sparkles size={15} className="text-cta" /> Agent insights</p>
              {outputs.length === 0 ? <p className="text-sm text-text-secondary">No insights yet.</p> : (
                <div className="space-y-2">
                  {outputs.map((o) => (
                    <div key={o.id} className="rounded-xl border border-border bg-bg-primary p-3">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-text-primary">{o.title}</p>
                        <span className={`${pill} ${SEVERITY_STYLES[o.severity]}`}>{o.severity}</span>
                      </div>
                      <p className="whitespace-pre-line text-xs text-text-secondary">{o.body}</p>
                      <p className="mt-1 text-[10px] text-text-secondary">{agentById.get(installs.find((x) => x.id === o.install_id)?.agent_id ?? '')?.name ?? 'Agent'} · {new Date(o.created_at).toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className={card}>
              <p className="mb-3 text-sm font-semibold text-text-primary">Recent runs</p>
              {runs.length === 0 ? <p className="text-sm text-text-secondary">No runs yet.</p> : (
                <div className="space-y-2">
                  {runs.map((r) => (
                    <div key={r.id} className="rounded-xl border border-border bg-bg-primary p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium text-text-primary">{agentById.get(r.agent_id)?.name ?? 'Agent'} <span className="font-normal text-text-secondary">· {r.trigger}</span></p>
                        <span className={`${pill} ${RUN_STYLES[r.status]}`}>{r.status}</span>
                      </div>
                      {r.summary && <p className="mt-1 text-text-secondary">{r.summary}</p>}
                      {r.error && <p className="mt-1 text-danger">{r.error}</p>}
                      <p className="mt-1 text-[10px] text-text-secondary">
                        {r.actions_executed} done · {r.actions_pending} awaiting approval · {r.actions_rejected} blocked{r.cost_cents > 0 ? ` · ${formatCents(r.cost_cents)}` : ''} · {new Date(r.created_at).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-3 text-[11px] text-text-secondary">Actions awaiting approval appear in Agent Governance → approval queue.</p>
            </div>
          </div>
        )}

        {tab === 'billing' && (
          <div className="space-y-4">
            <div className={card}>
              <p className="text-xs text-text-secondary">Agent charges this month ({period})</p>
              <p className="text-2xl font-semibold text-text-primary">{formatCents(monthSpend)}</p>
              <p className="mt-1 text-[11px] text-text-secondary">Charges are metered per install and can never exceed the monthly cap you set. This is a usage ledger; it does not itself charge your card.</p>
            </div>
            <div className={card}>
              <p className="mb-3 text-sm font-semibold text-text-primary">Ledger</p>
              {ledger.length === 0 ? <p className="text-sm text-text-secondary">No charges yet. Free agents never appear here.</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-text-secondary"><tr><th className="pb-2 pr-3 font-medium">Date</th><th className="pb-2 pr-3 font-medium">Agent</th><th className="pb-2 pr-3 font-medium">Type</th><th className="pb-2 text-right font-medium">Amount</th></tr></thead>
                    <tbody>
                      {ledger.map((l) => (
                        <tr key={l.id} className="border-t border-border text-text-primary">
                          <td className="py-2 pr-3">{new Date(l.created_at).toLocaleDateString()}</td>
                          <td className="py-2 pr-3">{agentById.get(l.agent_id)?.name ?? 'Agent'}</td>
                          <td className="py-2 pr-3">{l.entry_type}</td>
                          <td className="py-2 text-right">{formatCents(l.amount_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'audit' && (
          <div className={card}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-text-primary">Tamper-evident audit trail</p>
              <button onClick={handleVerify} className="focus-ring flex items-center gap-1.5 rounded-xl bg-bg-tertiary px-3 py-1.5 text-xs font-medium text-text-secondary"><ShieldCheck size={12} /> Verify integrity</button>
            </div>
            {chain && (
              <p role="status" className={`mb-3 flex items-center gap-2 rounded-xl p-3 text-xs ${chain.valid ? 'bg-success-500/10 text-success-500' : 'bg-danger/10 text-danger'}`}>
                {chain.valid ? <ShieldCheck size={14} /> : <ShieldX size={14} />}
                {chain.valid ? `Verified: ${chain.checked} entries, hash chain intact.` : `Chain broken at entry #${chain.broken_at}. Contact support.`}
              </p>
            )}
            {audit.length === 0 ? <p className="text-sm text-text-secondary">No events yet.</p> : (
              <div className="space-y-1.5">
                {audit.map((e) => (
                  <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs">
                    <span className="font-medium text-text-primary">{e.event.replace(/_/g, ' ')} <span className="font-normal text-text-secondary">· {agentById.get(e.agent_id ?? '')?.name ?? 'Agent'}</span></span>
                    <span className="text-[10px] text-text-secondary">{new Date(e.created_at).toLocaleString()} · {e.hash.slice(0, 8)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'publish' && user && <PublisherPanel userId={user.id} />}
      </div>

      <InstallDialog
        open={dialog !== null}
        agent={dialog?.agent ?? null}
        version={dialogVersion}
        scopes={scopes}
        install={dialog?.mode === 'edit' ? dialog.install : null}
        onCancel={() => setDialog(null)}
        onSubmit={handleDialogSubmit}
      />

      <ConfirmDialog
        open={revoking !== null}
        title="Remove this agent?"
        description="It stops immediately and queued runs are cancelled. Its history stays in your audit trail."
        confirmLabel="Remove agent"
        onConfirm={handleRevoke}
        onCancel={() => setRevoking(null)}
      />
    </DashboardLayout>
  );
}
