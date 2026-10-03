/**
 * AI Reliability & Governance — /dashboard/ai-reliability
 *
 * The audit, evaluation and governance surface for every AI decision Vireek makes:
 * why it was made, what data it used, how confident it was, which model decided,
 * which policies applied, whether a human agreed, what really happened, and whether
 * the AI was wrong. See src/lib/aiGovernance.ts.
 */

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ClipboardCheck,
  Fingerprint,
  Gauge,
  Lightbulb,
  ListChecks,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  DECISION_TYPES,
  ERROR_CATEGORIES,
  ERROR_CATEGORY_LABELS,
  EVENT_LABELS,
  GOVERNANCE_COLORS,
  GOVERNANCE_LABELS,
  GRADE_COLORS,
  GRADE_LABELS,
  OUTCOME_COLORS,
  OUTCOME_LABELS,
  POLICY_RESULT_COLORS,
  REVIEW_LABELS,
  SUGGESTION_KIND_LABELS,
  TYPE_LABELS,
  awaitingOutcome,
  calibrationGap,
  computeOverrideRate,
  computeReliabilityScore,
  computeSuccessRate,
  decideSuggestion,
  fetchDecisionEvents,
  fetchDecisions,
  fetchMetrics,
  fetchPendingReviewCount,
  fetchSettings,
  fetchSuggestions,
  formatCents,
  formatPct,
  formatRate,
  needsAttribution,
  policyLabel,
  recordOutcome,
  refreshSuggestions,
  reviewDecision,
  saveSettings,
  shortHash,
  verifyChain,
  type AiDecisionEvent,
  type AiDecisionRecord,
  type AiDecisionType,
  type AiErrorCategory,
  type AiGovernanceSettings,
  type AiGovernanceSuggestion,
  type AiOutcome,
  type AiReliabilityMetrics,
  type CalibrationBin,
  type ChainVerification,
  type DecisionView,
  type ReliabilityScore,
} from '@/lib/aiGovernance';

type Tab = 'overview' | 'decisions' | 'review' | 'policies' | 'learning';

const REFRESH_MS = 90_000;
const PAGE_SIZE = 25;
const WINDOWS = [7, 30, 90] as const;

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary';

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Badge({ className, children }: { className: string; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${className}`}>{children}</span>;
}

function StatCard({ label, value, hint, valueClass = 'text-text-primary' }: { label: string; value: string | number; hint?: string; valueClass?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-3">
      <p className="text-[11px] text-text-secondary">{label}</p>
      <p className={`text-lg font-semibold ${valueClass}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function SelectField({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  const id = useId();
  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
        {children}
      </select>
    </div>
  );
}

function ConfidenceBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-xs text-text-secondary">No confidence score</span>;
  const tone = value >= 85 ? 'bg-success-500' : value >= 65 ? 'bg-warning-500' : 'bg-danger';
  return (
    <div className="flex items-center gap-2" aria-label={`Confidence ${Math.round(value)}%`}>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-bg-tertiary">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="text-xs font-medium text-text-primary">{Math.round(value)}%</span>
    </div>
  );
}

// ============================================================
// RELIABILITY SCORE
// ============================================================

function ScoreGauge({ result }: { result: ReliabilityScore }) {
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const pct = result.score === null ? 0 : result.score / 100;
  const tone = result.grade ? GRADE_COLORS[result.grade] : 'text-text-secondary';

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
      <div className="relative h-32 w-32 shrink-0">
        <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" role="img" aria-label={result.score === null ? 'Reliability score unavailable' : `Reliability score ${result.score} out of 100`}>
          <circle cx="60" cy="60" r={radius} fill="none" strokeWidth="10" className="stroke-bg-tertiary" />
          <circle
            cx="60"
            cy="60"
            r={radius}
            fill="none"
            strokeWidth="10"
            strokeLinecap="round"
            stroke="currentColor"
            className={tone}
            strokeDasharray={`${circumference * pct} ${circumference}`}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-3xl font-semibold ${tone}`}>{result.score ?? '—'}</span>
          <span className="text-[11px] text-text-secondary">{result.grade ? GRADE_LABELS[result.grade] : 'Not enough data'}</span>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {result.reason && <p className="mb-3 text-xs text-text-secondary">{result.reason} Vireek will not guess a score.</p>}
        <ul className="space-y-2">
          {result.components.map((c) => (
            <li key={c.key}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-primary" title={c.hint}>
                  {c.label} <span className="text-text-secondary">({Math.round(c.weight * 100)}%)</span>
                </span>
                <span className="font-medium text-text-primary">{formatRate(c.value)}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round((c.value ?? 0) * 100)}%` }} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ============================================================
// CALIBRATION
// ============================================================

