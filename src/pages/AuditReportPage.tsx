import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { auditCall, AuditApiError } from '@/lib/audit/api';
import { printReport } from '@/lib/audit/print';
import type { Report, RevenueAtRisk } from '@/lib/audit/types';
import { formatCurrency, formatDateTime, formatPercent } from '@/lib/format';
import { useSEO } from '@/lib/seo';

const BAND_TEXT = { strong: 'Strong', fair: 'Needs work', leaking: 'Leaking calls', critical: 'Critical' } as const;
const SUB_LABEL: Record<string, string> = { answer_rate: 'Answer rate', speed_to_answer: 'Speed to answer', voicemail_quality: 'Voicemail quality', after_hours_coverage: 'After-hours coverage', booking_readiness: 'Booking readiness' };
const SEV_ICON = { good: '✓', info: 'i', warn: '!', critical: '!!' } as const;

function Gauge({ value, band }: { value: number | null; band: keyof typeof BAND_TEXT | null }) {
  const r = 54, c = 2 * Math.PI * r, pct = value === null ? 0 : Math.max(0, Math.min(100, value)) / 100;
  return (
    <figure className="relative mx-auto h-44 w-44" role="img" aria-label={value === null ? 'Score not available' : `Score ${value} out of 100, ${band ? BAND_TEXT[band] : ''}`}>
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="60" cy="60" r={r} fill="none" strokeWidth="10" className="stroke-border" />
        <circle cx="60" cy="60" r={r} fill="none" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${c * pct} ${c}`} className="stroke-accent" />
      </svg>
      <figcaption className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-extrabold text-text-primary">{value === null ? '—' : value}</span>
        <span className="text-sm font-semibold text-text-secondary">{band ? BAND_TEXT[band] : 'Not enough data'}</span>
      </figcaption>
    </figure>
  );
}

export function AuditReportPage({ shared = false }: { shared?: boolean }) {
  const { token = '' } = useParams();
  const nav = useNavigate();
  useSEO({ title: 'Your Missed-Call Audit | Vireek', description: 'Private Missed-Call Audit report.', canonical: 'https://vireek.com/audit', robots: 'noindex, nofollow' });
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const rep = await auditCall<Report>('report', shared ? { share_token: token } : { token });
      setR(rep); setErr(null);
      if (rep.provisional) timer.current = window.setTimeout(load, 15000);
    } catch (e) {
      if (e instanceof AuditApiError && e.status === 404) setGone(true);
      else setErr(e instanceof AuditApiError ? e.message : 'Could not load the report.');
    }
  }, [token, shared]);
  useEffect(() => { load(); return () => window.clearTimeout(timer.current); }, [load]);

  const act = async (fn: () => Promise<void>) => { setBusy(true); setNote(null); try { await fn(); } catch (e) { setNote(e instanceof AuditApiError ? e.message : 'Something went wrong.'); } finally { setBusy(false); } };

  if (gone) return (<><Header /><main className="min-h-screen bg-bg-primary px-6 pt-32"><div className="mx-auto max-w-xl text-center"><h1 className="text-3xl font-bold text-text-primary">This report isn't available</h1><p className="mt-4 text-text-secondary">The link may have expired, been deleted, or been mistyped. Reports are kept for 30 days.</p><div className="mt-6"><Link className="text-accent underline" to="/audit">Run a new audit</Link></div></div></main><Footer /></>);
  if (!r) return (<><Header /><main className="min-h-screen bg-bg-primary px-6 pt-32 text-center text-text-secondary" aria-live="polite">{err ?? 'Loading your report…'}</main><Footer /></>);

  const rev: RevenueAtRisk | undefined = r.revenue;
  const saveAssumptions = () => act(async () => {
    const a: Record<string, number> = {};
    for (const [k, v] of Object.entries(edits)) { const n = Number(v); if (v !== '' && isFinite(n)) a[k] = n; }
    await auditCall('assumptions', { token, assumptions: a });
    setEdits({}); await load();
  });

  return (
    <>
      <Header />
      <main className="min-h-screen bg-bg-primary pb-20 pt-28 print:pt-0">
        <article className="mx-auto max-w-3xl space-y-10 px-6">
          <header className="text-center">
            <p className="text-sm font-semibold uppercase tracking-wide text-accent">Missed-Call Audit{r.view === 'shared' ? ' · shared view' : ''}</p>
            <h1 className="mt-2 text-3xl font-extrabold text-text-primary">{r.business_name}</h1>
            {r.provisional && <p role="status" className="mt-3 rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-primary">Your test calls are still running, so this report is provisional. It refreshes automatically.</p>}
            {r.score.confidence !== 'ok' && !r.provisional && <p className="mt-3 text-sm text-text-secondary">Limited data: {r.score.conclusive_calls} usable test call{r.score.conclusive_calls === 1 ? '' : 's'}. Treat this score as a rough indication.</p>}
          </header>

          <section aria-labelledby="score-h"><h2 id="score-h" className="sr-only">Overall score</h2><Gauge value={r.score.total} band={r.score.band} /></section>

          <section aria-labelledby="sub-h">
            <h2 id="sub-h" className="text-xl font-bold text-text-primary">How the score is made</h2>
            <ul className="mt-4 space-y-3">
              {Object.entries(r.score.sub).map(([k, s]) => (
                <li key={k} className="rounded-xl border border-border p-4">
                  <div className="flex items-baseline justify-between"><span className="font-semibold text-text-primary">{SUB_LABEL[k] ?? k}</span><span className="text-text-primary">{s.score === null ? 'Not measured' : `${s.score}/100`}</span></div>
                  <p className="mt-1 text-sm text-text-secondary">{s.basis}</p>
                </li>
              ))}
            </ul>
            {r.not_tested.length > 0 && <p className="mt-3 text-sm text-text-secondary">Not tested: {r.not_tested.map((c) => c.replace('_', ' ')).join(', ')}. Untested conditions never count against you.</p>}
          </section>

          <section aria-labelledby="find-h">
            <h2 id="find-h" className="text-xl font-bold text-text-primary">What we found</h2>
            <ul className="mt-4 space-y-3">
              {r.score.findings.map((f) => (
                <li key={f.id} className="rounded-xl border border-border p-4"><p className="font-semibold text-text-primary"><span aria-hidden className="mr-2">{SEV_ICON[f.severity]}</span><span className="sr-only">{f.severity}: </span>{f.title}</p><p className="mt-1 text-sm text-text-secondary">{f.detail}</p></li>
              ))}
            </ul>
          </section>

          {r.score.fix_path.length > 0 && (
            <section aria-labelledby="fix-h"><h2 id="fix-h" className="text-xl font-bold text-text-primary">Your fix path</h2>
              <ol className="mt-4 list-decimal space-y-3 pl-5">{r.score.fix_path.map((s) => <li key={s.id}><span className="font-semibold text-text-primary">{s.title}</span><p className="text-sm text-text-secondary">{s.detail}</p></li>)}</ol>
            </section>
          )}

          <section aria-labelledby="tl-h"><h2 id="tl-h" className="text-xl font-bold text-text-primary">Timeline</h2>
            <ol className="mt-4 space-y-2 border-l border-border pl-4">{r.timeline.map((e, i) => <li key={i} className="text-sm"><time dateTime={e.at} className="text-text-secondary">{formatDateTime(e.at, { dateStyle: 'medium', timeStyle: 'short', timeZone: r.timezone })}</time> — <span className="text-text-primary">{e.label}</span></li>)}</ol>
          </section>

          {rev && (
            <section aria-labelledby="rev-h">
              <h2 id="rev-h" className="text-xl font-bold text-text-primary">Revenue at risk (estimate)</h2>
              <p className="mt-2 text-text-primary">About <strong>{formatCurrency(rev.monthly.point, 'USD', { maximumFractionDigits: 0 })}</strong> a month (likely range {formatCurrency(rev.monthly.low, 'USD', { maximumFractionDigits: 0 })}–{formatCurrency(rev.monthly.high, 'USD', { maximumFractionDigits: 0 })}); {formatCurrency(rev.annual.point, 'USD', { maximumFractionDigits: 0 })} a year. Estimated miss rate {formatPercent(rev.miss_rate.point)} from {rev.sample_size} usable call{rev.sample_size === 1 ? '' : 's'}.</p>
              {rev.is_placeholder && <p className="mt-2 rounded-xl border border-border bg-bg-secondary p-3 text-sm text-text-primary">This uses placeholder numbers for call volume, job value and conversion. Replace them with yours for a meaningful figure.</p>}
              {r.view === 'owner' && (
                <form className="mt-4 grid gap-3 sm:grid-cols-2 print:hidden" onSubmit={(e) => { e.preventDefault(); saveAssumptions(); }}>
                  {rev.assumptions.map((a) => (
                    <Input key={a.key} label={`${a.label}${a.source === 'default' ? ' (placeholder)' : ''}`} inputMode="decimal" value={edits[a.key] ?? String(a.value)} onChange={(e) => setEdits({ ...edits, [a.key]: e.target.value })} helperText={a.unit} />
                  ))}
                  <div className="sm:col-span-2"><Button type="submit" loading={busy} disabled={Object.keys(edits).length === 0}>Recalculate</Button></div>
                </form>
              )}
              <ul className="mt-3 list-disc pl-5 text-xs text-text-secondary">{rev.notes.map((n) => <li key={n}>{n}</li>)}</ul>
              {r.benchmark && <p className="mt-3 text-sm text-text-secondary">Across {r.benchmark.n} audits the median score is {Math.round(r.benchmark.total_p50)}.</p>}
            </section>
          )}

          {r.view === 'owner' && (
            <section className="space-y-4 print:hidden" aria-labelledby="act-h">
              <h2 id="act-h" className="text-xl font-bold text-text-primary">Next</h2>
              <div className="flex flex-wrap gap-3">
                {r.trial_url && <a className="focus-ring inline-flex min-h-[48px] items-center rounded-xl bg-accent px-5 py-3 font-semibold text-white" href={r.trial_url}>See how Vireek would answer these calls</a>}
                <Button variant="secondary" onClick={printReport}>Download PDF</Button>
                <Button variant="secondary" loading={busy} onClick={() => act(async () => { const x = await auditCall<{ share_token: string | null }>('share', { token, enable: !r.share_enabled }); setShareUrl(x.share_token ? `${window.location.origin}/audit/share/${x.share_token}` : null); await load(); })}>{r.share_enabled ? 'Stop sharing' : 'Create share link'}</Button>
                {r.can_cancel && <Button variant="secondary" loading={busy} onClick={() => act(async () => { await auditCall('cancel', { token }); await load(); })}>Cancel remaining calls</Button>}
                <Button variant="danger" loading={busy} onClick={() => { if (window.confirm('Delete this audit and all its data? This cannot be undone.')) act(async () => { await auditCall('delete', { token }); nav('/audit'); }); }}>Delete my data</Button>
              </div>
              {shareUrl && <p className="break-all text-sm text-text-primary" role="status">Share link (hides your revenue estimate and contact details): <code>{shareUrl}</code></p>}
              {r.share_enabled && !shareUrl && <p className="text-sm text-text-secondary">Sharing is on. Stop sharing to revoke the link.</p>}
              {note && <p role="alert" className="text-sm text-danger">{note}</p>}
              <p className="text-xs text-text-secondary">Report for {r.masked_phone}. Kept until {formatDateTime(r.expires_at, { dateStyle: 'medium' })}, then deleted automatically.</p>
            </section>
          )}
        </article>
      </main>
      <Footer />
    </>
  );
}
