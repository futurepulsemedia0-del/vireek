import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Landmark, RefreshCw, Plus, Sparkles, Check, EyeOff, Undo2, TriangleAlert, Unplug, PiggyBank, Flame, ArrowRight } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { supabase } from '@/lib/supabase';
import {
  BankAccount, BankConnection, BankTxn, HIGH_CONFIDENCE, EXPENSE_CATEGORIES, INCOME_CATEGORIES, MATCH_LABEL,
  applyReconciliation, bankApi, headline, money, openPlaidLink, setIgnored, summarizeBank,
} from '@/lib/bankIntelligence';

type Tab = 'review' | 'reconciled' | 'ignored';
const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

export function BankIntelligencePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [connections, setConnections] = useState<BankConnection[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [txns, setTxns] = useState<BankTxn[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | 'connect' | 'sync' | 'forecast' | 'bulk'>(null);
  const [working, setWorking] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<Tab>('review');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [disconnecting, setDisconnecting] = useState<BankConnection | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!user) return;
    if (!quiet) setLoading(true);
    const [c, a, t] = await Promise.all([
      supabase.from('bank_connections').select('id, institution_name, status, last_synced_at, last_error').neq('status', 'disconnected').order('created_at'),
      supabase.from('bank_accounts').select('id, connection_id, name, mask, account_type, subtype, current_balance_cents, available_balance_cents, is_active').eq('is_active', true).order('name'),
      supabase.from('bank_transactions')
        .select('id, account_id, posted_date, amount_cents, description, merchant_name, category_code, category_label, category_source, match_status, match_type, match_refs, match_confidence, match_reason, needs_review')
        .eq('pending', false).order('posted_date', { ascending: false }).order('created_at', { ascending: false }).limit(500),
    ]);
    if (c.error || a.error || t.error) toast('Could not load bank data.', 'error');
    setConnections((c.data ?? []) as BankConnection[]);
    setAccounts((a.data ?? []) as BankAccount[]);
    setTxns(((t.data ?? []) as BankTxn[]).map((r) => ({ ...r, amount_cents: Number(r.amount_cents), match_refs: r.match_refs ?? [] })));
    setLoading(false);
  }, [user, toast]);

  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => summarizeBank(txns), [txns]);
  const visible = useMemo(() => txns.filter((t) => (tab === 'review' ? t.match_status === 'unmatched' || t.match_status === 'suggested' : t.match_status === tab)), [txns, tab]);
  const accountName = useMemo(() => new Map(accounts.map((a) => [a.id, `${a.name}${a.mask ? ` ••${a.mask}` : ''}`])), [accounts]);
  const cash = accounts.filter((a) => a.account_type === 'depository').reduce((s, a) => s + (a.available_balance_cents ?? a.current_balance_cents ?? 0), 0);
  const bulkItems = useMemo(() => txns.filter((t) => t.match_status === 'suggested' && t.match_type && (t.match_confidence ?? 0) >= HIGH_CONFIDENCE), [txns]);

  const connect = async (connectionId?: string) => {
    setBusy('connect');
    try {
      const { link_token } = await bankApi<{ link_token: string }>('link_token', connectionId ? { connection_id: connectionId } : {});
      await openPlaidLink({
        linkToken: link_token,
        onSuccess: async (publicToken, inst) => {
          try {
            if (connectionId) await bankApi('reconnected', { connection_id: connectionId });
            else await bankApi('exchange', { public_token: publicToken, institution_name: inst.name, institution_id: inst.id });
            await bankApi('analyze');
            toast(`${inst.name} connected. Transactions will appear as your bank delivers them.`, 'success');
            await load(true);
          } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(null); }
        },
        onExit: (message) => { setBusy(null); if (message) toast(message, 'error'); },
      });
    } catch (e) { toast(errMsg(e), 'error'); setBusy(null); }
  };

  const syncNow = async () => {
    setBusy('sync');
    try {
      const r = await bankApi<{ sync: { added: number; modified: number; errors: string[] }; analysis: { suggested: number; high_confidence: number } }>('sync');
      if (r.sync.errors.length) toast(r.sync.errors[0], 'error');
      else toast(`${r.sync.added} new transaction${r.sync.added === 1 ? '' : 's'}. ${r.analysis.suggested} suggestion${r.analysis.suggested === 1 ? '' : 's'} ready.`, 'success');
      await load(true);
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(null); }
  };

  const syncForecast = async () => {
    setBusy('forecast');
    try {
      const r = await bankApi<{ starting_cash_balance: number }>('sync_forecast_cash');
      toast(`Cash Flow Forecast now starts from ${money(Math.round(r.starting_cash_balance * 100))}. Re-run the forecast to refresh it.`, 'success');
    } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(null); }
  };

  const mark = (id: string, on: boolean) => setWorking((p) => { const n = new Set(p); if (on) n.add(id); else n.delete(id); return n; });

  const approve = async (t: BankTxn) => {
    mark(t.id, true);
    try {
      await applyReconciliation(t.id, draft[t.id]);
      setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== t.id)));
      toast('Posted to your books.', 'success');
      await load(true);
    } catch (e) { toast(errMsg(e), 'error'); } finally { mark(t.id, false); }
  };

  const toggleIgnore = async (t: BankTxn, ignore: boolean) => {
    mark(t.id, true);
    try { await setIgnored(t.id, ignore); await load(true); } catch (e) { toast(errMsg(e), 'error'); } finally { mark(t.id, false); }
  };

  const runBulk = async () => {
    setConfirmBulk(false);
    setBusy('bulk');
    let ok = 0, failed = 0;
    for (const t of bulkItems) {
      try { await applyReconciliation(t.id); ok++; } catch { failed++; }
    }
    toast(failed ? `${ok} posted, ${failed} need a manual look.` : `${ok} transaction${ok === 1 ? '' : 's'} reconciled.`, failed ? 'error' : 'success');
    await load(true);
    setBusy(null);
  };

  const disconnect = async () => {
    if (!disconnecting) return;
    try { await bankApi('disconnect', { connection_id: disconnecting.id }); toast('Bank disconnected. Your reconciled history stays in your books.', 'success'); await load(true); }
    catch (e) { toast(errMsg(e), 'error'); }
    setDisconnecting(null);
  };

  const pct = summary.total ? Math.round((summary.reconciled / summary.total) * 100) : 0;
  const hasBank = connections.length > 0;
  const btn = 'focus-ring flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60';

  return (
    <DashboardLayout activeLabel="Direct Bank Intelligence">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Landmark size={24} /></span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Direct Bank Intelligence</h1>
            <p className="text-sm text-text-secondary">Bank → categorize → match invoices → reconcile → forecast → act.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {hasBank && (
            <button onClick={syncNow} disabled={busy !== null} className={`${btn} border border-border text-text-primary hover:bg-bg-secondary`}>
              <RefreshCw size={16} className={busy === 'sync' ? 'animate-spin' : ''} /> Sync & analyze
            </button>
          )}
          <button onClick={() => connect()} disabled={busy !== null} className={`${btn} bg-accent text-white hover:opacity-90`}>
            <Plus size={16} /> {hasBank ? 'Add another bank' : 'Connect your bank'}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : !hasBank ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center">
          <Landmark size={32} className="mx-auto mb-3 text-accent" />
          <h2 className="text-lg font-semibold text-text-primary">Connect a bank account to close the loop</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-text-secondary">
            Vireek reads your transactions securely through Plaid (read-only), categorizes them, matches deposits to open invoices, and proposes the reconciliation. Nothing posts to your books until you approve it.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Cash intelligence">
            <p className="text-lg font-semibold leading-snug text-text-primary">{headline(summary)}</p>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                ['Bank cash', money(cash)],
                ['Reconciled', `${pct}%`],
                ['Awaiting approval', String(summary.suggested)],
                ['Ready to auto-approve', String(summary.highConfidence)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-border bg-bg-primary p-3">
                  <p className="text-xs text-text-secondary">{label}</p>
                  <p className="mt-0.5 text-xl font-bold text-text-primary">{value}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={syncForecast} disabled={busy !== null} className={`${btn} border border-border text-text-primary hover:bg-bg-primary`}>
                <PiggyBank size={16} /> Use bank cash in Cash Flow Forecast
              </button>
              <Link to="/dashboard/cash-flow-war-room" className={`${btn} border border-border text-text-primary hover:bg-bg-primary`}><Flame size={16} /> Open War Room <ArrowRight size={14} /></Link>
              <Link to="/dashboard/accounting" className={`${btn} border border-border text-text-primary hover:bg-bg-primary`}>View ledger <ArrowRight size={14} /></Link>
            </div>
          </section>

          <section className="grid gap-3 md:grid-cols-2" aria-label="Connected banks">
            {connections.map((c) => (
              <div key={c.id} className="rounded-2xl border border-border p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-text-primary">{c.institution_name}</p>
                    <p className="text-xs text-text-secondary">{c.last_synced_at ? `Synced ${new Date(c.last_synced_at).toLocaleString()}` : 'Waiting for first sync'}</p>
                  </div>
                  <div className="flex gap-1.5">
                    {c.status === 'login_required' && (
                      <button onClick={() => connect(c.id)} disabled={busy !== null} className="focus-ring rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-600">Reconnect</button>
                    )}
                    <button onClick={() => setDisconnecting(c)} className="focus-ring rounded-lg border border-border p-2 text-text-secondary hover:bg-bg-secondary" title="Disconnect" aria-label={`Disconnect ${c.institution_name}`}><Unplug size={14} /></button>
                  </div>
                </div>
                {c.status !== 'active' && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-600"><TriangleAlert size={14} /> {c.last_error ?? 'This connection needs attention.'}</p>
                )}
                <ul className="mt-3 space-y-1">
                  {accounts.filter((a) => a.connection_id === c.id).map((a) => (
                    <li key={a.id} className="flex justify-between text-sm">
                      <span className="text-text-secondary">{a.name}{a.mask ? ` ••${a.mask}` : ''}</span>
                      <span className="font-medium text-text-primary">{a.current_balance_cents === null ? '—' : money(a.account_type === 'credit' ? -a.current_balance_cents : a.current_balance_cents)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>

          <section aria-label="Reconciliation queue">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div role="tablist" className="flex gap-1 rounded-xl border border-border p-1">
                {(['review', 'reconciled', 'ignored'] as Tab[]).map((k) => (
                  <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`focus-ring rounded-lg px-3 py-1.5 text-sm font-medium capitalize ${tab === k ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-secondary'}`}>
                    {k === 'review' ? 'Needs review' : k}
                  </button>
                ))}
              </div>
              {tab === 'review' && bulkItems.length > 0 && (
                <button onClick={() => setConfirmBulk(true)} disabled={busy !== null} className={`${btn} bg-emerald-600 text-white hover:opacity-90`}>
                  <Sparkles size={16} className={busy === 'bulk' ? 'animate-pulse' : ''} /> Approve {bulkItems.length} high-confidence
                </button>
              )}
            </div>

            {visible.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-text-secondary">
                {tab === 'review' ? 'Nothing needs review. New bank activity is analyzed automatically.' : `No ${tab} transactions yet.`}
              </p>
            ) : (
              <ul className="space-y-2">
                {visible.map((t) => {
                  const inflow = t.amount_cents > 0;
                  const cats = inflow ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
                  const isWorking = working.has(t.id);
                  const conf = t.match_confidence !== null ? Math.round(t.match_confidence * 100) : null;
                  const canPick = tab === 'review' && (!t.match_type || t.match_type === 'expense' || t.match_type === 'income');
                  const chosen = draft[t.id];
                  return (
                    <li key={t.id} className="rounded-xl border border-border p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-text-primary">{t.merchant_name || t.description}</p>
                          <p className="text-xs text-text-secondary">{new Date(`${t.posted_date}T00:00:00`).toLocaleDateString()} · {accountName.get(t.account_id) ?? 'Account'}</p>
                        </div>
                        <span className={`text-sm font-bold ${inflow ? 'text-emerald-600' : 'text-text-primary'}`}>{inflow ? '+' : '−'}{money(Math.abs(t.amount_cents), 2)}</span>
                      </div>

                      {t.match_type && (
                        <div className="mt-2 rounded-lg bg-bg-secondary p-3 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-md bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">{MATCH_LABEL[t.match_type]}</span>
                            {t.category_label && (t.match_type === 'expense' || t.match_type === 'income') && <span className="text-xs text-text-secondary">{t.category_label}{t.category_source === 'ai' ? ' · AI' : t.category_source === 'user' ? ' · learned' : ''}</span>}
                            {conf !== null && tab === 'review' && <span className={`text-xs font-semibold ${conf >= HIGH_CONFIDENCE * 100 ? 'text-emerald-600' : 'text-amber-600'}`}>{conf}% confident</span>}
                          </div>
                          {t.match_refs.length > 0 && <p className="mt-1 text-text-primary">{t.match_refs.slice(0, 3).map((r) => r.label).join(', ')}{t.match_refs.length > 3 ? ` +${t.match_refs.length - 3} more` : ''}</p>}
                          {t.match_reason && tab === 'review' && <p className="mt-0.5 text-xs text-text-secondary">{t.match_reason}</p>}
                        </div>
                      )}
                      {!t.match_type && tab === 'review' && t.match_reason && <p className="mt-2 text-xs text-text-secondary">{t.match_reason}</p>}
                      {t.needs_review && <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-600"><TriangleAlert size={14} /> Your bank changed this transaction after it was reconciled — check the ledger entry.</p>}

                      {tab !== 'reconciled' && (
                        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                          {tab === 'ignored' ? (
                            <button onClick={() => toggleIgnore(t, false)} disabled={isWorking} className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-secondary"><Undo2 size={14} /> Restore</button>
                          ) : (
                            <>
                              {canPick && (
                                <select value={chosen ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [t.id]: e.target.value }))} aria-label="Category" className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-xs text-text-primary">
                                  <option value="">{t.match_type ? 'Change category…' : 'Choose category…'}</option>
                                  {cats.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                                </select>
                              )}
                              <button onClick={() => toggleIgnore(t, true)} disabled={isWorking} className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-secondary hover:bg-bg-secondary" title="Ignore (e.g. personal or already handled elsewhere)"><EyeOff size={14} /> Ignore</button>
                              {(t.match_type || chosen) && (
                                <button onClick={() => approve(t)} disabled={isWorking || busy === 'bulk'} className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"><Check size={14} /> {chosen ? 'Post' : 'Approve'}</button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}

      <ConfirmDialog
        open={confirmBulk}
        title={`Approve ${bulkItems.length} high-confidence items?`}
        description="Each one is posted to your ledger on the bank's date (deposits applied to invoices, bills paid, categorized expenses). Items with a lower confidence stay in your queue."
        confirmLabel="Approve and post"
        onConfirm={runBulk}
        onCancel={() => setConfirmBulk(false)}
      />
      <ConfirmDialog
        open={!!disconnecting}
        title={`Disconnect ${disconnecting?.institution_name ?? 'this bank'}?`}
        description="Vireek stops syncing and the bank credentials are removed. Transactions you already reconciled stay in your books."
        confirmLabel="Disconnect"
        onConfirm={disconnect}
        onCancel={() => setDisconnecting(null)}
      />
    </DashboardLayout>
  );
}