function CalibrationChart({ bins }: { bins: CalibrationBin[] }) {
  if (bins.length === 0) {
    return (
      <p className="text-sm text-text-secondary">
        Calibration appears once decisions that carry a confidence score have a recorded outcome.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {bins.map((b) => {
        const gap = calibrationGap(b);
        const claimed = b.avg_confidence ?? 0;
        const actual = b.success_rate === null ? 0 : b.success_rate * 100;
        return (
          <div key={b.bin_start}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="font-medium text-text-primary">
                {b.bin_start}–{b.bin_start + 10 === 100 ? 100 : b.bin_start + 9}% confidence
                <span className="ml-2 font-normal text-text-secondary">{b.count} decision{b.count === 1 ? '' : 's'}</span>
              </span>
              {gap !== null && Math.abs(gap) >= 5 && (
                <Badge className={gap > 0 ? 'bg-warning-500/10 text-warning-500' : 'bg-bg-tertiary text-text-secondary'}>
                  {gap > 0 ? `Over-confident by ${gap} pts` : `Under-confident by ${Math.abs(gap)} pts`}
                </Badge>
              )}
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="w-14 text-[11px] text-text-secondary">Claimed</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
                  <div className="h-full rounded-full bg-text-secondary/50" style={{ width: `${claimed}%` }} />
                </div>
                <span className="w-10 text-right text-[11px] text-text-primary">{formatPct(b.avg_confidence)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-14 text-[11px] text-text-secondary">Actual</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-bg-tertiary">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${actual}%` }} />
                </div>
                <span className="w-10 text-right text-[11px] text-text-primary">{formatRate(b.success_rate)}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// DECISION CARD
// ============================================================

function eventSummary(e: AiDecisionEvent): string | null {
  const d = e.detail ?? {};
  const pick = (k: string) => (typeof d[k] === 'string' && (d[k] as string).trim() ? (d[k] as string) : null);
  return pick('notes') ?? pick('error') ?? pick('reason') ?? pick('explanation') ?? (typeof d.outcome === 'string' ? `Outcome: ${d.outcome}` : null);
}

function ReviewForm({ record, onDone }: { record: AiDecisionRecord; onDone: () => void }) {
  const { toast } = useToast();
  const [mode, setMode] = useState<'reject' | 'override' | null>(null);
  const [notes, setNotes] = useState('');
  const [alternative, setAlternative] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (verdict: 'approve' | 'reject' | 'override') => {
    if (verdict !== 'approve' && !notes.trim()) {
      toast('Please give a reason so the decision stays accountable.', 'error');
      return;
    }
    setBusy(true);
    try {
      await reviewDecision(record.id, verdict, notes, verdict === 'override' && alternative.trim() ? { decision: alternative.trim() } : undefined);
      toast(verdict === 'approve' ? 'Decision approved' : verdict === 'reject' ? 'Decision rejected' : 'Decision overridden', 'success');
      onDone();
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl bg-bg-primary p-3">
      <p className="mb-2 text-xs font-semibold text-text-primary">Human review required</p>
      {mode === null ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void submit('approve')} disabled={busy}>
            Approve
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setMode('reject')} disabled={busy}>
            Reject
          </Button>
          {record.linked_action_log_id === null && (
            <Button size="sm" variant="secondary" onClick={() => setMode('override')} disabled={busy}>
              Override
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <Textarea
            label={mode === 'reject' ? 'Why are you rejecting this?' : 'Why are you overriding this?'}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            maxLength={1000}
          />
          {mode === 'override' && (
            <Input label="What should have been decided? (optional)" value={alternative} onChange={(e) => setAlternative(e.target.value)} maxLength={300} />
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void submit(mode)} disabled={busy}>
              {mode === 'reject' ? 'Confirm rejection' : 'Confirm override'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function OutcomeForm({ record, onDone }: { record: AiDecisionRecord; onDone: () => void }) {
  const { toast } = useToast();
  const [outcome, setOutcome] = useState<Exclude<AiOutcome, 'pending'>>('successful');
  const [wrong, setWrong] = useState<'unknown' | 'no' | 'yes'>('unknown');
  const [category, setCategory] = useState<AiErrorCategory>('wrong_reasoning');
  const [explanation, setExplanation] = useState('');
  const [impact, setImpact] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    let financialImpactCents: number | null = null;
    if (impact.trim()) {
      const parsed = Number(impact);
      if (!Number.isFinite(parsed)) {
        toast('Financial impact must be a number, for example 250 or -80.', 'error');
        return;
      }
      financialImpactCents = Math.round(parsed * 100);
    }
    setBusy(true);
    try {
      await recordOutcome(record.id, {
        outcome,
        financialImpactCents,
        aiWasWrong: wrong === 'yes' ? true : wrong === 'no' ? false : null,
        errorCategory: wrong === 'yes' ? category : null,
        errorExplanation: explanation,
        notes,
      });
      toast('Outcome recorded', 'success');
      onDone();
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl bg-bg-primary p-3">
      <p className="text-xs font-semibold text-text-primary">{needsAttribution(record) ? 'Attribute this failure' : 'Record the real outcome'}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="What happened?" value={outcome} onChange={(v) => setOutcome(v as Exclude<AiOutcome, 'pending'>)}>
          <option value="successful">Successful</option>
          <option value="partial">Partially successful</option>
          <option value="failed">Failed</option>
          <option value="no_effect">No effect</option>
        </SelectField>
        <SelectField label="Was the AI's decision wrong?" value={wrong} onChange={(v) => setWrong(v as 'unknown' | 'no' | 'yes')}>
          <option value="unknown">Not sure yet</option>
          <option value="no">No — the decision was sound</option>
          <option value="yes">Yes — the AI got it wrong</option>
        </SelectField>
      </div>
      {wrong === 'yes' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Why was it wrong?" value={category} onChange={(v) => setCategory(v as AiErrorCategory)}>
            {ERROR_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {ERROR_CATEGORY_LABELS[c]}
              </option>
            ))}
          </SelectField>
          <Input label="Financial impact ($, optional)" inputMode="decimal" value={impact} onChange={(e) => setImpact(e.target.value)} placeholder="-80" />
          <div className="sm:col-span-2">
            <Textarea label="Explain what went wrong" value={explanation} onChange={(e) => setExplanation(e.target.value)} rows={2} maxLength={1000} />
          </div>
        </div>
      )}
      {wrong !== 'yes' && <Input label="Financial impact ($, optional)" inputMode="decimal" value={impact} onChange={(e) => setImpact(e.target.value)} placeholder="250" />}
      <Textarea label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={1000} />
      <Button size="sm" onClick={() => void submit()} disabled={busy}>
        Save outcome
      </Button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{title}</p>
      {children}
    </div>
  );
}

function DecisionCard({ record, canManage, onChanged, defaultOpen = false }: { record: AiDecisionRecord; canManage: boolean; onChanged: () => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [events, setEvents] = useState<AiDecisionEvent[] | null>(null);
  const [eventsError, setEventsError] = useState(false);

  useEffect(() => {
    if (!open || events !== null) return;
    let cancelled = false;
    fetchDecisionEvents(record.id)
      .then((rows) => {
        if (!cancelled) setEvents(rows);
      })
      .catch(() => {
        if (!cancelled) setEventsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, events, record.id]);

  // A change elsewhere (review / outcome) must refresh the timeline the next time it is shown.
  useEffect(() => {
    setEvents(null);
    setEventsError(false);
  }, [record.updated_at]);

  const showReview = record.review_status === 'pending' && canManage;
  const showOutcome = canManage && (awaitingOutcome(record) || needsAttribution(record));

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="focus-ring flex w-full items-start justify-between gap-3 rounded-2xl p-4 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge className="bg-bg-tertiary text-text-secondary">{TYPE_LABELS[record.decision_type]}</Badge>
            <Badge className={GOVERNANCE_COLORS[record.governance_action]}>{GOVERNANCE_LABELS[record.governance_action]}</Badge>
            {record.review_status !== 'not_required' && <Badge className="bg-bg-tertiary text-text-secondary">{REVIEW_LABELS[record.review_status]}</Badge>}
            <Badge className={OUTCOME_COLORS[record.outcome]}>{OUTCOME_LABELS[record.outcome]}</Badge>
            {record.ai_was_wrong === true && <Badge className="bg-danger/10 text-danger">AI was wrong</Badge>}
            {needsAttribution(record) && <Badge className="bg-warning-500/10 text-warning-500">Needs attribution</Badge>}
          </div>
          <p className="truncate text-sm font-semibold text-text-primary">{record.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
            <ConfidenceBar value={record.confidence} />
            <span className="text-xs text-text-secondary">{formatWhen(record.created_at)}</span>
          </div>
        </div>
        <ChevronDown size={16} className={`mt-1 shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div className="space-y-4 border-t border-border p-4">
          <Section title="Decision">
            <p className="text-sm text-text-primary">{record.decision || record.title}</p>
          </Section>

          <Section title="Why">
            <p className="text-sm text-text-secondary">{record.reasoning || 'No reasoning was supplied.'}</p>
            {record.reason_factors.length > 0 && (
              <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {record.reason_factors.map((f, i) => (
                  <li key={`${f.factor}-${i}`} className="rounded-xl bg-bg-primary px-3 py-2 text-xs">
                    <span className="font-medium text-text-primary">{f.factor.replace(/_/g, ' ')}</span>
                    {typeof f.weight === 'number' && <span className="ml-1 text-text-secondary">· weight {f.weight}</span>}
                    {f.value !== undefined && f.value !== null && <p className="text-text-secondary">{String(f.value)}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {record.data_used.length > 0 && (
            <Section title="Data used">
              <ul className="flex flex-wrap gap-1.5">
                {record.data_used.map((d, i) => (
                  <li key={`${d.source}-${i}`} className="rounded-xl bg-bg-primary px-3 py-1.5 text-xs text-text-secondary">
                    <span className="font-medium text-text-primary">{d.source}</span>
                    {d.ref ? ` · ${d.ref.slice(0, 8)}` : ''}
                    {d.fields && d.fields.length > 0 ? ` · ${d.fields.join(', ')}` : ''}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Model / agent">
            <p className="text-xs text-text-secondary">
              <span className="font-medium text-text-primary">{record.agent_source}</span> · {record.engine_kind}
              {record.model_provider ? ` · ${record.model_provider}` : ''}
              {record.model_name ? ` / ${record.model_name}` : ''}
              {record.model_version ? ` · v${record.model_version}` : ''}
              {record.amount_cents !== null ? ` · ${formatCents(record.amount_cents)}` : ''}
            </p>
          </Section>

          <Section title="Policies applied">
            {record.policies_applied.length === 0 ? (
              <p className="text-xs text-text-secondary">No policy was evaluated for this decision.</p>
            ) : (
              <ul className="space-y-1.5">
                {record.policies_applied.map((p, i) => (
                  <li key={`${p.policy}-${i}`} className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge className={POLICY_RESULT_COLORS[p.result]}>{p.result}</Badge>
                    <span className="font-medium text-text-primary">{policyLabel(p.policy)}</span>
                    {p.detail && <span className="text-text-secondary">{p.detail}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {(record.review_status !== 'not_required' && record.review_status !== 'pending') && (
            <Section title="Human review">
              <p className="text-sm text-text-secondary">
                {REVIEW_LABELS[record.review_status]} · {formatWhen(record.reviewed_at)}
                {record.review_notes ? ` — “${record.review_notes}”` : ''}
              </p>
              {record.override_value !== null && record.override_value !== undefined && (
                <p className="mt-1 text-xs text-text-secondary">Human decision: {JSON.stringify(record.override_value)}</p>
              )}
            </Section>
          )}

          {record.outcome !== 'pending' && (
            <Section title="Outcome">
              <p className="text-sm text-text-secondary">
                {OUTCOME_LABELS[record.outcome]} · {formatWhen(record.outcome_recorded_at)}
                {record.financial_impact_cents !== null ? ` · ${formatCents(record.financial_impact_cents)}` : ''}
                {record.outcome_notes ? ` — ${record.outcome_notes}` : ''}
              </p>
              {record.ai_was_wrong === true && (
                <p className="mt-1 text-sm text-danger">
                  AI was wrong{record.error_category ? ` — ${ERROR_CATEGORY_LABELS[record.error_category]}` : ''}
                  {record.error_explanation ? `: ${record.error_explanation}` : ''}
                </p>
              )}
            </Section>
          )}

          {record.execution_error && <p className="text-xs text-danger">Execution error: {record.execution_error}</p>}

          {showReview && <ReviewForm record={record} onDone={onChanged} />}
          {showOutcome && <OutcomeForm record={record} onDone={onChanged} />}

          <Section title="Timeline">
            {eventsError ? (
              <p className="text-xs text-text-secondary">The timeline could not be loaded.</p>
            ) : events === null ? (
              <p className="text-xs text-text-secondary">Loading timeline…</p>
            ) : (
              <ol className="space-y-1.5 border-l border-border pl-3">
                {events.map((e) => {
                  const summary = eventSummary(e);
                  return (
                    <li key={e.id} className="text-xs">
                      <span className={`font-medium ${e.event_type === 'violation' ? 'text-danger' : 'text-text-primary'}`}>{EVENT_LABELS[e.event_type]}</span>
                      <span className="ml-2 text-text-secondary">{formatWhen(e.created_at)}</span>
                      {summary && <p className="text-text-secondary">{summary}</p>}
                    </li>
                  );
                })}
              </ol>
            )}
          </Section>

          <p className="flex items-center gap-1.5 text-[11px] text-text-secondary" title="This record is sealed in a tamper-evident SHA-256 hash chain.">
            <Fingerprint size={12} aria-hidden="true" />
            Seal #{record.chain_pos} · {shortHash(record.record_hash)}
          </p>
        </div>
      )}
    </div>
  );
}

// ============================================================
// OVERVIEW
// ============================================================

function IntegrityCard() {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ChainVerification | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      setResult(await verifyChain());
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Fingerprint size={15} /> Audit integrity
          </h2>
          <p className="mt-1 text-xs text-text-secondary">
            Every decision is sealed in a per-account SHA-256 hash chain. Editing or deleting any record breaks the chain, and this check proves it.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void run()} disabled={busy}>
          <ShieldCheck size={14} /> Verify
        </Button>
      </div>
      {result && (
        <p className={`mt-3 text-sm font-medium ${result.verified ? 'text-success-500' : 'text-danger'}`} role="status">
          {result.verified
            ? `Verified — ${result.checked} record${result.checked === 1 ? '' : 's'} intact.`
            : `Chain broken at seal #${result.broken_at_position}: ${result.reason}.`}
        </p>
      )}
    </div>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: Array<{ key: string; label: string; total: number; avg_confidence: number | null; success_rate: number | null; wrong: number; extra?: string }> }) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <h2 className="mb-3 text-sm font-semibold text-text-primary">{title}</h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-xs">
          <thead>
            <tr className="text-text-secondary">
              <th className="pb-2 font-medium">Name</th>
              <th className="pb-2 font-medium">Decisions</th>
              <th className="pb-2 font-medium">Avg confidence</th>
              <th className="pb-2 font-medium">Success</th>
              <th className="pb-2 font-medium">AI errors</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-border/60">
                <td className="py-2 font-medium text-text-primary">
                  {r.label}
                  {r.extra && <span className="ml-1 font-normal text-text-secondary">· {r.extra}</span>}
                </td>
                <td className="py-2 text-text-primary">{r.total}</td>
                <td className="py-2 text-text-primary">{formatPct(r.avg_confidence)}</td>
                <td className="py-2 text-text-primary">{formatRate(r.success_rate)}</td>
                <td className={`py-2 ${r.wrong > 0 ? 'text-danger' : 'text-text-primary'}`}>{r.wrong}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Overview({ metrics, onOpenReview }: { metrics: AiReliabilityMetrics; onOpenReview: () => void }) {
  const t = metrics.totals;
  const score = useMemo(() => computeReliabilityScore(metrics), [metrics]);
  const successRate = computeSuccessRate(t);
  const overrideRate = computeOverrideRate(t);
  const autoShare = t.total > 0 ? t.auto_approved / t.total : null;
  const errorTotal = t.wrong + t.unattributed_failures;
  const errorMax = Math.max(1, ...metrics.error_categories.map((c) => c.count));

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Gauge size={15} /> AI reliability score
        </h2>
        <ScoreGauge result={score} />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard label="AI decisions" value={t.total} hint={`Last ${metrics.window_days} days`} />
        <StatCard label="Auto-approved" value={formatRate(autoShare)} hint="Within policy, no human needed" />
        <StatCard label="Success rate" value={formatRate(successRate)} hint={`${t.outcomes_recorded} outcomes recorded`} valueClass={successRate !== null && successRate < 0.75 ? 'text-warning-500' : 'text-text-primary'} />
        <StatCard label="Avg confidence" value={formatPct(t.avg_confidence)} />
        <button type="button" onClick={onOpenReview} className="focus-ring rounded-2xl border border-border bg-bg-secondary p-3 text-left">
          <p className="text-[11px] text-text-secondary">Awaiting review</p>
          <p className={`text-lg font-semibold ${t.pending_reviews > 0 ? 'text-warning-500' : 'text-text-primary'}`}>{t.pending_reviews}</p>
          <p className="mt-0.5 text-[11px] text-text-secondary">Open review queue</p>
        </button>
        <StatCard label="Human disagreement" value={formatRate(overrideRate)} hint="Rejected or overridden" />
        <StatCard label="AI errors" value={errorTotal} valueClass={errorTotal > 0 ? 'text-danger' : 'text-text-primary'} hint={t.unattributed_failures > 0 ? `${t.unattributed_failures} failure${t.unattributed_failures === 1 ? '' : 's'} not attributed` : `${t.wrong} confirmed`} />
        <StatCard label="Net impact" value={formatCents(t.net_impact_cents)} hint="From recorded outcomes" valueClass={t.net_impact_cents < 0 ? 'text-danger' : 'text-text-primary'} />
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <h2 className="mb-1 text-sm font-semibold text-text-primary">Does confidence predict success?</h2>
        <p className="mb-4 text-xs text-text-secondary">Claimed confidence versus what actually happened. Big gaps mean the AI’s confidence should not be trusted in that range.</p>
        <CalibrationChart bins={metrics.calibration} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <BreakdownTable
          title="By decision type"
          rows={metrics.by_type.map((r) => ({ key: r.decision_type, label: TYPE_LABELS[r.decision_type], total: r.total, avg_confidence: r.avg_confidence, success_rate: r.success_rate, wrong: r.wrong }))}
        />
        <BreakdownTable
          title="By model / engine"
          rows={metrics.by_model.map((r) => ({ key: `${r.model}-${r.engine_kind}`, label: r.model, extra: r.engine_kind, total: r.total, avg_confidence: r.avg_confidence, success_rate: r.success_rate, wrong: r.wrong }))}
        />
      </div>

      {metrics.error_categories.length > 0 && (
        <div className="rounded-2xl border border-border bg-bg-secondary p-4">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Why the AI was wrong</h2>
          <ul className="space-y-2">
            {metrics.error_categories.map((c) => (
              <li key={c.category}>
                <div className="flex justify-between text-xs">
                  <span className="text-text-primary">{ERROR_CATEGORY_LABELS[c.category]}</span>
                  <span className="text-text-secondary">{c.count}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
                  <div className="h-full rounded-full bg-danger" style={{ width: `${(c.count / errorMax) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <IntegrityCard />
    </div>
  );
}

// ============================================================
// DECISION LIST (used by the Decisions and Review tabs)
// ============================================================

const VIEW_FILTERS: Array<{ key: DecisionView; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'awaiting_outcome', label: 'Awaiting outcome' },
  { key: 'wrong', label: 'AI wrong / unattributed' },
  { key: 'blocked', label: 'Blocked' },
];

function DecisionList({ forcedView, canManage, onChanged }: { forcedView?: DecisionView; canManage: boolean; onChanged: () => void }) {
  const [view, setView] = useState<DecisionView>(forcedView ?? 'all');
  const [type, setType] = useState<AiDecisionType | 'all'>('all');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [rows, setRows] = useState<AiDecisionRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [view, type, debounced]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchDecisions({ view: forcedView ?? view, type, search: debounced, limit, offset: 0 })
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows);
        setTotal(res.total);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [forcedView, view, type, debounced, limit, tick]);

  const changed = () => {
    setTick((n) => n + 1);
    onChanged();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input icon={Search} placeholder="Search decisions" aria-label="Search decisions" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="sm:w-48">
          <SelectField label="Type" value={type} onChange={(v) => setType(v as AiDecisionType | 'all')}>
            <option value="all">All types</option>
            {DECISION_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </SelectField>
        </div>
      </div>

      {!forcedView && (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter decisions">
          {VIEW_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={view === f.key}
              onClick={() => setView(f.key)}
              className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${view === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <SkeletonCardList count={3} />
      ) : failed ? (
        <EmptyState icon={ShieldAlert} title="Decisions unavailable" description="The AI decision log could not be loaded. Check your connection and try again." action={{ label: 'Retry', onClick: () => setTick((n) => n + 1) }} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={forcedView === 'review' ? ClipboardCheck : ListChecks}
          title={forcedView === 'review' ? 'Review queue is clear' : 'No AI decisions match'}
          description={forcedView === 'review' ? 'Decisions that fall outside your policy will wait here for a human.' : 'AI decisions appear here as soon as Vireek makes them. Try a different filter.'}
        />
      ) : (
        <>
          <div className="space-y-3">
            {rows.map((r, i) => (
              <DecisionCard key={r.id} record={r} canManage={canManage} onChanged={changed} defaultOpen={forcedView === 'review' && i === 0} />
            ))}
          </div>
          {rows.length < total && (
            <div className="text-center">
              <Button variant="secondary" size="sm" onClick={() => setLimit((n) => n + PAGE_SIZE)} disabled={loading}>
                Show more ({total - rows.length} left)
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================
// POLICIES
// ============================================================

function TypeToggle({ label, selected, onToggle, tone }: { label: string; selected: boolean; onToggle: () => void; tone: 'warning' | 'danger' }) {
  const on = tone === 'danger' ? 'bg-danger text-white' : 'bg-warning-500 text-white';
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${selected ? on : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
    >
      {label}
    </button>
  );
}

function PolicyPanel({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const [settings, setSettings] = useState<AiGovernanceSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [minConfidence, setMinConfidence] = useState('75');
  const [requireConfidence, setRequireConfidence] = useState(false);
  const [amount, setAmount] = useState('');
  const [always, setAlways] = useState<AiDecisionType[]>([]);
  const [blocked, setBlocked] = useState<AiDecisionType[]>([]);
  const [overrides, setOverrides] = useState<AiGovernanceSettings['type_overrides']>({});
  const [newType, setNewType] = useState<AiDecisionType>('dispatch');
  const [newValue, setNewValue] = useState('85');
  const [busy, setBusy] = useState(false);

  const hydrate = useCallback((s: AiGovernanceSettings) => {
    setSettings(s);
    setMinConfidence(String(Number(s.min_confidence_auto)));
    setRequireConfidence(s.require_confidence);
    setAmount(s.require_review_amount_cents === null ? '' : String(s.require_review_amount_cents / 100));
    setAlways(s.always_review_types ?? []);
    setBlocked(s.blocked_types ?? []);
    setOverrides(s.type_overrides ?? {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSettings()
      .then((s) => {
        if (!cancelled) hydrate(s);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  const toggle = (list: AiDecisionType[], set: (v: AiDecisionType[]) => void, t: AiDecisionType) =>
    set(list.includes(t) ? list.filter((x) => x !== t) : [...list, t]);

  const addOverride = () => {
    const n = Number(newValue);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      toast('Override confidence must be between 0 and 100.', 'error');
      return;
    }
    setOverrides((o) => ({ ...o, [newType]: { min_confidence_auto: n } }));
  };

  const save = async () => {
    const min = Number(minConfidence);
    if (!Number.isFinite(min) || min < 0 || min > 100) {
      toast('Minimum confidence must be between 0 and 100.', 'error');
      return;
    }
    let cents: number | null = null;
    if (amount.trim()) {
      const dollars = Number(amount);
      if (!Number.isFinite(dollars) || dollars < 0) {
        toast('Review amount must be zero or more.', 'error');
        return;
      }
      cents = Math.round(dollars * 100);
    }
    setBusy(true);
    try {
      hydrate(
        await saveSettings({
          min_confidence_auto: min,
          require_confidence: requireConfidence,
          require_review_amount_cents: cents,
          always_review_types: always,
          blocked_types: blocked,
          type_overrides: overrides,
        }),
      );
      toast('AI governance policy saved', 'success');
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (failed) {
    return <EmptyState icon={SlidersHorizontal} title="Policy unavailable" description="Your AI governance policy could not be loaded. Reload the page to try again." />;
  }
  if (!settings) return <SkeletonCardList count={2} />;

  const overrideEntries = Object.entries(overrides) as Array<[AiDecisionType, { min_confidence_auto: number }]>;

  return (
    <div className="space-y-4">
      {!canManage && <p className="rounded-xl bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">You can view the policy, but only owners, admins and security managers can change it.</p>}

      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <h2 className="mb-1 text-sm font-semibold text-text-primary">Auto-approval rules</h2>
        <p className="mb-4 text-xs text-text-secondary">Anything outside these rules waits for a human before it counts as approved.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Minimum confidence to auto-approve (%)"
            inputMode="decimal"
            value={minConfidence}
            onChange={(e) => setMinConfidence(e.target.value)}
            disabled={!canManage}
            helperText="Decisions below this need review."
          />
          <Input
            label="Always review decisions worth at least ($)"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={!canManage}
            placeholder="Off"
            helperText="Leave empty to turn this rule off."
          />
        </div>
        <label className="mt-4 flex items-start gap-2 text-sm text-text-primary">
          <input type="checkbox" checked={requireConfidence} onChange={(e) => setRequireConfidence(e.target.checked)} disabled={!canManage} className="mt-0.5" />
          <span>
            Require a confidence score
            <span className="block text-xs text-text-secondary">Decisions that come without one always need review.</span>
          </span>
        </label>
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <h2 className="mb-1 text-sm font-semibold text-text-primary">Always require human review</h2>
        <p className="mb-3 text-xs text-text-secondary">Every decision of these types waits for a person, whatever its confidence.</p>
        <div className="flex flex-wrap gap-2">
          {DECISION_TYPES.map((t) => (
            <TypeToggle key={t} label={TYPE_LABELS[t]} tone="warning" selected={always.includes(t)} onToggle={() => canManage && toggle(always, setAlways, t)} />
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <h2 className="mb-1 text-sm font-semibold text-text-primary">Kill switch</h2>
        <p className="mb-3 text-xs text-text-secondary">Blocked types are recorded but never approved. Callers that respect the gate stop immediately.</p>
        <div className="flex flex-wrap gap-2">
          {DECISION_TYPES.map((t) => (
            <TypeToggle key={t} label={TYPE_LABELS[t]} tone="danger" selected={blocked.includes(t)} onToggle={() => canManage && toggle(blocked, setBlocked, t)} />
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-bg-secondary p-4">
        <h2 className="mb-1 text-sm font-semibold text-text-primary">Per-type thresholds</h2>
        <p className="mb-3 text-xs text-text-secondary">Set a stricter (or looser) confidence bar for one decision type.</p>
        {overrideEntries.length > 0 && (
          <ul className="mb-3 space-y-1.5">
            {overrideEntries.map(([t, v]) => (
              <li key={t} className="flex items-center justify-between rounded-xl bg-bg-primary px-3 py-2 text-sm">
                <span className="text-text-primary">
                  {TYPE_LABELS[t]} <span className="text-text-secondary">· {v.min_confidence_auto}%</span>
                </span>
                {canManage && (
                  <button
                    type="button"
                    className="focus-ring rounded-lg px-2 py-1 text-xs text-text-secondary hover:text-danger"
                    onClick={() =>
                      setOverrides((o) => {
                        const next = { ...o };
                        delete next[t];
                        return next;
                      })
                    }
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="sm:w-56">
              <SelectField label="Decision type" value={newType} onChange={(v) => setNewType(v as AiDecisionType)}>
                {DECISION_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </SelectField>
            </div>
            <div className="sm:w-40">
              <Input label="Minimum (%)" inputMode="decimal" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
            </div>
            <Button size="sm" variant="secondary" onClick={addOverride}>
              Add threshold
            </Button>
          </div>
        )}
      </div>

      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={busy}>
            Save policy
          </Button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// LEARNING
// ============================================================

function LearningPanel({ canManage, onPolicyChanged }: { canManage: boolean; onPolicyChanged: () => void }) {
  const { toast } = useToast();
  const [items, setItems] = useState<AiGovernanceSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await fetchSuggestions());
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const analyse = async () => {
    setBusy(true);
    try {
      const added = await refreshSuggestions();
      await load();
      toast(added > 0 ? `${added} new suggestion${added === 1 ? '' : 's'} found` : 'No new patterns yet — more recorded outcomes are needed.', added > 0 ? 'success' : 'info');
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const decide = async (s: AiGovernanceSuggestion, accept: boolean) => {
    setBusy(true);
    try {
      await decideSuggestion(s.id, accept);
      toast(accept ? 'Policy updated' : 'Suggestion dismissed', 'success');
      await load();
      if (accept) onPolicyChanged();
    } catch (e) {
      toast(errMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-text-secondary">
          Vireek studies real outcomes and proposes tighter or looser rules. Nothing changes until a person accepts it.
        </p>
        {canManage && (
          <Button size="sm" variant="secondary" onClick={() => void analyse()} disabled={busy} className="shrink-0">
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Analyse
          </Button>
        )}
      </div>

      {loading ? (
        <SkeletonCardList count={2} />
      ) : failed ? (
        <EmptyState icon={Lightbulb} title="Suggestions unavailable" description="Learning suggestions could not be loaded." action={{ label: 'Retry', onClick: () => void load() }} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title="No suggestions right now"
          description="Suggestions appear once a decision type has at least 15 recorded outcomes with confidence scores."
        />
      ) : (
        <ul className="space-y-3">
          {items.map((s) => (
            <li key={s.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                <Badge className="bg-bg-tertiary text-text-secondary">{TYPE_LABELS[s.decision_type]}</Badge>
                <Badge className="bg-accent/10 text-accent">{SUGGESTION_KIND_LABELS[s.kind]}</Badge>
              </div>
              <p className="text-sm font-semibold text-text-primary">{s.title}</p>
              <p className="mt-1 text-sm text-text-secondary">{s.rationale}</p>
              {canManage && (
                <div className="mt-3 flex gap-2">
                  <Button size="sm" onClick={() => void decide(s, true)} disabled={busy}>
                    Accept
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void decide(s, false)} disabled={busy}>
                    Dismiss
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function AiReliabilityPage() {
  const { isOwner, permissions } = useAuth();
  const canManage = isOwner || Boolean(permissions?.can_manage_security);

  const [tab, setTab] = useState<Tab>('overview');
  const [days, setDays] = useState<number>(30);
  const [metrics, setMetrics] = useState<AiReliabilityMetrics | null>(null);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [policyKey, setPolicyKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const [m, p] = await Promise.all([fetchMetrics(days), fetchPendingReviewCount()]);
      setMetrics(m);
      setPending(p);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [days]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const refresh = () => {
    setRefreshing(true);
    void load();
  };

  const tabs: Array<{ key: Tab; label: string; badge?: number }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'decisions', label: 'Decision log' },
    { key: 'review', label: 'Review queue', badge: pending },
    { key: 'policies', label: 'Policies' },
    { key: 'learning', label: 'Learning' },
  ];

  return (
    <DashboardLayout activeLabel="AI Reliability">
      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <ShieldCheck size={18} /> AI Reliability &amp; Governance
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Every AI decision, explained, governed and measured against what really happened — audit, evaluation, governance and continuous learning in one place.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={refresh} disabled={refreshing || loading} className="shrink-0">
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>

        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="AI governance sections">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${tab === t.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
              >
                {t.label}
                {t.badge !== undefined && t.badge > 0 && <span className="ml-1.5 rounded-full bg-warning-500 px-1.5 py-0.5 text-[10px] text-white">{t.badge}</span>}
              </button>
            ))}
          </div>
          {tab === 'overview' && (
            <div className="flex gap-1" role="group" aria-label="Time window">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-pressed={days === w}
                  onClick={() => setDays(w)}
                  className={`focus-ring rounded-lg px-2.5 py-1 text-xs font-medium ${days === w ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
                >
                  {w}d
                </button>
              ))}
            </div>
          )}
        </div>

        {tab === 'overview' &&
          (loading ? (
            <div className="space-y-4">
              <SkeletonStatGrid count={4} />
              <SkeletonCardList count={2} />
            </div>
          ) : failed || !metrics ? (
            <EmptyState
              icon={ShieldAlert}
              title="AI reliability data unavailable"
              description="Metrics could not be loaded. Make sure the latest database migration has been applied, then try again."
              action={{ label: 'Reload', onClick: () => { setLoading(true); void load(); } }}
            />
          ) : metrics.totals.total === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="No AI decisions recorded"
              description="Once Vireek's agents and engines start making decisions, each one is recorded here with its reasoning, confidence and outcome."
            />
          ) : (
            <Overview metrics={metrics} onOpenReview={() => setTab('review')} />
          ))}

        {tab === 'decisions' && <DecisionList canManage={canManage} onChanged={refresh} />}
        {tab === 'review' && <DecisionList forcedView="review" canManage={canManage} onChanged={refresh} />}
        {tab === 'policies' && <PolicyPanel key={policyKey} canManage={canManage} />}
        {tab === 'learning' && <LearningPanel canManage={canManage} onPolicyChanged={() => setPolicyKey((k) => k + 1)} />}
      </div>
    </DashboardLayout>
  );
}
