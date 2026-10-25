import { useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, Loader2, RefreshCw, Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import { DIMENSIONS, DIMENSION_LABELS, scenarioLabel, type QualityFinding, type QualityReviewRow } from '@/lib/callQuality';
import { DimensionBar, KindBadge, ScoreBadge, SeverityBadge, btnGhost, fmtDate, inputCls } from './qualityUi';

type Filter = 'all' | 'attention' | 'emergency' | 'rated_low';

const DIM_FIELD = {
  accuracy: 'accuracy_score', compliance: 'compliance_score', booking: 'booking_score', experience: 'experience_score', upsell: 'upsell_score',
} as const;

interface Props {
  reviews: QualityReviewRow[];
  findings: QualityFinding[];
  rereviewing: string | null;
  onRereview: (callId: string) => void;
  onDismiss: (findingId: string) => void;
}

export function QualityCallsTab({ reviews, findings, rereviewing, onRereview, onDismiss }: Props) {
  const [filter, setFilter] = useState<Filter>('attention');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const byCall = useMemo(() => {
    const m = new Map<string, QualityFinding[]>();
    for (const f of findings) m.set(f.call_id, [...(m.get(f.call_id) ?? []), f]);
    return m;
  }, [findings]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return reviews.filter((r) => {
      if (q && !`${r.caller_name ?? ''} ${r.caller_phone ?? ''}`.toLowerCase().includes(q)) return false;
      if (filter === 'attention') return r.open_findings > 0 || (r.overall_score !== null && r.overall_score < 70);
      if (filter === 'emergency') return r.is_emergency;
      if (filter === 'rated_low') return r.feedback_rating !== null && r.feedback_rating <= 3;
      return true;
    });
  }, [reviews, filter, query]);

  const FILTERS: { id: Filter; label: string }[] = [
    { id: 'attention', label: 'Needs attention' }, { id: 'all', label: 'All reviewed' }, { id: 'emergency', label: 'Emergencies' }, { id: 'rated_low', label: 'Rated 1–3 ★' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Call filter" className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)} className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${filter === f.id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>{f.label}</button>
          ))}
        </div>
        <input aria-label="Search by caller" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search caller or phone" className={`${inputCls} max-w-[240px]`} />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-14 text-center text-sm text-text-secondary">
          {reviews.length === 0 ? 'No calls have been reviewed yet. Use “Review calls” on the Overview tab.' : 'No calls match this filter.'}
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const open = openId === r.review_id;
            const list = byCall.get(r.call_id) ?? [];
            return (
              <li key={r.review_id} className="rounded-xl border border-border bg-bg-secondary">
                <button onClick={() => setOpenId(open ? null : r.review_id)} aria-expanded={open} className="focus-ring flex w-full items-center gap-3 rounded-xl p-3 text-left sm:p-4">
                  <ScoreBadge score={r.overall_score} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-text-primary">{r.caller_name || r.caller_phone || 'Unknown caller'}</span>
                    <span className="block truncate text-xs text-text-secondary">{fmtDate(r.call_at)} · {r.scenario ? scenarioLabel(r.scenario) : 'Call'}{r.is_emergency ? ' · Emergency' : ''}</span>
                  </span>
                  {r.feedback_rating !== null && <span className="hidden items-center gap-1 text-xs text-text-secondary sm:flex"><Star size={14} className="fill-warning-500 text-warning-500" />{r.feedback_rating}</span>}
                  {r.open_findings > 0 && <span className="rounded-full bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">{r.open_findings} issue{r.open_findings === 1 ? '' : 's'}</span>}
                  <ChevronDown size={18} className={`shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
                </button>

                {open && (
                  <div className="space-y-4 border-t border-border p-4">
                    {r.summary && <p className="text-sm text-text-primary">{r.summary}</p>}
                    {r.ai_status !== 'ok' && (
                      <p className="rounded-lg bg-warning-500/10 px-3 py-2 text-xs text-warning-500">
                        {r.ai_status === 'failed' ? 'The AI accuracy check failed for this call, so accuracy is not scored. Re-review to retry.' : 'Accuracy was not checked (the transcript has no clear speaker labels).'}
                      </p>
                    )}
                    <div className="grid gap-3 sm:grid-cols-5">
                      {DIMENSIONS.map((d) => <DimensionBar key={d} label={DIMENSION_LABELS[d]} score={r[DIM_FIELD[d]]} />)}
                    </div>

                    {r.compliance.some((c) => c.status === 'pass' || c.status === 'fail') && (
                      <div>
                        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">Compliance checks</h3>
                        <ul className="flex flex-wrap gap-2">
                          {r.compliance.filter((c) => c.status === 'pass' || c.status === 'fail').map((c) => (
                            <li key={c.rule_id} className={`rounded-full border px-2.5 py-1 text-xs ${c.status === 'pass' ? 'border-success/30 text-success' : 'border-danger/40 text-danger'}`}>{c.status === 'pass' ? '✓' : '✗'} {c.label}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {list.length > 0 && (
                      <div className="space-y-2">
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Flagged on this call</h3>
                        {list.map((f) => (
                          <div key={f.id} className="rounded-lg border border-border bg-bg-primary p-3">
                            <div className="flex flex-wrap items-center gap-2"><KindBadge kind={f.kind} /><SeverityBadge severity={f.severity} /><span className="text-sm font-medium text-text-primary">{f.title}</span></div>
                            {f.detail && <p className="mt-1 text-sm text-text-secondary">{f.detail}</p>}
                            {f.evidence_quote && <blockquote className="mt-2 border-l-2 border-accent/50 pl-3 text-sm italic text-text-secondary">“{f.evidence_quote}”</blockquote>}
                            <button onClick={() => onDismiss(f.id)} className="focus-ring mt-2 text-xs font-medium text-text-secondary underline-offset-2 hover:underline">Not an issue — dismiss</button>
                          </div>
                        ))}
                      </div>
                    )}

                    {r.feedback_comment && <p className="rounded-lg bg-bg-primary p-3 text-sm text-text-secondary">Customer comment: “{r.feedback_comment}”</p>}

                    <div className="flex flex-wrap gap-2">
                      <Link to={`/dashboard/calls/${r.call_id}`} className={btnGhost}><ExternalLink size={14} />Open call</Link>
                      <button onClick={() => onRereview(r.call_id)} disabled={rereviewing === r.call_id} className={btnGhost}>
                        {rereviewing === r.call_id ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}Re-review
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
