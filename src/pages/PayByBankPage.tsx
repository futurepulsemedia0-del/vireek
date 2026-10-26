/**
 * Pay by Bank — /dashboard/pay-by-bank
 * Settings, capability status, KPIs, lower-fee routing suggestions and the bank-payment ledger (in transit, failed,
 * returned, needs-invoice). Money movement is server-side (webhooks + reconcile cron); this page is the control room.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Banknote, Link2, Lock, RefreshCw, ShieldCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  ACCOUNTING_META, ATTEMPT_STATUS_META, ATTEMPT_TABS, RAIL_LABEL, describeProblem, describeSettlement, dismissAttempt, fetchBankAttempts,
  fetchBankSettings, fetchBankStats, fetchLinkableInvoices, formatCents, linkAttemptToInvoice, matchesAttemptTab, refreshBankCapability,
  saveBankSettings, type AttemptRow, type AttemptTab, type BankSettingsRow, type BankStats, type LinkableInvoice, type Tone,
} from '@/lib/payByBank';

const TONE: Record<Tone, string> = {
  neutral: 'border-border bg-bg-tertiary text-text-secondary',
  accent: 'border-accent/30 bg-accent/10 text-accent',
  success: 'border-success/30 bg-success/10 text-success',
  warning: 'border-warning-500/30 bg-warning-500/10 text-warning-500',
  danger: 'border-danger/30 bg-danger/10 text-danger',
};

const Pill = ({ tone, children }: { tone: Tone; children: React.ReactNode }) => (
  <span className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE[tone]}`}>{children}</span>
);

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'danger' | 'success' | 'warning' }) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'success' ? 'text-success' : tone === 'warning' ? 'text-warning-500' : 'text-text-primary';
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${color}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

const CAPABILITY_COPY: Record<BankSettingsRow['capability_status'], { label: string; tone: Tone }> = {
  active: { label: 'Bank debits active', tone: 'success' },
  pending: { label: 'Stripe is reviewing', tone: 'warning' },
  inactive: { label: 'Not enabled', tone: 'danger' },
  unknown: { label: 'Not checked yet', tone: 'neutral' },
};

const dollarsToCents = (v: string) => Math.round(Number.parseFloat(v) * 100);
const centsToDollars = (c: number) => (c / 100).toFixed(2);

export function PayByBankPage() {
  const { toast } = useToast();
  const { user, isOwner, teamMember, permissions } = useAuth();
  const canAccess = isOwner || permissions.can_view_billing;
  const ownerId = isOwner ? user?.id : teamMember?.account_owner_id; // accountOwnerId scoping

  const [settings, setSettings] = useState<BankSettingsRow | null>(null);
  const [stats, setStats] = useState<BankStats | null>(null);
  const [attempts, setAttempts] = useState<AttemptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<AttemptTab>('all');

  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [minD, setMinD] = useState('');
  const [maxD, setMaxD] = useState('');

  const [linking, setLinking] = useState<AttemptRow | null>(null);
  const [invoices, setInvoices] = useState<LinkableInvoice[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const syncForm = (s: BankSettingsRow | null) => {
    setMinD(centsToDollars(s?.min_amount_cents ?? 5000));
    setMaxD(centsToDollars(s?.max_amount_cents ?? 2500000));
  };

  const load = useCallback(async (background = false) => {
    if (!ownerId || !canAccess) return;
    if (background) setRefreshing(true); else { setLoading(true); setFailed(false); }
    try {
      const [s, st, a] = await Promise.all([fetchBankSettings(ownerId), fetchBankStats(90), fetchBankAttempts(ownerId)]);
      setSettings(s); setStats(st); setAttempts(a);
      if (!background) syncForm(s);
    } catch {
      if (background) toast('Could not refresh bank payments.', 'error'); else setFailed(true);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [ownerId, canAccess, toast]);

  useEffect(() => { void load(); }, [load]);

  // Settlements and returns land off-page (webhooks, cron) — refresh quietly when the tab regains focus.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void load(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const counts = useMemo(
    () => Object.fromEntries(ATTEMPT_TABS.map((t) => [t.key, attempts.filter((a) => matchesAttemptTab(a, t.key)).length])) as Record<AttemptTab, number>,
    [attempts],
  );
  const visible = useMemo(() => attempts.filter((a) => matchesAttemptTab(a, tab)), [attempts, tab]);

  const enabled = settings?.enabled ?? false;
  const capability = settings?.capability_status ?? 'unknown';

  const persist = async (patch: Parameters<typeof saveBankSettings>[0], okMsg: string) => {
    setSaving(true);
    try {
      const next = await saveBankSettings(patch);
      setSettings(next); syncForm(next);
      toast(okMsg, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the settings.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveLimits = () => {
    const min = dollarsToCents(minD); const max = dollarsToCents(maxD);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min || max < 100) {
      toast('Enter a valid minimum and maximum amount (maximum must be at least the minimum).', 'error');
      return;
    }
    void persist({ min_amount_cents: min, max_amount_cents: max }, 'Limits saved.');
  };

  const checkCapability = async (enable: boolean) => {
    setChecking(true);
    try {
      const status = await refreshBankCapability(enable);
      setSettings((s) => (s ? { ...s, capability_status: status } : s));
      toast(status === 'active' ? 'Bank debits are active on your Stripe account.' : status === 'pending' ? 'Stripe is reviewing your account — this usually takes a short while.' : 'Bank debits are not active yet.', status === 'active' ? 'success' : 'info');
      void load(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong. Please try again.', 'error');
    } finally {
      setChecking(false);
    }
  };

  const openLink = async (a: AttemptRow) => {
    setLinking(a); setInvoices(null);
    try { setInvoices(await fetchLinkableInvoices(a.amount_cents)); } catch { setInvoices([]); toast('Could not load invoices.', 'error'); }
  };

  const doLink = async (invoiceId: string) => {
    if (!linking) return;
    setBusyId(linking.id);
    try {
      await linkAttemptToInvoice(linking.id, invoiceId);
      toast('Payment linked and posted to your books.', 'success');
      setLinking(null);
      await load(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not link the payment.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const doDismiss = async (a: AttemptRow) => {
    setBusyId(a.id);
    try { await dismissAttempt(a.id); toast('Payment dismissed.', 'success'); await load(true); }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not dismiss the payment.', 'error'); }
    finally { setBusyId(null); }
  };

  const canEdit = isOwner || permissions.can_view_billing;

  return (
    <DashboardLayout activeLabel="Pay by Bank">
      <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Pay by Bank</h1>
            <p className="mt-1 text-sm text-text-secondary">Let customers pay invoices, memberships and plans straight from their bank — lower fees than cards.</p>
          </div>
          {canAccess && !loading && !failed && (
            <Button variant="secondary" size="sm" onClick={() => void load(true)} disabled={refreshing} aria-label="Refresh bank payments">
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" /> Refresh
            </Button>
          )}
        </header>

        {!canAccess ? (
          <EmptyState icon={Lock} title="You don't have access to bank payments" description="Bank payments contain billing information. Ask the account owner to grant you billing access." />
        ) : loading ? (
          <div className="space-y-4" aria-busy="true" aria-label="Loading bank payments"><SkeletonStatGrid count={4} /><SkeletonCardList count={3} rows={2} /></div>
        ) : failed ? (
          <EmptyStateError title="Could not load bank payments" onRetry={() => void load()} />
        ) : (
          <>
            {/* Settings + capability */}
            <section className="grid gap-4 lg:grid-cols-2" aria-label="Settings">
              <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-text-primary">Accept bank payments</h2>
                    <p className="mt-1 text-sm text-text-secondary">Adds “US bank account” to pay links, membership sign-ups and payment plans. Customers verify their bank instantly; payments settle in 1–4 business days.</p>
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-text-primary">
                    <input type="checkbox" className="h-5 w-5 accent-accent" checked={enabled} disabled={saving || !canEdit}
                      onChange={(e) => void persist({ enabled: e.target.checked }, e.target.checked ? 'Bank payments turned on.' : 'Bank payments turned off.')} />
                    {enabled ? 'On' : 'Off'}
                  </label>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Input label="Minimum ($)" type="number" inputMode="decimal" min={0} step="0.01" value={minD} onChange={(e) => setMinD(e.target.value)} helperText="Smaller payments stay card-only." />
                  <Input label="Maximum ($)" type="number" inputMode="decimal" min={1} step="0.01" value={maxD} onChange={(e) => setMaxD(e.target.value)} helperText="Limits your return risk." />
                </div>
                <div className="mt-3">
                  <Button variant="secondary" size="sm" onClick={saveLimits} disabled={saving || !canEdit}>Save limits</Button>
                </div>

                <fieldset className="mt-5">
                  <legend className="text-sm font-semibold text-text-primary">Routing</legend>
                  <div className="mt-2 space-y-2">
                    {([['offer', 'Offer bank as an option', 'Customers choose between card and bank.'], ['prefer', 'Prefer bank (recommended for large invoices)', 'Bank is shown first; card is still available.']] as const).map(([v, t, d]) => (
                      <label key={v} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 has-[:checked]:border-accent/60">
                        <input type="radio" name="routing" className="mt-1 h-4 w-4 accent-accent" checked={(settings?.routing_mode ?? 'offer') === v} disabled={saving || !canEdit}
                          onChange={() => void persist({ routing_mode: v }, 'Routing saved.')} />
                        <span><span className="block text-sm font-medium text-text-primary">{t}</span><span className="block text-xs text-text-secondary">{d}</span></span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <label className="mt-4 flex cursor-pointer items-start gap-3">
                  <input type="checkbox" className="mt-1 h-4 w-4 accent-accent" checked={settings?.provisional_membership_access ?? false} disabled={saving || !canEdit}
                    onChange={(e) => void persist({ provisional_membership_access: e.target.checked }, 'Membership access setting saved.')} />
                  <span>
                    <span className="block text-sm font-medium text-text-primary">Start memberships while the first bank payment settles</span>
                    <span className="block text-xs text-text-secondary">Up to {formatCents(settings?.provisional_limit_cents ?? 0)}. If the payment later fails or is returned, you’ll see it here.</span>
                  </span>
                </label>
              </div>

              <div className="rounded-2xl border border-border bg-bg-secondary p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-text-primary">Stripe bank-debit status</h2>
                    <p className="mt-1 text-sm text-text-secondary">Your connected Stripe account must have ACH Direct Debit enabled before customers can use it.</p>
                  </div>
                  <Pill tone={CAPABILITY_COPY[capability].tone}>{CAPABILITY_COPY[capability].label}</Pill>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => void checkCapability(false)} disabled={checking}>Check status</Button>
                  {capability !== 'active' && capability !== 'pending' && isOwner && (
                    <Button size="sm" onClick={() => void checkCapability(true)} disabled={checking}><ShieldCheck className="h-4 w-4" aria-hidden="true" /> Enable bank debits</Button>
                  )}
                </div>
                {enabled && capability !== 'active' && (
                  <p className="mt-3 text-xs text-warning-500" role="status">Bank payments are on but won’t appear for customers until Stripe shows “active”.</p>
                )}
                <ul className="mt-4 space-y-1 text-xs text-text-secondary">
                  <li>• Failed or returned debits are handled automatically and the customer is notified.</li>
                  <li>• Bank payments allow full refunds only.</li>
                  <li>• Automatic membership renewals still use the saved card.</li>
                </ul>
              </div>
            </section>

            {/* KPIs */}
            {stats && (
              <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Last 90 days">
                <Kpi label="Collected by bank" value={formatCents(stats.bank_collected_cents)} hint="Last 90 days" tone="success" />
                <Kpi label="In transit" value={formatCents(stats.in_flight_cents)} hint={`${stats.in_flight_count} payment${stats.in_flight_count === 1 ? '' : 's'}`} />
                <Kpi label="Fees saved vs. card" value={formatCents(stats.fees_saved_cents)} hint="Estimate" tone="success" />
                <Kpi label="Success rate" value={stats.success_rate == null ? '—' : `${Math.round(stats.success_rate * 100)}%`}
                  hint={`${stats.failed_count} failed · ${stats.returned_count} returned`} tone={stats.returned_count + stats.failed_count > 0 ? 'warning' : undefined} />
              </section>
            )}

            {/* Lower-fee routing suggestions */}
            {stats && stats.suggestions.length > 0 && (
              <section className="rounded-2xl border border-accent/30 bg-accent/5 p-5" aria-label="Lower-fee suggestions">
                <h2 className="text-base font-semibold text-text-primary">Customers worth steering to bank payment</h2>
                <p className="mt-1 text-sm text-text-secondary">You could save about {formatCents(stats.potential_savings_cents)} in fees on recent card payments.</p>
                <ul className="mt-3 divide-y divide-border">
                  {stats.suggestions.map((s) => (
                    <li key={s.customer_name} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                      <div>
                        <p className="text-sm font-medium text-text-primary">{s.customer_name}</p>
                        <p className="text-xs text-text-secondary">{s.reason}</p>
                      </div>
                      <span className="text-sm font-semibold text-success">Save ~{formatCents(s.potential_savings_cents)}</span>
                    </li>
                  ))}
                </ul>
                {!enabled && <p className="mt-3 text-xs text-text-secondary">Turn on bank payments above to start offering this.</p>}
              </section>
            )}

            {/* Ledger */}
            <section aria-label="Bank payments">
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter bank payments">
                {ATTEMPT_TABS.map((t) => (
                  <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
                    className={`focus-ring rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${tab === t.key ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>
                    {t.label} <span className="ml-1 text-xs opacity-70">{counts[t.key]}</span>
                  </button>
                ))}
              </div>

              <div className="mt-4">
                {attempts.length === 0 ? (
                  <EmptyState icon={Banknote} title="No bank payments yet" description={enabled ? 'When a customer pays by bank, it appears here with its settlement status.' : 'Turn on bank payments to start collecting by ACH.'} />
                ) : visible.length === 0 ? (
                  <EmptyState icon={Banknote} title="Nothing here" description="No payments match this filter." action={{ label: 'Show all', onClick: () => setTab('all') }} />
                ) : (
                  <ul className="space-y-3">
                    {visible.map((a) => {
                      const sm = ATTEMPT_STATUS_META[a.status]; const am = ACCOUNTING_META[a.accounting_status];
                      const problem = describeProblem(a);
                      const needsInvoice = a.status === 'succeeded' && (a.accounting_status === 'unlinked' || a.accounting_status === 'failed') && !a.payment_request_id;
                      return (
                        <li key={a.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-text-primary">{a.customer_name || 'Customer'}</p>
                              <p className="text-xs text-text-secondary">
                                {RAIL_LABEL[a.rail]}{a.bank_name ? ` · ${a.bank_name}` : ''}{a.account_last4 ? ` ••${a.account_last4}` : ''} · {new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-base font-semibold text-text-primary">{formatCents(a.amount_cents)}</p>
                              <p className="text-[11px] text-text-secondary">Fee ~{formatCents(a.fee_estimate_cents)} vs card ~{formatCents(a.card_fee_estimate_cents)}</p>
                            </div>
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <Pill tone={sm.tone}>{sm.label}</Pill>
                            {a.status === 'succeeded' && <Pill tone={am.tone}>{am.label}</Pill>}
                            {(a.status === 'returned' || a.status === 'disputed') && a.accounting_status !== 'skipped' && <Pill tone={am.tone}>{am.label}</Pill>}
                            <span className="text-xs text-text-secondary">{describeSettlement(a)}</span>
                          </div>
                          {problem && <p className="mt-2 text-xs text-danger" role="alert">{problem}</p>}
                          {a.accounting_error && <p className="mt-1 text-xs text-warning-500">Ledger: {a.accounting_error}</p>}
                          {needsInvoice && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button size="sm" variant="secondary" disabled={busyId === a.id} onClick={() => void openLink(a)}><Link2 className="h-4 w-4" aria-hidden="true" /> Link to invoice</Button>
                              <Button size="sm" variant="ghost" disabled={busyId === a.id} onClick={() => void doDismiss(a)}>Dismiss</Button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>
          </>
        )}
      </div>

      {linking && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label="Link payment to an invoice"
          onKeyDown={(e) => { if (e.key === 'Escape') setLinking(null); }}>
          <div className="w-full max-w-md rounded-2xl border border-border bg-bg-primary p-5 shadow-xl">
            <h2 className="text-base font-semibold text-text-primary">Link {formatCents(linking.amount_cents)} to an invoice</h2>
            <p className="mt-1 text-sm text-text-secondary">Pick the open invoice this bank payment belongs to. It will be marked paid and posted to your books.</p>
            <div className="mt-4 max-h-64 overflow-y-auto">
              {invoices === null ? (
                <p className="py-6 text-center text-sm text-text-secondary" aria-busy="true">Loading invoices…</p>
              ) : invoices.length === 0 ? (
                <p className="py-6 text-center text-sm text-text-secondary">No open invoices with enough balance.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {invoices.map((inv) => (
                    <li key={inv.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div>
                        <p className="text-sm font-medium text-text-primary">#{inv.invoice_number}</p>
                        <p className="text-xs text-text-secondary">Balance {formatCents(inv.balance_cents)} · due {inv.due_date}</p>
                      </div>
                      <Button size="sm" variant="secondary" disabled={busyId === linking.id} onClick={() => void doLink(inv.id)}>Link</Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="mt-4 flex justify-end"><Button variant="ghost" size="sm" onClick={() => setLinking(null)}>Cancel</Button></div>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

export default PayByBankPage;
