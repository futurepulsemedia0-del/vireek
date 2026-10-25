import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, PhoneCall } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonStatGrid, SkeletonTable } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  computeMetrics, formatCents, formatPercent, isValidTrackingCode, totalReport, type CampaignReportRow,
} from '@/lib/directMail';
import { fetchReport, recordResponse } from '@/lib/directMailApi';

const RANGES = [{ days: 30, label: '30 days' }, { days: 90, label: '90 days' }, { days: 365, label: '12 months' }];

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-xl font-semibold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function LogResponse({ onLogged }: { onLogged: () => void }) {
  const { toast } = useToast();
  const [code, setCode] = useState('');
  const [kind, setKind] = useState('call');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = isValidTrackingCode(code);
  const touched = code.trim().length >= 9;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const res = await recordResponse(code, kind, note.trim());
      toast(`Logged for ${res.recipient_name} (${res.campaign_name}).`, 'success');
      setCode('');
      setNote('');
      onLogged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not log the response.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-label="Log an offline response">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary"><PhoneCall size={16} className="text-accent" /> Log a phone or walk-in response</h3>
      <p className="mt-1 text-xs text-text-secondary">When a caller quotes the offer code printed on the postcard, enter it here so the response is credited to that mailer.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto] sm:items-end">
        <Input label="Offer code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD-EFGH-J" autoComplete="off"
          error={touched && !valid ? 'This code looks mistyped — check it against the card.' : undefined} />
        <label className="block text-xs font-medium text-text-secondary">
          Type
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="focus-ring mt-1 block w-full rounded-xl border border-border bg-bg-primary px-3 py-3 text-base text-text-primary">
            <option value="call">Phone call</option>
            <option value="walk_in">Walk-in</option>
            <option value="other">Other</option>
          </select>
        </label>
        <Input label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        <Button size="sm" onClick={() => void submit()} disabled={!valid || busy}>{busy ? 'Logging…' : 'Log response'}</Button>
      </div>
    </section>
  );
}

export function ResultsPanel() {
  const [days, setDays] = useState(90);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [rows, setRows] = useState<CampaignReportRow[]>([]);

  const load = useCallback(async () => {
    setState('loading');
    try {
      setRows(await fetchReport(days));
      setState('ready');
    } catch {
      setState('error');
    }
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  const total = useMemo(() => totalReport(rows), [rows]);
  const m = useMemo(() => computeMetrics(total), [total]);
  const estimated = rows.some((r) => r.cost_estimated_pieces > 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-text-secondary">Responses are attributed by the unique code on each mailer — scans, landing-page leads and bookings, and logged calls.</p>
        <div role="group" aria-label="Date range" className="flex gap-1 rounded-xl border border-border bg-bg-secondary p-1">
          {RANGES.map((r) => (
            <button key={r.days} type="button" aria-pressed={days === r.days} onClick={() => setDays(r.days)}
              className={`focus-ring rounded-lg px-3 py-1.5 text-xs font-medium ${days === r.days ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>{r.label}</button>
          ))}
        </div>
      </div>

      {state === 'loading' && (<><SkeletonStatGrid count={4} /><SkeletonTable rows={4} columns={6} /></>)}
      {state === 'error' && <EmptyStateError icon={BarChart3} title="Couldn't load results" onRetry={() => void load()} />}
      {state === 'ready' && rows.length === 0 && (
        <EmptyState icon={BarChart3} title="No campaigns in this period" description="Send your first postcard campaign and its results will appear here." />
      )}

      {state === 'ready' && rows.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Mailers sent" value={total.mailed.toLocaleString()} hint={`${total.delivered.toLocaleString()} delivered`} />
            <Stat label="Response rate" value={formatPercent(m.responseRate)} hint={`${total.responders} responding mailers`} />
            <Stat label="Booked jobs" value={total.booked_jobs.toLocaleString()} hint={`${total.completed_jobs} completed`} />
            <Stat label="Cost per booked job" value={formatCents(m.costPerBookedJob)} hint={`Total spend ${formatCents(total.cost_cents)}`} />
          </div>
          {estimated && <p className="text-xs text-warning-500">Some costs are your per-mailer estimate because the print provider did not return a price.</p>}

          <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
            <table className="w-full min-w-[820px] text-left text-xs">
              <thead className="border-b border-border text-text-secondary">
                <tr>
                  {['Campaign', 'Mailed', 'Scans', 'Leads', 'Booked jobs', 'Response', 'Cost', 'Cost / job', 'Revenue'].map((h) => (
                    <th key={h} scope="col" className="px-3 py-2.5 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const x = computeMetrics(r);
                  return (
                    <tr key={r.campaign_id} className="border-b border-border/60 last:border-0">
                      <th scope="row" className="px-3 py-2.5 font-medium text-text-primary">{r.name}</th>
                      <td className="px-3 py-2.5">{r.mailed.toLocaleString()}</td>
                      <td className="px-3 py-2.5">{r.scanned_pieces.toLocaleString()} <span className="text-text-secondary">({formatPercent(x.scanRate)})</span></td>
                      <td className="px-3 py-2.5">{r.leads}</td>
                      <td className="px-3 py-2.5">{r.booked_jobs}</td>
                      <td className="px-3 py-2.5">{formatPercent(x.responseRate)}</td>
                      <td className="px-3 py-2.5">{formatCents(r.cost_cents)}{x.costIsEstimate ? '*' : ''}</td>
                      <td className="px-3 py-2.5">{formatCents(x.costPerBookedJob)}</td>
                      <td className="px-3 py-2.5">{formatCents(Math.round(r.revenue * 100))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-text-secondary">Revenue counts invoiced amounts of completed attributed jobs. A scan is not counted as a response until the person submits a lead or books.</p>
        </>
      )}

      <LogResponse onLogged={() => void load()} />
    </div>
  );
}
