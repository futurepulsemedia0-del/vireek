/**
 * Pilot Results — /dashboard/pilot-results
 * Baseline vs now, recovered $ with documented action, manual hours, claims/invoices by status, CSV.
 * Every number is computed by the database; the warranty-eligible $ is labeled "estimate".
 */
import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, Download, Loader2, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import {
  ACTION_LABELS, addHours, compareFigures, computeFee, deleteHours, downloadResultsCsv, fetchPilotResults, formatMoney, formatValue,
  hoursLabel, listHours, parseFeeInput, parseHoursInput, setFeePct, startPilot,
  type HoursEntry, type PilotResults,
} from '@/lib/pilotResults';

const TREND_STYLE = { better: 'text-success-500', worse: 'text-danger', same: 'text-text-secondary', no_data: 'text-text-secondary' } as const;

function StatusTable({ title, data, currency }: { title: string; data: PilotResults['claims_by_status']; currency: string }) {
  const entries = Object.entries(data);
  return (
    <Card className="hover:translate-y-0">
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      {entries.length === 0 ? <p className="mt-2 text-sm text-text-secondary">None yet.</p> : (
        <ul className="mt-2 divide-y divide-border text-sm">
          {entries.map(([status, b]) => (
            <li key={status} className="flex justify-between py-2"><span className="capitalize">{status.replace(/_/g, ' ')}</span><span className="text-text-secondary">{b.count}{b.cents > 0 ? ` · ${formatMoney(b.cents, currency)}` : ''}</span></li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function PilotResultsPage() {
  const { user, profile, isOwner, profileLoading } = useAuth();
  const { toast } = useToast();
  const currency = ((profile as { invoice_currency?: string | null } | null)?.invoice_currency || 'USD').toUpperCase();

  const [data, setData] = useState<PilotResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hours, setHours] = useState<HoursEntry[]>([]);
  const [hoursInput, setHoursInput] = useState('');
  const [hoursNote, setHoursNote] = useState('');
  const [feeInput, setFeeInput] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const r = await fetchPilotResults();
      setData(r);
      setFeeInput(r?.fee_pct != null ? String(r.fee_pct) : '');
      if (r) setHours(await listHours());
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onStart = async () => {
    setBusy(true);
    try { setData(await startPilot()); toast('Pilot started. Baseline saved.', 'success'); } catch { toast('Could not start the pilot', 'error'); } finally { setBusy(false); }
  };

  const onAddHours = async () => {
    const minutes = parseHoursInput(hoursInput);
    if (!minutes || !user) { toast('Enter hours like 1.5 or minutes like 45m', 'error'); return; }
    setBusy(true);
    try { await addHours(user.id, minutes, hoursNote); setHoursInput(''); setHoursNote(''); await load(); } catch { toast('Could not save hours', 'error'); } finally { setBusy(false); }
  };

  const onDeleteHours = async (id: string) => {
    try { await deleteHours(id); await load(); } catch { toast('Could not delete entry', 'error'); }
  };

  const onSaveFee = async () => {
    const v = parseFeeInput(feeInput);
    if (v === undefined) { toast('Fee must be 0–100 with up to 2 decimals', 'error'); return; }
    setBusy(true);
    try { await setFeePct(v); await load(); toast('Fee percentage saved (display only)', 'success'); } catch { toast('Could not save the fee', 'error'); } finally { setBusy(false); }
  };

  const header = (
    <div className="mb-6 flex items-start gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><ClipboardCheck size={22} aria-hidden="true" /></span>
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Pilot Results</h1>
        <p className="max-w-2xl text-sm text-text-secondary">Baseline versus now, and only the money that has a documented action behind it. All figures come from your records.</p>
      </div>
    </div>
  );

  if (profileLoading || loading) {
    return <DashboardLayout activeLabel="Pilot Results"><div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">{header}<SkeletonCardList count={3} /></div></DashboardLayout>;
  }

  const fee = data ? computeFee(data.recovered.counted_cents, data.fee_pct) : null;

  return (
    <DashboardLayout activeLabel="Pilot Results">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        {header}
        {loadError ? (
          <EmptyState icon={ClipboardCheck} title="Couldn't load pilot results" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />
        ) : !data ? (
          <EmptyState
            icon={ClipboardCheck}
            title="Pilot not started"
            description={isOwner ? 'Starting the pilot saves a baseline from your current records. It cannot be edited afterwards.' : 'Ask the account owner to start the pilot.'}
            action={isOwner ? { label: busy ? 'Starting…' : 'Start pilot and save baseline', onClick: () => void onStart() } : undefined}
          />
        ) : (
          <div className="space-y-8">
            <section aria-labelledby="pr-compare">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h2 id="pr-compare" className="text-lg font-semibold text-text-primary">Baseline vs now <span className="ml-2 text-xs font-normal text-text-secondary">since {data.started_at.slice(0, 10)}</span></h2>
                <Button variant="secondary" size="sm" onClick={() => downloadResultsCsv(data)}><Download size={16} aria-hidden="true" /> CSV</Button>
              </div>
              <Card className="hover:translate-y-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs uppercase tracking-wide text-text-secondary"><th className="py-2 pr-3">Metric</th><th className="py-2 pr-3 text-right">Baseline</th><th className="py-2 pr-3 text-right">Now</th><th className="py-2 text-right">Change</th></tr></thead>
                  <tbody>
                    {compareFigures(data.baseline, data.now, data.estimate_fields).map((r) => (
                      <tr key={r.key} className="border-t border-border">
                        <td className="py-2 pr-3">{r.label}{r.estimate && <span className="ml-2 rounded-full bg-warning-500/10 px-2 py-0.5 text-xs text-warning-500">estimate</span>}</td>
                        <td className="py-2 pr-3 text-right">{formatValue(r, r.baseline, currency)}</td>
                        <td className="py-2 pr-3 text-right font-semibold">{formatValue(r, r.now, currency)}</td>
                        <td className={`py-2 text-right ${TREND_STYLE[r.trend]}`}>{r.delta === null ? '—' : `${r.delta > 0 ? '+' : ''}${r.kind === 'money' ? formatMoney(r.delta, currency) : r.delta}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-3 text-xs text-text-secondary">Warranty-eligible $ is the invoice total of eligible jobs, an upper bound of what can be claimed. Average days-to-pay uses {data.now.avg_days_sample} commercial invoices.</p>
              </Card>
            </section>

            <section aria-labelledby="pr-recovered">
              <h2 id="pr-recovered" className="mb-3 text-lg font-semibold text-text-primary">Recovered</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Card className="hover:translate-y-0"><p className="text-xs uppercase text-text-secondary">Recovered with documented action</p><p className="mt-1 text-2xl font-bold text-text-primary">{formatMoney(data.recovered.counted_cents, currency)}</p><p className="text-xs text-text-secondary">{data.recovered.counted_count} items</p></Card>
                <Card className="hover:translate-y-0"><p className="text-xs uppercase text-text-secondary">Not counted</p><p className="mt-1 text-2xl font-bold text-text-primary">{formatMoney(data.recovered.not_counted_cents, currency)}</p><p className="text-xs text-text-secondary">{data.recovered.not_counted_count} items with no preceding action</p></Card>
                <Card className="hover:translate-y-0"><p className="text-xs uppercase text-text-secondary">Hours spent (manual entry)</p><p className="mt-1 text-2xl font-bold text-text-primary">{hoursLabel(data.hours_minutes)}</p></Card>
              </div>
              <Card className="mt-4 hover:translate-y-0 overflow-x-auto">
                {data.recovered.rows.length === 0 ? <p className="text-sm text-text-secondary">No recoveries since the pilot started.</p> : (
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-xs uppercase tracking-wide text-text-secondary"><th className="py-2 pr-3">Item</th><th className="py-2 pr-3">Recovered</th><th className="py-2 pr-3">Preceding action</th><th className="py-2 text-right">Amount</th></tr></thead>
                    <tbody>
                      {data.recovered.rows.map((r) => (
                        <tr key={`${r.kind}-${r.ref_id}`} className="border-t border-border">
                          <td className="py-2 pr-3">{r.kind === 'invoice' ? 'Invoice' : 'Warranty claim'} {r.ref_label}</td>
                          <td className="py-2 pr-3">{r.recovered_on}</td>
                          <td className="py-2 pr-3">{r.action_kind ? `${ACTION_LABELS[r.action_kind]} · ${r.action_on}` : <span className="text-text-secondary">None, not counted</span>}</td>
                          <td className={`py-2 text-right ${r.counted ? 'font-semibold' : 'text-text-secondary'}`}>{formatMoney(r.amount_cents, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </section>

            <section aria-labelledby="pr-status" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <h2 id="pr-status" className="sr-only">Claims and invoices by status</h2>
              <StatusTable title="Warranty claims by status (claimed $)" data={data.claims_by_status} currency={currency} />
              <StatusTable title="Invoices by status" data={data.invoices_by_status} currency={currency} />
            </section>

            <section aria-labelledby="pr-hours">
              <h2 id="pr-hours" className="mb-3 text-lg font-semibold text-text-primary">Hours spent <span className="ml-2 text-xs font-normal text-text-secondary">manual entry</span></h2>
              <Card className="hover:translate-y-0">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Input label="Hours (1.5) or minutes (45m)" value={hoursInput} onChange={(e) => setHoursInput(e.target.value)} />
                  <Input label="Note (optional)" maxLength={200} value={hoursNote} onChange={(e) => setHoursNote(e.target.value)} />
                  <div className="flex items-end"><Button variant="secondary" onClick={() => void onAddHours()} disabled={busy}>{busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />} Add</Button></div>
                </div>
                {hours.length > 0 && (
                  <ul className="mt-4 divide-y divide-border text-sm">
                    {hours.map((h) => (
                      <li key={h.id} className="flex items-center justify-between py-2"><span>{h.entry_on} · {hoursLabel(h.minutes)}{h.note ? ` · ${h.note}` : ''}</span>
                        <button type="button" className="focus-ring rounded p-1 text-text-secondary hover:text-danger" aria-label="Delete entry" onClick={() => void onDeleteHours(h.id)}><Trash2 size={16} aria-hidden="true" /></button></li>
                    ))}
                  </ul>
                )}
              </Card>
            </section>

            <section aria-labelledby="pr-fee">
              <h2 id="pr-fee" className="mb-3 text-lg font-semibold text-text-primary">Fee calculator</h2>
              <Card className="hover:translate-y-0">
                <p className="text-sm text-text-secondary">A percentage of the recovered money that has a documented action. Shown for reference only. Vireek never charges it automatically.</p>
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Input label="Fee (%)" inputMode="decimal" value={feeInput} onChange={(e) => setFeeInput(e.target.value)} disabled={!isOwner} />
                  <div className="flex items-end">{isOwner && <Button variant="secondary" onClick={() => void onSaveFee()} disabled={busy}>Save</Button>}</div>
                  <div className="flex flex-col justify-end"><p className="text-xs uppercase text-text-secondary">Calculated fee</p><p className="text-xl font-bold text-text-primary">{fee === null ? 'Not set' : formatMoney(fee, currency)}</p></div>
                </div>
              </Card>
            </section>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

export default PilotResultsPage;
