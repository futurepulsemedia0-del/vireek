/**
 * Weekly "Money Recovered" statements — /dashboard/recovery/statements
 *
 * Extends the Recovery Ledger: shows this week's statement live, every past weekly statement
 * (frozen snapshots, exactly what was emailed), the baseline Leak Report figure, and — for the
 * account owner — the weekly email schedule. Everyone with billing access can read and download.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Download, Loader2, Receipt, Save, Send } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import { StatementView } from '@/components/recovery/StatementView';
import { commonTimeZones } from '@/lib/executiveReport';
import {
  STATUS_LABEL,
  addBaseline,
  defaultDraft,
  downloadStatementPdf,
  fetchBaseline,
  fetchSettings,
  fetchStatements,
  formatMoney,
  loadLiveStatement,
  parseDollarsToCents,
  runStatementAction,
  saveSettings,
  validateDraft,
  type StatementAction,
  type StatementRecord,
  type StatementSettingsDraft,
  type Statement,
} from '@/lib/moneyRecovered';
import type { Baseline } from '../../supabase/functions/_shared/money-recovered/engine';

const STATUS_STYLE: Record<StatementRecord['status'], string> = {
  ready: 'bg-accent/10 text-accent',
  sent: 'bg-success-500/10 text-success-500',
  partial: 'bg-warning-500/10 text-warning-500',
  failed: 'bg-danger/10 text-danger',
};

const selectClass =
  'w-full rounded-xl border border-border bg-bg-secondary px-4 py-3 text-base text-text-primary focus-visible:border-accent focus-visible:outline-none';

function Toggle({ id, checked, onChange, label, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 text-sm">
      <input id={id} type="checkbox" className="mt-1 h-4 w-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="font-medium text-text-primary">{label}</span>
        {hint && <span className="block text-xs text-text-secondary">{hint}</span>}
      </span>
    </label>
  );
}

export function MoneyRecoveredStatementsPage() {
  const { user, profile, isOwner, profileLoading } = useAuth();
  const { toast } = useToast();

  const browserZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const currency = ((profile as { invoice_currency?: string | null } | null)?.invoice_currency || 'USD').toUpperCase();
  const companyName = profile?.company_name?.trim() || 'Your business';

  const [draft, setDraft] = useState<StatementSettingsDraft>(() => defaultDraft(browserZone));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [live, setLive] = useState<Statement | null>(null);
  const [statements, setStatements] = useState<StatementRecord[]>([]);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [baselineInput, setBaselineInput] = useState('');
  const [baselineLabel, setBaselineLabel] = useState('');
  const [baselineError, setBaselineError] = useState<string | undefined>();
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<StatementAction | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);

  const zones = useMemo(() => commonTimeZones(draft.timezone), [draft.timezone]);
  const patch = (p: Partial<StatementSettingsDraft>) => setDraft((d) => ({ ...d, ...p }));

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(false);
    try {
      // Settings first: the live preview must use the owner's saved time zone.
      const settings = await fetchSettings(user.id).catch(() => null);
      if (settings) setDraft(settings);
      const [liveStatement, rows, base] = await Promise.all([
        loadLiveStatement(settings?.timezone ?? browserZone, 'current', currency),
        fetchStatements(),
        fetchBaseline(),
      ]);
      setLive(liveStatement);
      setStatements(rows);
      setBaseline(base);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [user, browserZone, currency]);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    const found = validateDraft(draft);
    setErrors(found);
    if (Object.keys(found).length) {
      toast('Please fix the highlighted fields', 'error');
      return false;
    }
    await saveSettings(user.id, draft);
    return true;
  }, [user, draft, toast]);

  const onSave = async () => {
    setSaving(true);
    try {
      if (await persist()) toast('Statement settings saved', 'success');
    } catch {
      toast('Could not save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const onAction = async (action: StatementAction) => {
    setBusy(action);
    try {
      if (!(await persist())) return;
      const res = await runStatementAction(action);
      const d = res.delivery;
      if (action === 'send_test') toast(d?.ok ? 'Test statement sent to your email' : `Test email failed: ${d?.error ?? 'unknown error'}`, d?.ok ? 'success' : 'error');
      else toast(d?.status === 'sent' ? `Statement sent to ${d.sent} recipient(s)` : `Send finished: ${d?.status ?? 'unknown'}${d?.error ? ` — ${d.error}` : ''}`, d?.status === 'sent' ? 'success' : 'error');
      setStatements(await fetchStatements());
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Request failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  const onSaveBaseline = async () => {
    if (!user) return;
    const cents = parseDollarsToCents(baselineInput);
    if (cents === null) {
      setBaselineError('Enter the monthly leak from your Leak Report, e.g. 12,500.');
      return;
    }
    setBaselineError(undefined);
    setSaving(true);
    try {
      await addBaseline(user.id, cents, baselineLabel);
      setBaselineInput('');
      setBaselineLabel('');
      toast('Baseline recorded', 'success');
      await load();
    } catch {
      toast('Could not save the baseline', 'error');
    } finally {
      setSaving(false);
    }
  };

  const onPdf = async (statement: Statement) => {
    try {
      await downloadStatementPdf(statement, companyName);
    } catch {
      toast('Could not build the PDF', 'error');
    }
  };

  const header = (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Receipt size={22} aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Money Recovered</h1>
          <p className="max-w-2xl text-sm text-text-secondary">
            A weekly statement of what Vireek won back for you: each rescued call, totals by category, a comparison with your baseline Leak Report, and exactly how it is counted.
          </p>
        </div>
      </div>
      <Link to="/dashboard/recovery" className="focus-ring rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary">
        ← Recovery Ledger
      </Link>
    </div>
  );

  if (profileLoading) {
    return <DashboardLayout activeLabel="Money Recovered"><div className="mx-auto max-w-4xl px-4 py-8 sm:px-6"><SkeletonCardList count={2} /></div></DashboardLayout>;
  }

  return (
    <DashboardLayout activeLabel="Money Recovered">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        {header}

        {loading ? (
          <SkeletonCardList count={3} />
        ) : loadError ? (
          <EmptyState icon={Receipt} title="Couldn't load your statements" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />
        ) : (
          <div className="space-y-8">
            {live && (
              <section aria-labelledby="mr-live">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <h2 id="mr-live" className="text-lg font-semibold text-text-primary">This week so far <span className="ml-2 rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs font-medium text-text-secondary">Live preview · not sent</span></h2>
                  <Button variant="secondary" size="sm" onClick={() => void onPdf(live)}><Download size={16} aria-hidden="true" /> PDF</Button>
                </div>
                <Card className="hover:translate-y-0">
                  <StatementView statement={live} />
                </Card>
              </section>
            )}

            <section aria-labelledby="mr-baseline-form">
              <h2 id="mr-baseline-form" className="mb-3 text-lg font-semibold text-text-primary">Baseline Leak Report</h2>
              <Card className="hover:translate-y-0">
                <p className="text-sm text-text-secondary">
                  {baseline
                    ? <>Current baseline: <span className="font-semibold text-text-primary">{formatMoney(baseline.monthly_leak_cents, currency)}/month</span> recorded {baseline.captured_at.slice(0, 10)}{baseline.label ? ` (${baseline.label})` : ''}. Recording a new figure keeps the old one in history; past statements are never changed.</>
                    : 'Enter the monthly revenue leak from your Leak Report so every statement can show how this week compares.'}
                </p>
                {isOwner ? (
                  <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Input label="Monthly leak ($)" inputMode="decimal" placeholder="12,500" value={baselineInput} onChange={(e) => setBaselineInput(e.target.value)} error={baselineError} />
                    <Input label="Note (optional)" placeholder="Leak Report, March 2026" maxLength={120} value={baselineLabel} onChange={(e) => setBaselineLabel(e.target.value)} />
                    <div className="sm:col-span-2">
                      <Button variant="secondary" onClick={() => void onSaveBaseline()} disabled={saving}>
                        {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />} Record baseline
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-text-secondary">Only the account owner can record a baseline.</p>
                )}
              </Card>
            </section>

            {isOwner && (
              <section aria-labelledby="mr-schedule">
                <h2 id="mr-schedule" className="mb-3 text-lg font-semibold text-text-primary">Weekly email</h2>
                <Card className="hover:translate-y-0">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <Toggle id="mr-enabled" checked={draft.enabled} onChange={(v) => patch({ enabled: v })} label="Email the statement every Monday" hint="The previous Monday–Sunday week is sent at the hour below, in your time zone, with the PDF attached." />
                    </div>
                    <Input label="Hour (0–23, local)" type="number" inputMode="numeric" min={0} max={23} value={draft.send_hour} onChange={(e) => patch({ send_hour: e.target.value })} error={errors.send_hour} />
                    <div>
                      <label htmlFor="mr-timezone" className="mb-1.5 block text-sm font-medium text-text-primary">Time zone</label>
                      <select id="mr-timezone" className={selectClass} value={draft.timezone} onChange={(e) => patch({ timezone: e.target.value })}>
                        {zones.map((z) => <option key={z} value={z}>{z}</option>)}
                      </select>
                      {errors.timezone && <p role="alert" className="mt-1.5 text-xs text-danger">{errors.timezone}</p>}
                    </div>
                    <Toggle id="mr-owner" checked={draft.include_owner} onChange={(v) => patch({ include_owner: v })} label="Account owner" />
                    <Toggle id="mr-coowners" checked={draft.include_co_owners} onChange={(v) => patch({ include_co_owners: v })} label="Other owners on the team" />
                    <div className="sm:col-span-2">
                      <Textarea label="Extra recipients" rows={2} placeholder="partner@company.com, cfo@company.com" value={draft.extra_recipients} onChange={(e) => patch({ extra_recipients: e.target.value })} error={errors.extra_recipients} helperText="Up to 10 emails, separated by commas or new lines." />
                    </div>
                  </div>
                  <div className="mt-5 flex flex-wrap gap-3">
                    <Button onClick={() => void onSave()} disabled={saving || busy !== null}>
                      {saving ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />} Save settings
                    </Button>
                    <Button variant="secondary" onClick={() => void onAction('send_test')} disabled={saving || busy !== null}>
                      {busy === 'send_test' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />} Email me last week's statement
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmSend(true)} disabled={saving || busy !== null}>
                      Send to all recipients now
                    </Button>
                  </div>
                </Card>
              </section>
            )}

            <section aria-labelledby="mr-history">
              <h2 id="mr-history" className="mb-3 text-lg font-semibold text-text-primary">Statement history</h2>
              {statements.length === 0 ? (
                <EmptyState icon={Receipt} title="No weekly statements yet" description="Your first statement is generated after the first full Monday–Sunday week, or when you send one from above." />
              ) : (
                <ul className="space-y-3">
                  {statements.map((r) => {
                    const open = openId === r.id;
                    return (
                      <li key={r.id}>
                        <Card className="p-5 hover:translate-y-0">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <button
                              type="button"
                              className="focus-ring flex min-w-0 flex-1 items-center gap-3 text-left"
                              aria-expanded={open}
                              aria-controls={`mr-stmt-${r.id}`}
                              onClick={() => setOpenId(open ? null : r.id)}
                            >
                              <ChevronDown size={18} aria-hidden="true" className={`shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
                              <span className="min-w-0">
                                <span className="flex flex-wrap items-center gap-2">
                                  <span className="font-semibold text-text-primary">{r.period_label}</span>
                                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                                </span>
                                <span className="block text-sm text-text-secondary">{formatMoney(r.credited_cents, r.snapshot.currency)} recovered · {r.snapshot.creditedCount} counted</span>
                              </span>
                            </button>
                            <Button variant="secondary" size="sm" onClick={() => void onPdf(r.snapshot)}>
                              <Download size={16} aria-hidden="true" /> PDF
                            </Button>
                          </div>
                          {r.last_error && r.status !== 'sent' && <p role="alert" className="mt-2 text-xs text-danger">{r.last_error}</p>}
                          {open && <div id={`mr-stmt-${r.id}`} className="mt-5 border-t border-border pt-5"><StatementView statement={r.snapshot} /></div>}
                        </Card>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmSend}
        title="Send last week's statement now?"
        description="It will be emailed to every configured recipient. Recipients who already received it are skipped."
        confirmLabel="Send statement"
        onCancel={() => setConfirmSend(false)}
        onConfirm={async () => { setConfirmSend(false); await onAction('send_now'); }}
      />
    </DashboardLayout>
  );
}
