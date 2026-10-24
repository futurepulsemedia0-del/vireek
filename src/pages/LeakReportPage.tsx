import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, Download, FileUp, Lock, PhoneMissed, Plus, RefreshCw, Share2, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyStateError } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonStatGrid } from '@/components/Skeleton';
import { useLeakReport } from '@/hooks/useLeakReport';
import {
  SOURCE_KIND_LABELS,
  createSource,
  deleteAllLeakEvents,
  deleteSource,
  fetchLedgerSummary,
  fetchSources,
  importCallLog,
  ingestEndpointUrl,
  saveLeakSettings,
  setSourceEnabled,
  startLeakReport,
  type LeakData,
  type LeakSource,
} from '@/lib/leakReportApi';
import { buildLeakReportPdf, leakReportFileName } from '@/lib/leakReportPdf';
import {
  DAY_NAMES,
  formatDuration,
  formatUsd,
  hourLabel,
  isValidTimeZone,
  type DayBucket,
  type HourBucket,
} from '../../supabase/functions/_shared/leak-report/core';

const card = 'rounded-2xl border border-border bg-bg-secondary p-5';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={card}>
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-text-primary">{value}</p>
      {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

function Bars({ buckets, label, labelOf }: { buckets: (HourBucket | DayBucket)[]; label: string; labelOf: (i: number) => string }) {
  const max = Math.max(1, ...buckets.map((b) => b.total));
  return (
    <div role="img" aria-label={label} className="flex h-32 items-end gap-0.5">
      {buckets.map((b, i) => (
        <div key={i} title={`${labelOf(i)}: ${b.total} calls, ${b.missed} missed`} className="flex h-full flex-1 flex-col justify-end">
          <div className="w-full rounded-t bg-accent/25" style={{ height: `${(b.total / max) * 100}%` }}>
            <div className="w-full rounded-t bg-danger" style={{ height: `${b.total ? (b.missed / b.total) * 100 : 0}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const TICKET_LABEL: Record<LeakData['ticketSource'], string> = {
  override: 'entered by you',
  jobs: 'from your invoiced jobs',
  profile: 'from your business profile',
  none: '',
};

export function LeakReportPage() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const { state, reload, accountOwnerId, canAccess } = useLeakReport(60_000);
  const businessName = (profile as { company_name?: string | null } | null)?.company_name ?? '';

  const [tz, setTz] = useState('');
  const [ticket, setTicket] = useState('');
  const [rate, setRate] = useState('30');
  const [busy, setBusy] = useState(false);
  const [sources, setSources] = useState<LeakSource[]>([]);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<LeakSource['kind']>('call_tracking');
  const [reveal, setReveal] = useState<{ token: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [ledger, setLedger] = useState<{ openCount: number; openValueCents: number } | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'restart' | null>(null);
  const synced = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const data = state.status === 'ready' ? state.data : null;
  const enabled = Boolean(data?.settings.enabled);

  useEffect(() => {
    if (!data || synced.current) return;
    synced.current = true;
    setTz(data.settings.timezone);
    setTicket(data.settings.avg_ticket_cents ? String(data.settings.avg_ticket_cents / 100) : '');
    setRate(String(Math.round(data.settings.close_rate_bps / 100)));
  }, [data]);

  useEffect(() => {
    if (!accountOwnerId || !enabled) return;
    let cancelled = false;
    void fetchSources(accountOwnerId).then((s) => !cancelled && setSources(s)).catch(() => undefined);
    void fetchLedgerSummary().then((l) => !cancelled && setLedger(l));
    return () => {
      cancelled = true;
    };
  }, [accountOwnerId, enabled]);

  function parseAssumptions(): { ok: true; ticketCents: number | null; bps: number } | { ok: false; message: string } {
    if (!isValidTimeZone(tz.trim())) return { ok: false, message: 'Enter a valid time zone, for example America/Chicago.' };
    const t = ticket.trim();
    let ticketCents: number | null = null;
    if (t !== '') {
      const n = Number(t);
      if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return { ok: false, message: 'Average ticket must be between $1 and $1,000,000.' };
      ticketCents = Math.round(n * 100);
    }
    const pct = Number(rate);
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) return { ok: false, message: 'Close rate must be between 1% and 100%.' };
    return { ok: true, ticketCents, bps: Math.round(pct * 100) };
  }

  async function run(fn: () => Promise<void>, okMessage?: string) {
    setBusy(true);
    try {
      await fn();
      if (okMessage) toast(okMessage, 'success');
      await reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onStart() {
    const a = parseAssumptions();
    if (!a.ok) return toast(a.message, 'error');
    if (!accountOwnerId) return;
    await run(
      async () => {
        await startLeakReport(accountOwnerId, { timezone: tz.trim(), avg_ticket_cents: a.ticketCents, close_rate_bps: a.bps });
      },
      'Leak Report started',
    );
  }

  async function onSaveAssumptions() {
    const a = parseAssumptions();
    if (!a.ok) return toast(a.message, 'error');
    if (!accountOwnerId) return;
    await run(
      async () => {
        await saveLeakSettings(accountOwnerId, { timezone: tz.trim(), avg_ticket_cents: a.ticketCents, close_rate_bps: a.bps });
      },
      'Assumptions saved',
    );
  }

  async function onCreateSource() {
    if (!accountOwnerId) return;
    setBusy(true);
    try {
      const { source, token } = await createSource(accountOwnerId, { name: newName, kind: newKind });
      setSources((p) => [source, ...p]);
      setReveal({ token, name: source.name });
      setNewName('');
      toast('Connection created. Copy the token now; it is shown only once.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the connection', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function onImport(file: File | undefined) {
    if (!file || !accountOwnerId) return;
    if (file.size > 2 * 1024 * 1024) return toast('That file is larger than 2 MB.', 'error');
    await run(async () => {
      const res = await importCallLog(accountOwnerId, await file.text());
      if (res.processed === 0) throw new Error('No valid calls found. The file needs a date/time column and a phone column.');
      toast(`Imported ${res.processed} calls${res.rejected ? `, skipped ${res.rejected} rows` : ''}.`, 'success');
    });
    if (fileRef.current) fileRef.current.value = '';
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('Could not copy. Select the text and copy it manually.', 'error');
    }
  }

  function buildPdf(d: LeakData) {
    const generatedAt = new Date().toISOString();
    const doc = buildLeakReportPdf(
      {
        businessName,
        periodStart: d.windowStart ?? generatedAt,
        periodEnd: d.windowEnd ?? generatedAt,
        generatedAt,
        ticketLabel: TICKET_LABEL[d.ticketSource],
      },
      d.report,
    );
    return { doc, name: leakReportFileName(businessName, generatedAt) };
  }

  async function onShare(d: LeakData) {
    const { doc, name } = buildPdf(d);
    const file = new File([doc.output('blob')], name, { type: 'application/pdf' });
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Missed-Call Leak Report' });
        return;
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return;
      }
    }
    doc.save(name);
  }

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Leak Report">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h2 className="mt-4 text-lg font-semibold text-text-primary">Restricted</h2>
          <p className="mt-1 max-w-sm text-sm text-text-secondary">Ask the account owner for access to the Leak Report.</p>
        </div>
      </DashboardLayout>
    );
  }

  const r = data?.report;
  const curl = reveal
    ? `curl -X POST '${ingestEndpointUrl()}' \\\n  -H 'X-Vireek-Token: ${reveal.token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"id":"call-1","direction":"inbound","from":"+14155550100","started_at":"${new Date().toISOString()}","answered":false}'`
    : '';

  const assumptionsForm = (
    <div className="grid gap-4 sm:grid-cols-3">
      <Input label="Time zone" value={tz} onChange={(e) => setTz(e.target.value)} helperText="IANA name, e.g. America/Chicago" />
      <Input label="Average ticket (USD)" type="number" min="1" value={ticket} onChange={(e) => setTicket(e.target.value)} helperText="Leave blank to use your invoiced jobs or profile" />
      <Input label="Close rate (%)" type="number" min="1" max="100" value={rate} onChange={(e) => setRate(e.target.value)} helperText="Share of callers who would have booked" />
    </div>
  );

  return (
    <DashboardLayout activeLabel="Leak Report">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Leak Report</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Measure the calls you are losing during your first {data?.settings.window_days ?? 7} days, without changing your phone setup.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => void reload()} disabled={busy}><RefreshCw size={16} /> Refresh</Button>
            {data && data.phase !== 'off' && data.phase !== 'waiting' && (
              <>
                <Button variant="secondary" size="sm" onClick={() => buildPdf(data).doc.save(buildPdf(data).name)}><Download size={16} /> PDF</Button>
                <Button size="sm" onClick={() => void onShare(data)}><Share2 size={16} /> Share</Button>
              </>
            )}
          </div>
        </div>

        {state.status === 'loading' && <SkeletonStatGrid count={4} />}
        {state.status === 'error' && <EmptyStateError icon={PhoneMissed} title="Could not load the Leak Report" description={state.message} onRetry={() => void reload()} />}

        {data && data.phase === 'off' && (
          <section className={card} aria-labelledby="leak-start">
            <h2 id="leak-start" className="text-base font-semibold text-text-primary">Start your Leak Report</h2>
            <p className="mt-1 text-sm text-text-secondary">
              We only observe copies of your calls (call-tracking, forwarded copies or an imported call log). Your numbers and routing stay as they are.
            </p>
            <div className="mt-4">{assumptionsForm}</div>
            <Button className="mt-4" onClick={() => void onStart()} disabled={busy}>Start report</Button>
          </section>
        )}

        {data && data.phase !== 'off' && r && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-secondary">
              <p>
                {data.phase === 'complete' ? 'Final report' : `Day ${data.dayNumber} of ${data.settings.window_days}`}
                {r.observedDays > 0 ? ` · ${r.observedDays} days observed` : ''}
              </p>
              <button type="button" onClick={() => setConfirm('restart')} className="focus-ring rounded-lg px-2 py-1 hover:text-text-primary">Restart report</button>
            </div>

            {data.phase === 'waiting' ? (
              <div className={`${card} text-sm text-text-secondary`}>
                No calls received yet. Connect a call source or import your call log below; this page updates automatically.
              </div>
            ) : (
              <>
                <section className={`${card} border-danger/30 bg-danger/5`} aria-labelledby="leak-hero">
                  <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">
                    {r.estimatedLostCents !== null ? 'Estimated revenue lost' : 'Callers never reached'}
                  </p>
                  <p id="leak-hero" className="mt-1 text-4xl font-bold text-danger">
                    {r.estimatedLostCents !== null ? formatUsd(r.estimatedLostCents) : String(r.lostCallers)}
                  </p>
                  <p className="mt-2 text-sm text-text-primary">
                    {r.lostCallers} caller{r.lostCallers === 1 ? '' : 's'} never got a callback or an answered retry within 72 hours.
                    {r.ceilingLostCents !== null && ` Up to ${formatUsd(r.ceilingLostCents)} if every one had booked.`}
                    {r.annualizedLostCents !== null && ` At this pace: ${formatUsd(r.annualizedLostCents)} per year.`}
                  </p>
                  {r.estimatedLostCents === null && (
                    <p className="mt-2 text-sm text-text-secondary">Add your average ticket below to turn this into dollars.</p>
                  )}
                </section>

                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Stat label="Answer rate" value={r.answerRate === null ? '-' : `${r.answerRate}%`} hint={`${r.answered} of ${r.inboundTotal} calls`} />
                  <Stat label="Missed calls" value={String(r.missed)} hint={`${r.voicemails} voicemail`} />
                  <Stat label="After-hours missed" value={String(r.afterHoursMissed)} hint={`of ${r.afterHoursTotal} after-hours calls`} />
                  <Stat label="Avg first response" value={formatDuration(r.avgFirstResponseSeconds)} hint={`Median callback ${formatDuration(r.medianCallbackSeconds)}`} />
                </div>

                <section className={card} aria-labelledby="leak-hours">
                  <h2 id="leak-hours" className="text-base font-semibold text-text-primary">Calls by hour (missed in red)</h2>
                  <div className="mt-4"><Bars buckets={r.byHour} label="Calls by hour of day, missed calls highlighted" labelOf={(i) => hourLabel(i)} /></div>
                  <div className="mt-1 flex justify-between text-xs text-text-secondary"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>11 PM</span></div>
                </section>

                <section className={card} aria-labelledby="leak-days">
                  <h2 id="leak-days" className="text-base font-semibold text-text-primary">Calls by day (missed in red)</h2>
                  <div className="mt-4"><Bars buckets={r.byDay} label="Calls by day of week, missed calls highlighted" labelOf={(i) => DAY_NAMES[i]} /></div>
                  <div className="mt-1 flex text-xs text-text-secondary">{DAY_NAMES.map((d) => <span key={d} className="flex-1 text-center">{d.slice(0, 3)}</span>)}</div>
                </section>

                <section className={card}>
                  <h2 className="text-base font-semibold text-text-primary">What you could recover now</h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    {ledger
                      ? `Your Recovery Ledger already tracks ${ledger.openCount} open follow-ups worth ${formatUsd(ledger.openValueCents)}.`
                      : 'Follow up on missed callers before they go elsewhere.'}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-4 text-sm font-semibold">
                    <Link className="text-accent" to="/dashboard/recovery">Open Recovery Ledger</Link>
                    <Link className="text-accent" to="/roi">See what customers recovered</Link>
                  </div>
                </section>
              </>
            )}

            <section className={card} aria-labelledby="leak-assume">
              <h2 id="leak-assume" className="text-base font-semibold text-text-primary">Assumptions</h2>
              <p className="mt-1 text-sm text-text-secondary">
                {data.ticketSource === 'none'
                  ? 'No average ticket found yet.'
                  : `Average ticket ${formatUsd(r.avgTicketCents)} (${TICKET_LABEL[data.ticketSource]}${data.ticketSource === 'jobs' ? `, ${data.ticketJobCount} jobs` : ''}).`}
              </p>
              <div className="mt-4">{assumptionsForm}</div>
              <Button className="mt-4" variant="secondary" size="sm" onClick={() => void onSaveAssumptions()} disabled={busy}>Save assumptions</Button>
            </section>

            <section className={card} aria-labelledby="leak-connect">
              <h2 id="leak-connect" className="text-base font-semibold text-text-primary">Connect your calls</h2>
              <p className="mt-1 text-sm text-text-secondary">Pick any option. None of them touch your phone numbers or routing.</p>

              <div className="mt-4 rounded-xl border border-border p-4">
                <p className="text-sm font-medium text-text-primary">Import a call log (instant report)</p>
                <p className="mt-1 text-xs text-text-secondary">CSV export from your carrier or phone system, max 2 MB. Needs a date/time and a phone column; direction, status and duration are used when present.</p>
                <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" id="leak-csv" onChange={(e) => void onImport(e.target.files?.[0])} />
                <Button className="mt-3" variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}><FileUp size={16} /> Choose CSV</Button>
              </div>

              <div className="mt-4 rounded-xl border border-border p-4">
                <p className="text-sm font-medium text-text-primary">Live webhook (call-tracking or forwarded copies)</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
                  <Input label="Name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="CallRail, Twilio, Zapier..." />
                  <select aria-label="Connection type" value={newKind} onChange={(e) => setNewKind(e.target.value as LeakSource['kind'])} className="focus-ring rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary">
                    {(Object.keys(SOURCE_KIND_LABELS) as LeakSource['kind'][]).map((k) => <option key={k} value={k}>{SOURCE_KIND_LABELS[k]}</option>)}
                  </select>
                  <Button onClick={() => void onCreateSource()} disabled={busy || newName.trim().length < 2}><Plus size={16} /> Create</Button>
                </div>

                {reveal && (
                  <div className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
                    <p className="font-medium text-text-primary">Token for {reveal.name} (shown once)</p>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-xs text-text-primary">{curl}</pre>
                    <p className="mt-2 text-xs text-text-secondary">Twilio or tools that cannot set headers: append ?token=YOUR_TOKEN to the URL.</p>
                    <Button className="mt-2" variant="secondary" size="sm" onClick={() => void copy(curl)}>
                      {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                )}

                {sources.length > 0 && (
                  <ul className="mt-4 divide-y divide-border">
                    {sources.map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-3 py-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-text-primary">{s.name} · …{s.token_hint}</p>
                          <p className="text-xs text-text-secondary">{SOURCE_KIND_LABELS[s.kind]} · {s.last_event_at ? `last call ${new Date(s.last_event_at).toLocaleString()}` : 'no calls yet'}</p>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="secondary" onClick={() => void run(() => setSourceEnabled(s.id, !s.enabled).then(() => setSources((p) => p.map((x) => (x.id === s.id ? { ...x, enabled: !s.enabled } : x)))))}>{s.enabled ? 'Pause' : 'Resume'}</Button>
                          <Button size="sm" variant="ghost" aria-label={`Delete ${s.name}`} onClick={() => void run(() => deleteSource(s.id).then(() => setSources((p) => p.filter((x) => x.id !== s.id))), 'Connection deleted')}><Trash2 size={16} /></Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => setConfirm('delete')}><Trash2 size={16} /> Delete collected call data</Button>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete all collected call data?"
        description="This permanently removes every call event collected for the Leak Report. Your Vireek call history is not affected."
        confirmPhrase="delete call data"
        confirmLabel="Delete call data"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          if (accountOwnerId) await run(() => deleteAllLeakEvents(accountOwnerId), 'Call data deleted');
        }}
      />
      <ConfirmDialog
        open={confirm === 'restart'}
        title="Restart the Leak Report?"
        description="The 7-day window starts again from now. Previously collected calls stay on file but fall outside the new window."
        confirmLabel="Restart"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          if (accountOwnerId) await run(async () => { await saveLeakSettings(accountOwnerId, { started_at: new Date().toISOString() }); }, 'Report restarted');
        }}
      />
    </DashboardLayout>
  );
}
