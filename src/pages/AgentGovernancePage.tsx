import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Check, Clock, History, Loader2, Plus, ShieldCheck, Trash2, Undo2, Wallet, X } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { supabase } from '@/lib/supabase';

// ------------------------------------------------------------
// Types (mirror supabase/migrations/20261121000000_ai_agent_governance.sql)
// ------------------------------------------------------------

interface CatalogItem {
  slug: string;
  agent_source: string;
  label: string;
  category: string;
  is_reversible: boolean;
  has_cost: boolean;
  default_requires_approval: boolean;
}

interface Permission {
  action_slug: string;
  enabled: boolean;
  requires_approval: boolean | null;
  auto_approve_max_cents: number | null;
}

interface SpendingLimit {
  id: string;
  action_slug: string | null;
  period: 'daily' | 'weekly' | 'monthly';
  limit_cents: number;
}

type LogStatus = 'auto_approved' | 'pending_approval' | 'approved' | 'rejected' | 'executed' | 'failed' | 'rolled_back';

interface LogEntry {
  id: string;
  action_slug: string;
  agent_source: string;
  target_table: string | null;
  target_id: string | null;
  amount_cents: number | null;
  reasoning: string | null;
  payload: Record<string, unknown>;
  rollback_patch: Record<string, unknown> | null;
  status: LogStatus;
  decision_reason: string | null;
  error: string | null;
  created_at: string;
  decided_at: string | null;
  executed_at: string | null;
  rolled_back_at: string | null;
}

type Tab = 'queue' | 'permissions' | 'limits' | 'activity';

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';
const btnClass =
  'focus-ring inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-primary disabled:opacity-50';

const money = (cents: number | null | undefined): string =>
  cents == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : '—');

const errMsg = (e: unknown, fallback: string): string =>
  e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string'
    ? (e as { message: string }).message
    : fallback;

const STATUS_STYLE: Record<LogStatus, string> = {
  auto_approved: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  pending_approval: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  approved: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  rejected: 'bg-red-500/10 text-red-600 dark:text-red-400',
  executed: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-red-500/10 text-red-600 dark:text-red-400',
  rolled_back: 'bg-slate-500/10 text-slate-600 dark:text-slate-400',
};

function StatusBadge({ status }: { status: LogStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>{status.replace(/_/g, ' ')}</span>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Bot; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="mb-4 flex items-center gap-2">
        <Icon size={18} className="text-accent" />
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      </div>
      {children}
    </div>
  );
}

// ------------------------------------------------------------
// Page
// ------------------------------------------------------------

