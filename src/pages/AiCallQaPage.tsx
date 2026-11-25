/**
 * AI Call QA - /dashboard/ai-call-qa
 * Human review of AI-handled calls: reviewer queue + rubric, prompt/eval feedback, owner-visible monthly report,
 * owner-only sampling settings. Authorization and scoring are enforced in the database (ai_call_qa_* RPCs).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import {
  RISK_LABELS, TARGET_LABELS, claimNext, currentMonth, fetchFeedback, fetchMonthlyReport, fetchSettings, previewScore, releaseItem,
  saveSettings, setFeedbackStatus, skipItem, submitReview, verdictFor,
  type ClaimedItem, type FeedbackDraft, type FeedbackRow, type FeedbackTarget, type MonthlyReport, type QaSettings, type Scores,
} from '@/lib/aiCallQa';

type Tab = 'review' | 'report' | 'feedback' | 'settings';
const fmt = (v: number | null, suffix = '') => (v === null || v === undefined ? 'No data' : `${v}${suffix}`);

function ReviewTab() {
  const { toast } = useToast();
  const [item, setItem] = useState<ClaimedItem | null>(null);
  const [state, setState] = useState<'loading' | 'empty' | 'ready' | 'error'>('loading');
  const [scores, setScores] = useState<Scores>({});
  const [critical, setCritical] = useState(false);
  const [notes, setNotes] = useState('');
  const [fb, setFb] = useState<FeedbackDraft>({ target: 'prompt', category: '', suggestion: '' });
  const [busy, setBusy] = useState(false);

  const next = useCallback(async () => {
    setState('loading'); setScores({}); setCritical(false); setNotes(''); setFb({ target: 'prompt', category: '', suggestion: '' });
    try {
      const it = await claimNext();
      setItem(it); setState(it ? 'ready' : 'empty');
    } catch { setState('error'); }
  }, []);
  useEffect(() => { void next(); }, [next]);

  const preview = useMemo(() => (item ? previewScore(item.rubric.criteria, scores) : { overall: null, scored: 0 }), [item, scores]);
  const hasFb = fb.category.trim() !== '' && fb.suggestion.trim() !== '';

  const submit = async () => {
    if (!item || preview.overall === null) return;
    setBusy(true);
    try {
      const r = await submitReview(item.item_id, scores, critical, notes, hasFb ? [{ ...fb, category: fb.category.trim(), suggestion: fb.suggestion.trim() }] : []);
      toast(`Review saved: ${r.overall}/100 (${r.verdict.replace('_', ' ')})`, 'success');
      await next();
    } catch { toast('Could not save the review. Please try again.', 'error'); } finally { setBusy(false); }
  };
  const act = async (fn: (id: string) => Promise<void>) => {
    if (!item) return;
    setBusy(true);
    try { await fn(item.item_id); await next(); } catch { toast('Action failed. Please try again.', 'error'); } finally { setBusy(false); }
  };

  if (state === 'loading') return <div aria-busy="true" aria-label="Loading next call" className="space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-64 w-full" /></div>;
  if (state === 'error') return <EmptyState variant="load-failed" title="Could not load the review queue" action={{ label: 'Retry', onClick: () => void next() }} />;
  if (state === 'empty' || !item) return <EmptyState icon={ClipboardCheck} title="No calls waiting for review" description="Sampled AI calls will appear here once review is enabled in Settings." />;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card padding="md" interactive={false}>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded bg-surface-secondary px-2 py-1 text-text-secondary">{item.stratum === 'random' ? 'Random sample' : 'Risk sample'}</span>
          {item.risk_flags.map((f) => <span key={f} className="rounded bg-warning-subtle px-2 py-1 text-warning">{RISK_LABELS[f] ?? f}</span>)}
        </div>
        <h2 className="mt-3 text-lg font-semibold text-text-primary">Call on {new Date(item.call_at).toLocaleString()}</h2>
        {item.summary && <p className="mt-2 text-sm text-text-secondary">{item.summary}</p>}
        <h3 className="mt-4 text-sm font-medium text-text-primary">Transcript</h3>
        <pre tabIndex={0} aria-label="Call transcript" className="focus-ring mt-1 max-h-96 overflow-auto whitespace-pre-wrap rounded border border-border p-3 text-sm text-text-primary">{item.transcript || 'No transcript available.'}</pre>
        <p className="mt-2 text-xs text-text-muted">Card numbers and SSNs are masked. Do not copy caller details into notes.</p>
      </Card>

      <Card padding="md" interactive={false}>
        <h2 className="text-lg font-semibold text-text-primary">Score this call (rubric v{item.rubric.version})</h2>
        <div className="mt-3 space-y-4">
          {item.rubric.criteria.map((c) => (
            <fieldset key={c.key}>
              <legend className="text-sm font-medium text-text-primary">{c.label} <span className="text-text-muted">({c.weight}%)</span></legend>
              <p className="text-xs text-text-secondary">{c.description}</p>
              <div className="mt-1 flex flex-wrap gap-3">
                {[1, 2, 3, 4, 5].map((n) => (
                  <label key={n} className="flex items-center gap-1 text-sm text-text-primary">
                    <input type="radio" name={`s-${c.key}`} checked={scores[c.key] === n} onChange={() => setScores((s) => ({ ...s, [c.key]: n }))} className="focus-ring" /> {n}
                  </label>
                ))}
                <label className="flex items-center gap-1 text-sm text-text-primary">
                  <input type="radio" name={`s-${c.key}`} checked={scores[c.key] === null} onChange={() => setScores((s) => ({ ...s, [c.key]: null }))} className="focus-ring" /> N/A
                </label>
              </div>
            </fieldset>
          ))}
        </div>
        <label className="mt-4 flex items-start gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={critical} onChange={(e) => setCritical(e.target.checked)} className="focus-ring mt-0.5" />
          <span>Critical failure (unsafe advice, missed emergency, invented price, or consent violation). Forces a fail.</span>
        </label>
        <label className="mt-4 block text-sm font-medium text-text-primary" htmlFor="qa-notes">Notes</label>
        <textarea id="qa-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={3} className="focus-ring mt-1 w-full rounded border border-border bg-surface p-2 text-sm text-text-primary" />

        <fieldset className="mt-4 rounded border border-border p-3">
          <legend className="px-1 text-sm font-medium text-text-primary">Improvement suggestion (optional)</legend>
          <label htmlFor="fb-target" className="sr-only">Target</label>
          <select id="fb-target" value={fb.target} onChange={(e) => setFb({ ...fb, target: e.target.value as FeedbackTarget })} className="focus-ring w-full rounded border border-border bg-surface p-2 text-sm text-text-primary">
            {Object.entries(TARGET_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <label htmlFor="fb-cat" className="sr-only">Category</label>
          <input id="fb-cat" value={fb.category} maxLength={60} placeholder="Category (e.g. price wording)" onChange={(e) => setFb({ ...fb, category: e.target.value })} className="focus-ring mt-2 w-full rounded border border-border bg-surface p-2 text-sm text-text-primary" />
          <label htmlFor="fb-sug" className="sr-only">Suggestion</label>
          <textarea id="fb-sug" value={fb.suggestion} maxLength={1000} rows={2} placeholder="What should change?" onChange={(e) => setFb({ ...fb, suggestion: e.target.value })} className="focus-ring mt-2 w-full rounded border border-border bg-surface p-2 text-sm text-text-primary" />
        </fieldset>

        <p className="mt-4 text-sm text-text-secondary" role="status">
          {preview.overall === null ? `Score at least 3 criteria (${preview.scored} so far).` : `Preview: ${preview.overall}/100 · ${verdictFor(preview.overall, critical).replace('_', ' ')}`}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button onClick={() => void submit()} disabled={busy || preview.overall === null} loading={busy}>Submit review</Button>
          <Button variant="secondary" onClick={() => void act(skipItem)} disabled={busy}>Skip</Button>
          <Button variant="secondary" onClick={() => void act(releaseItem)} disabled={busy}>Release to queue</Button>
        </div>
      </Card>
    </div>
  );
}

function ReportTab() {
  const [month, setMonth] = useState(currentMonth());
  const [report, setReport] = useState<MonthlyReport | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const load = useCallback(async () => {
    setState('loading');
    try { setReport(await fetchMonthlyReport(month)); setState('ready'); } catch { setState('error'); }
  }, [month]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      <label className="block text-sm font-medium text-text-primary" htmlFor="qa-month">Month</label>
      <input id="qa-month" type="month" max={currentMonth()} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="focus-ring rounded border border-border bg-surface p-2 text-sm text-text-primary" />
      {state === 'loading' && <Skeleton className="h-40 w-full" />}
      {state === 'error' && <EmptyState variant="load-failed" title="Could not load the report" action={{ label: 'Retry', onClick: () => void load() }} />}
      {state === 'ready' && report && (
        <>
          {report.low_sample && <p role="status" className="rounded border border-warning bg-warning-subtle p-3 text-sm text-text-primary">Low sample: fewer than 10 calls were reviewed this month, so averages are not reliable.</p>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[['Sampled', fmt(report.sampled)], ['Reviewed', fmt(report.reviewed)], ['Average score', fmt(report.avg_overall, '/100')], ['Pass rate', fmt(report.pass_rate, '%')], ['Critical failures', fmt(report.critical_failures)], ['Review rate', fmt(report.review_rate, '%')], ['Waiting now', fmt(report.pending_now)], ['Skipped', fmt(report.skipped)]].map(([l, v]) => (
              <Card key={l} padding="sm" interactive={false}><p className="text-xs text-text-secondary">{l}</p><p className="text-xl font-semibold text-text-primary">{v}</p></Card>
            ))}
          </div>
          {[['By sample type', report.by_stratum.map((g) => ({ k: g.stratum === 'random' ? 'Random (unbiased baseline)' : 'Risk-weighted', g }))], ['By risk flag', report.by_risk_flag.map((g) => ({ k: RISK_LABELS[g.flag ?? ''] ?? g.flag ?? '', g }))]].map(([title, rows]) => (
            <section key={title as string}>
              <h3 className="mb-1 text-sm font-medium text-text-primary">{title as string}</h3>
              {(rows as { k: string; g: MonthlyReport['by_stratum'][number] }[]).length === 0 ? <p className="text-sm text-text-secondary">No data</p> : (
                <ul className="divide-y divide-border rounded border border-border text-sm">
                  {(rows as { k: string; g: MonthlyReport['by_stratum'][number] }[]).map(({ k, g }) => (
                    <li key={k} className="flex justify-between gap-2 p-2 text-text-primary"><span>{k}</span><span className="text-text-secondary">{g.reviewed} reviewed · avg {fmt(g.avg_overall)} · fail {fmt(g.fail_rate, '%')}</span></li>
                  ))}
                </ul>
              )}
            </section>
          ))}
          <section>
            <h3 className="mb-1 text-sm font-medium text-text-primary">By criterion (average 1-5)</h3>
            {report.by_criterion.length === 0 ? <p className="text-sm text-text-secondary">No data</p> : (
              <ul className="divide-y divide-border rounded border border-border text-sm">
                {report.by_criterion.map((c) => <li key={c.criterion} className="flex justify-between p-2 text-text-primary"><span className="capitalize">{c.criterion}</span><span className="text-text-secondary">{fmt(c.avg_score)} ({c.scored} scored)</span></li>)}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function FeedbackTab() {
  const { toast } = useToast();
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const load = useCallback(async () => {
    setState('loading');
    try { setRows(await fetchFeedback()); setState('ready'); } catch { setState('error'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const update = async (id: string, status: FeedbackRow['status']) => {
    try { await setFeedbackStatus(id, status); await load(); } catch { toast('Could not update.', 'error'); }
  };
  if (state === 'loading') return <Skeleton className="h-40 w-full" />;
  if (state === 'error') return <EmptyState variant="load-failed" title="Could not load feedback" action={{ label: 'Retry', onClick: () => void load() }} />;
  if (rows.length === 0) return <EmptyState title="No feedback yet" description="Suggestions added during reviews will be listed here." />;
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.id}><Card padding="sm" interactive={false}>
          <p className="text-xs text-text-secondary">{TARGET_LABELS[r.target]} · {r.category}</p>
          <p className="mt-1 text-sm text-text-primary">{r.suggestion}</p>
          <label className="mt-2 block text-xs text-text-secondary" htmlFor={`st-${r.id}`}>Status</label>
          <select id={`st-${r.id}`} value={r.status} onChange={(e) => void update(r.id, e.target.value as FeedbackRow['status'])} className="focus-ring rounded border border-border bg-surface p-1 text-sm text-text-primary">
            <option value="open">Open</option><option value="accepted">Accepted</option><option value="rejected">Rejected</option><option value="done">Done</option>
          </select>
        </Card></li>
      ))}
    </ul>
  );
}

function SettingsTab() {
  const { toast } = useToast();
  const [s, setS] = useState<QaSettings | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        setS((await fetchSettings()) ?? { enabled: false, random_rate: 0.02, daily_cap: 25, retention_days: 180, policy_ack_at: null,
          risk_rates: { emergency: 1, price_mismatch: 1, complaint: 0.5, price_quote: 0.25, human_transfer: 0.25 } });
        setState('ready');
      } catch { setState('error'); }
    })();
  }, []);
  if (state === 'loading') return <Skeleton className="h-40 w-full" />;
  if (state === 'error' || !s) return <EmptyState variant="load-failed" title="Could not load settings" />;
  const needsAck = s.enabled && !s.policy_ack_at;
  const save = async () => {
    setBusy(true);
    try {
      await saveSettings({ enabled: s.enabled, randomRate: s.random_rate, dailyCap: s.daily_cap, riskRates: s.risk_rates, policyAck: ack });
      toast('Settings saved', 'success');
    } catch { toast('Could not save settings.', 'error'); } finally { setBusy(false); }
  };
  return (
    <Card padding="md" interactive={false} className="max-w-xl space-y-4">
      <label className="flex items-center gap-2 text-sm text-text-primary"><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} className="focus-ring" /> Sample AI calls for human review</label>
      {needsAck && (
        <label className="flex items-start gap-2 text-sm text-text-primary"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="focus-ring mt-0.5" />
          <span>I confirm reviewers may listen to or read sampled call transcripts and that our call-recording and privacy notices cover this use. (TODO(counsel): final wording)</span></label>
      )}
      <div>
        <label htmlFor="rr" className="block text-sm font-medium text-text-primary">Random sample rate (%)</label>
        <input id="rr" type="number" min={0} max={50} step={0.5} value={Math.round(s.random_rate * 1000) / 10} onChange={(e) => setS({ ...s, random_rate: Math.min(0.5, Math.max(0, Number(e.target.value) / 100)) })} className="focus-ring mt-1 w-32 rounded border border-border bg-surface p-2 text-sm text-text-primary" />
      </div>
      <div>
        <label htmlFor="dc" className="block text-sm font-medium text-text-primary">Daily review cap</label>
        <input id="dc" type="number" min={1} max={500} value={s.daily_cap} onChange={(e) => setS({ ...s, daily_cap: Math.min(500, Math.max(1, Math.floor(Number(e.target.value) || 1))) })} className="focus-ring mt-1 w-32 rounded border border-border bg-surface p-2 text-sm text-text-primary" />
      </div>
      <fieldset><legend className="text-sm font-medium text-text-primary">Risk sampling rates (%)</legend>
        {Object.keys(RISK_LABELS).map((k) => (
          <div key={k} className="mt-1 flex items-center justify-between gap-2">
            <label htmlFor={`rk-${k}`} className="text-sm text-text-primary">{RISK_LABELS[k]}</label>
            <input id={`rk-${k}`} type="number" min={0} max={100} value={Math.round((s.risk_rates[k] ?? 0) * 100)} onChange={(e) => setS({ ...s, risk_rates: { ...s.risk_rates, [k]: Math.min(1, Math.max(0, Number(e.target.value) / 100)) } })} className="focus-ring w-24 rounded border border-border bg-surface p-1 text-sm text-text-primary" />
          </div>
        ))}
      </fieldset>
      <Button onClick={() => void save()} loading={busy} disabled={busy || (needsAck && !ack)}>Save settings</Button>
    </Card>
  );
}

export function AiCallQaPage() {
  const { isOwner, permissions } = useAuth();
  const canView = isOwner || permissions.can_edit_business_profile;
  const [tab, setTab] = useState<Tab>('review');
  const tabs: [Tab, string][] = [['review', 'Review queue'], ['report', 'Monthly report'], ['feedback', 'Feedback'], ...(isOwner ? [['settings', 'Settings'] as [Tab, string]] : [])];

  return (
    <DashboardLayout activeLabel="AI Call QA">
      <div className="space-y-6 p-4 md:p-8">
        <header>
          <h1 className="text-2xl font-semibold text-text-primary">AI Call QA</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">A person reviews a sample of calls handled by your AI agent, with extra attention on emergencies, price quotes and complaints.</p>
        </header>
        {!canView ? (
          <EmptyState variant="no-permission" title="You do not have access to AI Call QA" />
        ) : (
          <>
            <div role="tablist" aria-label="AI Call QA sections" className="flex flex-wrap gap-2">
              {tabs.map(([id, label]) => (
                <Button key={id} role="tab" aria-selected={tab === id} size="sm" variant={tab === id ? 'primary' : 'secondary'} onClick={() => setTab(id)}>{label}</Button>
              ))}
            </div>
            <div role="tabpanel">
              {tab === 'review' && <ReviewTab />}
              {tab === 'report' && <ReportTab />}
              {tab === 'feedback' && <FeedbackTab />}
              {tab === 'settings' && isOwner && <SettingsTab />}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
