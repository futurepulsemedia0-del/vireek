// Recreated: verify against original intent
// /dashboard/revenue-autopsy
//
// Why lost or written-off revenue was lost: findings per recovery event, a pattern library by root cause, and a
// review step where a person confirms or corrects the detected cause. Data and aggregation live in
// src/lib/revenueAutopsy.ts; nothing here recomputes money.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Microscope } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  CONFIDENCE_LABELS,
  ROOT_CAUSE_COLORS,
  ROOT_CAUSE_LABELS,
  ROOT_CAUSE_PREVENTION,
  buildPatternLibrary,
  computeStats,
  fetchFindings,
  formatCents,
  relativeTime,
  reviewFinding,
  runBackfill,
  type AutopsyFinding,
  type RootCause,
} from '@/lib/revenueAutopsy';

const card = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const field = 'focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary';
const lab = 'mb-1 block text-xs font-semibold text-text-secondary';
const btn = 'focus-ring min-h-[40px] rounded-lg px-3 text-sm font-semibold disabled:opacity-50';
const CAUSES = Object.keys(ROOT_CAUSE_LABELS) as RootCause[];
const PRESENTED = (c: AutopsyFinding['confidence']) => CONFIDENCE_LABELS[c] ?? c;

function trend(last: number, prior: number): string | null {
  if (last === 0 && prior === 0) return null;
  if (prior === 0) return 'New in the last 30 days';
  const pct = Math.round(((last - prior) / prior) * 100);
  return pct === 0 ? 'Flat vs. the 30 days before' : `${pct > 0 ? '+' : ''}${pct}% vs. the 30 days before`;
}

