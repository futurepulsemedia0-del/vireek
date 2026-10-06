import { useState } from 'react';
import { Brain, CheckCircle2, ChevronDown, Loader2, RefreshCw, RotateCcw, ShieldAlert } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import type { Job } from '@/lib/supabase';
import {
  STATUS_META,
  UNKNOWNS_ELIGIBLE_STATUSES,
  VERDICT_META,
  resolutionInputError,
  type DimensionAssessment,
  type ResolutionKind,
  type UnknownDimensionKey,
} from '@/lib/unknownsEngine';
import { useJobUnknowns } from '@/lib/unknownsEngineApi';

function ConfidenceBar({ pct, label }: { pct: number; label: string }) {
  const tone = pct >= 90 ? 'bg-success-500' : pct >= 70 ? 'bg-accent' : pct >= 40 ? 'bg-warning-500' : 'bg-danger';
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary"
    >
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function ResolveForm({
  dimension,
  busy,
  onSubmit,
}: {
  dimension: DimensionAssessment;
  busy: boolean;
  onSubmit: (kind: ResolutionKind, text: string) => void;
}) {
  const [kind, setKind] = useState<ResolutionKind>('verified');
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const error = resolutionInputError(kind, text);
  const fieldId = `unknown-resolve-${dimension.key}`;

  return (
    <form
      className="mt-2 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!error) onSubmit(kind, text);
      }}
    >
      <div className="flex gap-1.5" role="radiogroup" aria-label="Resolution type">
        {(['verified', 'waived'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => setKind(k)}
            className={`focus-ring rounded-full border px-2.5 py-1 text-[11px] font-medium ${
              kind === k ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
            }`}
          >
            {k === 'verified' ? 'I verified it' : 'Accept the risk'}
          </button>
        ))}
      </div>
      <label htmlFor={fieldId} className="block text-[11px] text-text-secondary">
        {kind === 'verified' ? 'What did you confirm, and how?' : 'Why is it acceptable to proceed without knowing?'}
      </label>
      <textarea
        id={fieldId}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => setTouched(true)}
        maxLength={kind === 'verified' ? 300 : 500}
        rows={2}
        aria-invalid={touched && !!error}
        aria-describedby={touched && error ? `${fieldId}-err` : undefined}
        className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-2.5 py-1.5 text-xs text-text-primary"
      />
      {touched && error && (
        <p id={`${fieldId}-err`} role="alert" className="text-[11px] text-danger">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
        {kind === 'verified' ? 'Save as verified' : 'Record accepted risk'}
      </button>
    </form>
  );
}