export function AgentGovernancePage() {
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('queue');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [limits, setLimits] = useState<SpendingLimit[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [rollbackTarget, setRollbackTarget] = useState<LogEntry | null>(null);
  const [limitForm, setLimitForm] = useState({ slug: '', period: 'monthly', amount: '' });
  const [autoMax, setAutoMax] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const [c, p, l, a] = await Promise.all([
        supabase.from('agent_action_catalog').select('*').order('label'),
        supabase.from('agent_permissions').select('action_slug, enabled, requires_approval, auto_approve_max_cents'),
        supabase.from('agent_spending_limits').select('id, action_slug, period, limit_cents').order('created_at'),
        supabase
          .from('agent_action_log')
          .select(
            'id, action_slug, agent_source, target_table, target_id, amount_cents, reasoning, payload, rollback_patch, status, decision_reason, error, created_at, decided_at, executed_at, rolled_back_at',
          )
          .order('created_at', { ascending: false })
          .limit(150),
      ]);
      const failed = c.error ?? p.error ?? l.error ?? a.error;
      if (failed) throw failed;
      setCatalog((c.data ?? []) as CatalogItem[]);
      setPermissions((p.data ?? []) as Permission[]);
      setLimits((l.data ?? []) as SpendingLimit[]);
      setLog((a.data ?? []) as LogEntry[]);
    } catch (e) {
      toast(errMsg(e, 'Could not load Agent Governance'), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const labelOf = useMemo(() => {
    const map = new Map(catalog.map((c) => [c.slug, c.label]));
    return (slug: string) => map.get(slug) ?? slug;
  }, [catalog]);

  const permissionOf = useCallback(
    (slug: string): Permission | undefined => permissions.find((p) => p.action_slug === slug),
    [permissions],
  );

  const pending = useMemo(() => log.filter((e) => e.status === 'pending_approval'), [log]);

  /** Runs one RPC, refreshes the data and reports the result. */
  const run = useCallback(
    async (key: string, fn: () => PromiseLike<{ error: unknown }>, success: string) => {
      setBusy(key);
      try {
        const { error } = await fn();
        if (error) throw error;
        toast(success, 'success');
        await load();
      } catch (e) {
        toast(errMsg(e, 'Something went wrong'), 'error');
      } finally {
        setBusy(null);
      }
    },
    [load, toast],
  );

  const decide = (entry: LogEntry, approve: boolean) =>
    run(
      `decide:${entry.id}`,
      () => supabase.rpc('decide_agent_action', { p_log_id: entry.id, p_approve: approve }),
      approve ? 'Action approved' : 'Action rejected',
    );

  const setEnabled = (slug: string, enabled: boolean) =>
    run(`perm:${slug}`, () => supabase.rpc('upsert_agent_permission', { p_action_slug: slug, p_enabled: enabled }), enabled ? 'Action enabled' : 'Action paused');

  const setApproval = (slug: string, value: 'default' | 'always' | 'never') =>
    run(
      `perm:${slug}`,
      () =>
        supabase.rpc('upsert_agent_permission', {
          p_action_slug: slug,
          p_requires_approval: value === 'always' ? true : value === 'never' ? false : null,
          p_clear_requires_approval: value === 'default',
        }),
      'Approval policy saved',
    );

  const saveAutoMax = (slug: string) => {
    const raw = (autoMax[slug] ?? '').trim();
    if (raw === '') {
      return run(`perm:${slug}`, () => supabase.rpc('upsert_agent_permission', { p_action_slug: slug, p_clear_auto_approve_max: true }), 'Auto-approve limit cleared');
    }
    const dollars = Number(raw);
    if (!Number.isFinite(dollars) || dollars < 0) {
      toast('Enter a valid amount', 'error');
      return Promise.resolve();
    }
    return run(
      `perm:${slug}`,
      () => supabase.rpc('upsert_agent_permission', { p_action_slug: slug, p_auto_approve_max_cents: Math.round(dollars * 100) }),
      'Auto-approve limit saved',
    );
  };

  const addLimit = async () => {
    const dollars = Number(limitForm.amount);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      toast('Enter an amount greater than zero', 'error');
      return;
    }
    await run(
      'limit:add',
      () =>
        supabase.rpc('upsert_agent_spending_limit', {
          p_action_slug: limitForm.slug === '' ? null : limitForm.slug,
          p_period: limitForm.period,
          p_limit_cents: Math.round(dollars * 100),
        }),
      'Spending limit saved',
    );
    setLimitForm((f) => ({ ...f, amount: '' }));
  };

  const confirmRollback = async () => {
    const target = rollbackTarget;
    setRollbackTarget(null);
    if (!target) return;
    await run(`rollback:${target.id}`, () => supabase.rpc('rollback_agent_action', { p_log_id: target.id }), 'Action rolled back');
  };

  const tabs: Array<{ id: Tab; label: string; icon: typeof Bot; count?: number }> = [
    { id: 'queue', label: 'Approval queue', icon: Clock, count: pending.length },
    { id: 'permissions', label: 'Permissions', icon: ShieldCheck },
    { id: 'limits', label: 'Spending limits', icon: Wallet },
    { id: 'activity', label: 'Activity', icon: History },
  ];

  if (loading) {
    return (
      <DashboardLayout activeLabel="Agent Governance">
        <BackButton fallback="/dashboard" />
        <div className="flex justify-center py-24">
          <Loader2 className="h-6 w-6 animate-spin text-accent" aria-label="Loading" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Agent Governance">
      <BackButton fallback="/dashboard" />
      <div className="mx-auto max-w-5xl space-y-6 pb-12">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-text-primary">
            <Bot size={24} className="text-accent" /> Agent Governance
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            Decide what your autonomous agents may do, how much they may spend, and review or undo what they did.
          </p>
        </header>

        <div role="tablist" aria-label="Agent governance sections" className="flex flex-wrap gap-1 border-b border-border">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`focus-ring -mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === t.id ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              <t.icon size={15} /> {t.label}
              {t.count ? <span className="rounded-full bg-amber-500/15 px-1.5 text-xs text-amber-600 dark:text-amber-400">{t.count}</span> : null}
            </button>
          ))}
        </div>

        {tab === 'queue' && (
          <Section title="Waiting for your approval" icon={Clock}>
            {pending.length === 0 ? (
              <p className="text-sm text-text-secondary">Nothing is waiting. Agents will appear here when an action needs a human decision.</p>
            ) : (
              <ul className="space-y-3">
                {pending.map((e) => (
                  <li key={e.id} className="rounded-xl border border-border bg-bg-primary p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-text-primary">{labelOf(e.action_slug)}</p>
                        <p className="text-xs text-text-secondary">
                          {e.agent_source} · {when(e.created_at)}
                          {e.amount_cents != null ? ` · ${money(e.amount_cents)}` : ''}
                        </p>
                        {e.reasoning && <p className="mt-2 text-sm text-text-primary">{e.reasoning}</p>}
                        <details className="mt-2 text-xs text-text-secondary">
                          <summary className="cursor-pointer">Details</summary>
                          <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-bg-secondary p-2">{JSON.stringify(e.payload, null, 2)}</pre>
                        </details>
                      </div>
                      <div className="flex gap-2">
                        <button className={btnClass} disabled={busy === `decide:${e.id}`} onClick={() => void decide(e, true)}>
                          <Check size={15} className="text-emerald-600" /> Approve
                        </button>
                        <button className={btnClass} disabled={busy === `decide:${e.id}`} onClick={() => void decide(e, false)}>
                          <X size={15} className="text-red-600" /> Reject
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        {tab === 'permissions' && (
          <Section title="What each agent may do" icon={ShieldCheck}>
            <ul className="divide-y divide-border">
              {catalog.map((c) => {
                const perm = permissionOf(c.slug);
                const enabled = perm?.enabled ?? true;
                const approval = perm?.requires_approval == null ? 'default' : perm.requires_approval ? 'always' : 'never';
                const effective = perm?.requires_approval ?? c.default_requires_approval;
                const saving = busy === `perm:${c.slug}`;
                return (
                  <li key={c.slug} className="space-y-3 py-4 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-text-primary">{c.label}</p>
                        <p className="text-xs text-text-secondary">
                          {c.agent_source} · {c.category}
                          {c.has_cost ? ' · costs money' : ''}
                          {c.is_reversible ? ' · reversible' : ''}
                        </p>
                      </div>
                      <button
                        role="switch"
                        aria-checked={enabled}
                        aria-label={`${c.label} enabled`}
                        disabled={saving}
                        onClick={() => void setEnabled(c.slug, !enabled)}
                        className={`focus-ring relative h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${enabled ? 'bg-accent' : 'bg-border'}`}
                      >
                        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
                      </button>
                    </div>
                    {enabled && (
                      <div className="flex flex-wrap items-end gap-3">
                        <label className="text-xs text-text-secondary">
                          Human approval
                          <select
                            className={`${inputClass} mt-1 w-56`}
                            value={approval}
                            disabled={saving}
                            onChange={(ev) => void setApproval(c.slug, ev.target.value as 'default' | 'always' | 'never')}
                          >
                            <option value="default">Default ({c.default_requires_approval ? 'required' : 'not required'})</option>
                            <option value="always">Always required</option>
                            <option value="never">Never required</option>
                          </select>
                        </label>
                        {c.has_cost && effective && (
                          <label className="text-xs text-text-secondary">
                            Auto-approve up to (USD)
                            <div className="mt-1 flex gap-2">
                              <input
                                className={`${inputClass} w-32`}
                                inputMode="decimal"
                                placeholder="No limit"
                                value={autoMax[c.slug] ?? (perm?.auto_approve_max_cents != null ? String(perm.auto_approve_max_cents / 100) : '')}
                                onChange={(ev) => setAutoMax((m) => ({ ...m, [c.slug]: ev.target.value }))}
                              />
                              <button className={btnClass} disabled={saving} onClick={() => void saveAutoMax(c.slug)}>
                                Save
                              </button>
                            </div>
                          </label>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {tab === 'limits' && (
          <Section title="Spending limits" icon={Wallet}>
            <p className="mb-4 text-sm text-text-secondary">
              A limit always wins: an action that would go over it is stopped, even if it is set to auto-approve.
            </p>
            <div className="mb-5 flex flex-wrap items-end gap-3">
              <label className="text-xs text-text-secondary">
                Applies to
                <select className={`${inputClass} mt-1 w-56`} value={limitForm.slug} onChange={(ev) => setLimitForm((f) => ({ ...f, slug: ev.target.value }))}>
                  <option value="">All paid actions</option>
                  {catalog
                    .filter((c) => c.has_cost)
                    .map((c) => (
                      <option key={c.slug} value={c.slug}>
                        {c.label}
                      </option>
                    ))}
                </select>
              </label>
              <label className="text-xs text-text-secondary">
                Period
                <select className={`${inputClass} mt-1 w-36`} value={limitForm.period} onChange={(ev) => setLimitForm((f) => ({ ...f, period: ev.target.value }))}>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label className="text-xs text-text-secondary">
                Limit (USD)
                <input
                  className={`${inputClass} mt-1 w-32`}
                  inputMode="decimal"
                  placeholder="500"
                  value={limitForm.amount}
                  onChange={(ev) => setLimitForm((f) => ({ ...f, amount: ev.target.value }))}
                />
              </label>
              <button className={btnClass} disabled={busy === 'limit:add'} onClick={() => void addLimit()}>
                <Plus size={15} /> Save limit
              </button>
            </div>
            {limits.length === 0 ? (
              <p className="text-sm text-text-secondary">No limits yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {limits.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <p className="text-sm text-text-primary">
                      <span className="font-medium">{money(l.limit_cents)}</span> {l.period} ·{' '}
                      <span className="text-text-secondary">{l.action_slug ? labelOf(l.action_slug) : 'All paid actions'}</span>
                    </p>
                    <button
                      aria-label="Delete limit"
                      className="focus-ring rounded-lg p-1.5 text-danger hover:bg-bg-primary disabled:opacity-50"
                      disabled={busy === `limit:${l.id}`}
                      onClick={() => void run(`limit:${l.id}`, () => supabase.rpc('delete_agent_spending_limit', { p_id: l.id }), 'Limit removed')}
                    >
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        {tab === 'activity' && (
          <Section title="Recent agent activity" icon={History}>
            {log.length === 0 ? (
              <p className="text-sm text-text-secondary">No agent has acted yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {log.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-text-primary">{labelOf(e.action_slug)}</p>
                        <StatusBadge status={e.status} />
                      </div>
                      <p className="text-xs text-text-secondary">
                        {e.agent_source} · {when(e.created_at)}
                        {e.amount_cents != null ? ` · ${money(e.amount_cents)}` : ''}
                      </p>
                      {e.reasoning && <p className="mt-1 text-sm text-text-secondary">{e.reasoning}</p>}
                      {e.error && <p className="mt-1 text-sm text-danger">{e.error}</p>}
                    </div>
                    {e.status === 'executed' && e.rollback_patch && (
                      <button className={btnClass} disabled={busy === `rollback:${e.id}`} onClick={() => setRollbackTarget(e)}>
                        <Undo2 size={15} /> Roll back
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
      </div>

      <ConfirmDialog
        open={rollbackTarget !== null}
        title="Roll back this action?"
        description={rollbackTarget ? `This restores the previous values changed by “${labelOf(rollbackTarget.action_slug)}”. Messages or calls already sent cannot be recalled.` : ''}
        confirmLabel="Roll back"
        onConfirm={confirmRollback}
        onCancel={() => setRollbackTarget(null)}
      />
    </DashboardLayout>
  );
}