export function RevenueAutopsyPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [findings, setFindings] = useState<AutopsyFinding[] | null>(null);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<'review' | 'all'>('review');
  const [editing, setEditing] = useState<string | null>(null);
  const [cause, setCause] = useState<RootCause>('unknown');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(false);
    try {
      const f = await fetchFindings();
      if (mine === seq.current) setFindings(f);
    } catch {
      if (mine === seq.current) setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => { seq.current++; };
  }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(key);
    try {
      await fn();
    } catch {
      toast('That did not work. Try again.', 'error');
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };

  const stats = useMemo(() => computeStats(findings ?? []), [findings]);
  const patterns = useMemo(() => buildPatternLibrary(findings ?? []), [findings]);
  const shown = useMemo(
    () => (findings ?? []).filter((f) => filter === 'all' || (!f.reviewed && f.confidence !== 'confirmed')),
    [findings, filter],
  );

  const startEdit = (f: AutopsyFinding) => {
    setEditing(f.id);
    setCause(f.root_cause);
    setNote(f.prevention_note ?? '');
  };

  const confirm = (f: AutopsyFinding, changed: boolean, noteOverride?: string) =>
    run(`c-${f.id}`, async () => {
      if (!user) throw new Error('not signed in');
      const trimmed = (noteOverride ?? note).trim();
      await reviewFinding(f.id, changed ? { root_cause: cause, ...(trimmed ? { prevention_note: trimmed } : {}) } : trimmed ? { prevention_note: trimmed } : {}, user.id);
      toast('Finding confirmed.', 'success');
      setEditing(null);
      await load();
    });

  return (
    <DashboardLayout activeLabel="Revenue Autopsy">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><Microscope size={22} aria-hidden="true" /> Revenue autopsy</h1>
          <p className="mt-1 text-sm text-text-secondary">Why revenue slipped away, so the same cause is not paid for twice.</p>
        </div>
        <button
          type="button"
          className={`${btn} border border-border text-text-primary`}
          disabled={busy !== null}
          onClick={() => void run('backfill', async () => { const n = await runBackfill(); toast(n > 0 ? `Analysed ${n} earlier write-off${n === 1 ? '' : 's'}.` : 'Nothing new to analyse.', n > 0 ? 'success' : 'info'); await load(); })}
        >
          {busy === 'backfill' ? 'Analysing…' : 'Analyse earlier write-offs'}
        </button>
      </div>

      {error && <p role="alert" className="mb-4 rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger">Could not load findings. <button type="button" onClick={() => void load()} className="focus-ring font-semibold underline">Try again</button></p>}
      {!findings && !error && <p role="status" className="py-6 text-sm text-text-secondary">Loading…</p>}

      {findings && (
        <>
          <dl className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ['Cases', String(stats.totalCases)],
              ['Revenue lost', formatCents(stats.totalCents)],
              ['Need review', String(stats.needsReviewCount)],
              ['Top cause', stats.topCause ? ROOT_CAUSE_LABELS[stats.topCause] : '—'],
            ].map(([k, v]) => (
              <div key={k} className={card}><dt className="text-xs font-semibold text-text-secondary">{k}</dt><dd className="mt-1 break-words text-lg font-bold text-text-primary">{v}</dd></div>
            ))}
          </dl>

          {patterns.length > 0 && (
            <section className={`${card} mb-6`} aria-labelledby="ra-patterns">
              <h2 id="ra-patterns" className="text-base font-semibold text-text-primary">Pattern library</h2>
              <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
                {patterns.map((p) => {
                  const t = trend(p.last30Cents, p.prior30Cents);
                  return (
                    <li key={p.root_cause} className="px-3 py-3 text-sm">
                      <p className="flex flex-wrap items-center justify-between gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ROOT_CAUSE_COLORS[p.root_cause]}`}>{ROOT_CAUSE_LABELS[p.root_cause]}</span>
                        <span className="font-semibold text-text-primary">{formatCents(p.totalCents)} · {p.count} case{p.count === 1 ? '' : 's'}</span>
                      </p>
                      <p className="mt-1 text-xs text-text-secondary">{ROOT_CAUSE_PREVENTION[p.root_cause]}</p>
                      <p className="mt-1 text-xs text-text-secondary">{[t, p.needsReviewCount > 0 ? `${p.needsReviewCount} awaiting review` : null].filter(Boolean).join(' · ')}</p>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className={card} aria-labelledby="ra-cases">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="ra-cases" className="text-base font-semibold text-text-primary">Cases</h2>
              <div role="group" aria-label="Filter cases" className="flex gap-1">
                {(['review', 'all'] as const).map((f) => (
                  <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={`${btn} border ${filter === f ? 'border-accent text-accent' : 'border-border text-text-secondary'}`}>{f === 'review' ? 'Needs review' : 'All'}</button>
                ))}
              </div>
            </div>

            {shown.length === 0 ? (
              <p className="mt-4 text-sm text-text-secondary">{findings.length === 0 ? 'No cases yet. When revenue is written off, the likely cause shows up here.' : 'Nothing needs review.'}</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {shown.map((f) => (
                  <li key={f.id} className="rounded-xl border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-text-primary">{f.revenue_recovery_events?.customer_name ?? 'Unknown customer'}</p>
                        <p className="text-xs text-text-secondary">{f.revenue_recovery_events ? relativeTime(f.revenue_recovery_events.occurred_at) : relativeTime(f.created_at)} · {f.auto_detected ? 'Detected automatically' : 'Added manually'}</p>
                      </div>
                      <p className="font-semibold text-text-primary">{formatCents(f.dollar_amount_cents)}</p>
                    </div>
                    <p className="mt-2 flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ROOT_CAUSE_COLORS[f.root_cause]}`}>{ROOT_CAUSE_LABELS[f.root_cause]}</span>
                      <span className="text-xs text-text-secondary">{PRESENTED(f.confidence)} confidence{f.reviewed ? ' · reviewed' : ''}</span>
                    </p>
                    {f.contributing_factors.length > 0 && <ul className="mt-2 list-disc ps-5 text-xs text-text-secondary">{f.contributing_factors.map((c, i) => <li key={`${c}:${i}`} className="break-words">{c}</li>)}</ul>}
                    {f.prevention_note && <p className="mt-2 break-words text-xs text-text-primary">Prevention: {f.prevention_note}</p>}

                    {editing === f.id ? (
                      <div className="mt-3 space-y-2 rounded-lg border border-border bg-bg-primary p-3">
                        <label htmlFor={`ra-c-${f.id}`} className={lab}>Actual cause</label>
                        <select id={`ra-c-${f.id}`} value={cause} onChange={(e) => setCause(e.target.value as RootCause)} className={field}>
                          {CAUSES.map((c) => <option key={c} value={c}>{ROOT_CAUSE_LABELS[c]}</option>)}
                        </select>
                        <label htmlFor={`ra-n-${f.id}`} className={lab}>What would prevent this? (optional)</label>
                        <textarea id={`ra-n-${f.id}`} value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} className="focus-ring w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary" />
                        <div className="flex justify-end gap-2">
                          <button type="button" className={`${btn} text-text-secondary`} onClick={() => setEditing(null)} disabled={busy !== null}>Cancel</button>
                          <button type="button" className={`${btn} bg-accent text-white`} disabled={busy !== null} onClick={() => void confirm(f, cause !== f.root_cause)}>{busy === `c-${f.id}` ? 'Saving…' : 'Save and confirm'}</button>
                        </div>
                      </div>
                    ) : (
                      !f.reviewed && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button type="button" className={`${btn} bg-accent text-white`} disabled={busy !== null} onClick={() => void confirm(f, false, '')}>{busy === `c-${f.id}` ? 'Saving…' : 'Confirm cause'}</button>
                          <button type="button" className={`${btn} border border-border text-text-primary`} disabled={busy !== null} onClick={() => startEdit(f)}>Correct it</button>
                        </div>
                      )
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </DashboardLayout>
  );
}