function DimensionRow({
  dimension: d,
  busy,
  onResolve,
  onReopen,
}: {
  dimension: DimensionAssessment;
  busy: boolean;
  onResolve: (key: UnknownDimensionKey, kind: ResolutionKind, text: string) => void;
  onReopen: (key: UnknownDimensionKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = STATUS_META[d.status];
  const panelId = `unknown-detail-${d.key}`;

  return (
    <li className="rounded-lg border border-border/70 bg-bg-primary p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="focus-ring flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-text-primary">{d.label}</span>
          <span className="mt-0.5 block text-xs text-text-secondary">{d.summary}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.className}`} title={meta.hint}>
            {d.state === 'waived' ? 'Risk accepted' : meta.label}
          </span>
          <span className="w-9 text-right text-xs font-semibold tabular-nums text-text-primary">{d.confidencePct}%</span>
          <ChevronDown size={14} className={`text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      <div className="mt-2">
        <ConfidenceBar pct={d.confidencePct} label={`${d.label} confidence`} />
      </div>

      {open && (
        <div id={panelId} className="mt-3 space-y-2 text-xs">
          {d.evidence.length > 0 && (
            <div>
              <p className="font-medium text-text-primary">What we found</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-text-secondary">
                {d.evidence.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {d.gaps.length > 0 && (
            <div>
              <p className="font-medium text-text-primary">What is missing or conflicting</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-text-secondary">
                {d.gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
          )}
          {d.resolveWith && d.state === 'open' && (
            <p className="rounded-md bg-accent/5 px-2.5 py-1.5 text-text-primary">
              <span className="font-medium">To resolve: </span>
              {d.resolveWith}
            </p>
          )}

          {d.resolution ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-bg-tertiary px-2.5 py-1.5 text-text-secondary">
              <span>
                {d.resolution.resolution === 'verified' ? 'Verified' : 'Risk accepted'}
                {d.resolution.resolved_at ? ` on ${new Date(d.resolution.resolved_at).toLocaleDateString()}` : ''}
                {d.resolution.resolution === 'waived' && d.resolution.note ? ` — ${d.resolution.note}` : ''}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onReopen(d.key)}
                className="focus-ring flex items-center gap-1 rounded-md px-2 py-1 font-medium text-accent hover:bg-accent/10 disabled:opacity-60"
              >
                <RotateCcw size={11} /> Reopen
              </button>
            </div>
          ) : (
            <ResolveForm dimension={d} busy={busy} onSubmit={(kind, text) => onResolve(d.key, kind, text)} />
          )}
        </div>
      )}
    </li>
  );
}

export function JobUnknownsPanel({ job }: { job: Job }) {
  const { toast } = useToast();
  const eligible = UNKNOWNS_ELIGIBLE_STATUSES.has(job.job_status);
  const { report, loading, error, refresh, resolve, reopen } = useJobUnknowns(job, eligible);
  const [expanded, setExpanded] = useState(true);
  const [busy, setBusy] = useState(false);

  if (!eligible) return null;

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save this update.', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!report) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-bg-primary p-4 text-xs text-text-secondary" aria-live="polite">
        {loading ? <Loader2 size={14} className="animate-spin" /> : <Brain size={14} />}
        {error ?? 'Mapping what is known and unknown for this job…'}
        {!loading && error && (
          <button type="button" onClick={refresh} className="focus-ring ml-auto rounded-md px-2 py-1 font-medium text-accent hover:bg-accent/10">
            Retry
          </button>
        )}
      </div>
    );
  }

  const verdict = VERDICT_META[report.verdict];
  const applicable = report.dimensions.filter((d) => d.applicable);

  return (
    <section className={`rounded-xl border p-4 ${verdict.className}`} aria-label="Unknowns Engine">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="focus-ring flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-text-primary">
          {report.verdict === 'resolve_first' ? (
            <ShieldAlert size={16} className="shrink-0 text-danger" />
          ) : (
            <Brain size={16} className="shrink-0 text-accent" />
          )}
          <span className="truncate">Unknowns Engine</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-text-secondary">
          {report.readinessPct !== null && (
            <span className="font-semibold tabular-nums text-text-primary">{report.readinessPct}% ready</span>
          )}
          {expanded ? 'Hide' : 'Details'}
        </span>
      </button>

      <p className="mt-1 text-xs font-medium text-text-primary" aria-live="polite">
        {verdict.label} — <span className="font-normal text-text-secondary">{report.headline}</span>
      </p>

      {expanded && (
        <div className="mt-3 space-y-3">
          {report.resolveFirst.length > 0 && (
            <ol className="space-y-1.5 rounded-lg border border-border/70 bg-bg-primary p-3 text-xs">
              {report.resolveFirst.map((d, i) => (
                <li key={d.key} className="flex gap-2">
                  <span className="font-semibold text-text-primary">{i + 1}.</span>
                  <span className="text-text-secondary">
                    <span className="font-medium text-text-primary">{d.label}</span>
                    {` (${STATUS_META[d.status].label}, ${d.confidencePct}%) — ${d.resolveWith}`}
                  </span>
                </li>
              ))}
            </ol>
          )}

          <ul className="space-y-2">
            {applicable.map((d) => (
              <DimensionRow
                key={d.key}
                dimension={d}
                busy={busy}
                onResolve={(key, kind, text) =>
                  run(() => resolve(key, kind, text), kind === 'verified' ? 'Marked as verified.' : 'Accepted risk recorded.')
                }
                onReopen={(key) => run(() => reopen(key), 'Reopened.')}
              />
            ))}
          </ul>

          <div className="flex items-center justify-between text-[11px] text-text-secondary">
            <span>Scores come from your job data only; AI evidence stays “Unverified” until a person confirms it.</span>
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              className="focus-ring flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-medium text-accent hover:bg-accent/10 disabled:opacity-60"
            >
              <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
