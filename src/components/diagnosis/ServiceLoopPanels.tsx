// src/components/diagnosis/ServiceLoopPanels.tsx
//
// Two small pieces used by DiagnosisCopilotPage:
//   LoopContextPicker - resolves (trade, job type) from the selected job, or lets
//                       the technician pick one, and reports it to the page.
//   LoopPriorsPanel   - shows HOW history and the network re-ranked the causes.

import { useEffect, useMemo, useState } from 'react';
import { Network, Sparkles } from 'lucide-react';
import {
  EVIDENCE_META,
  evidenceLevel,
  listLoopContexts,
  resolveLoopContext,
  type DiagnosisLoopSummary,
  type LoopContextInput,
} from '@/lib/serviceIntelligenceLoop';

const FIELD = 'w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm';

const ALL_CONTEXTS = listLoopContexts();
const ctxKey = (c: LoopContextInput) => `${c.playbookSlug}|${c.jobTypeKey}`;

interface PickerProps {
  /** service_type of the selected job (null when no job is selected). */
  serviceType: string | null | undefined;
  onChange: (ctx: LoopContextInput | null) => void;
}

export function LoopContextPicker({ serviceType, onChange }: PickerProps) {
  // 'auto' = follow the job, 'off' = do not use the loop, otherwise "slug|jobTypeKey".
  const [choice, setChoice] = useState<string>('auto');

  const ctx = useMemo<LoopContextInput | null>(() => {
    if (choice === 'off') return null;
    if (choice === 'auto') return resolveLoopContext(serviceType);
    return ALL_CONTEXTS.find((c) => ctxKey(c) === choice) ?? null;
  }, [choice, serviceType]);

  useEffect(() => {
    onChange(ctx);
  }, [ctx, onChange]);

  return (
    <div className="mt-3">
      <label htmlFor="loop-context" className="mb-1 flex items-center gap-1 text-xs font-medium text-text-secondary">
        <Network size={12} aria-hidden="true" /> Service Intelligence Loop
      </label>
      <select id="loop-context" value={choice} onChange={(e) => setChoice(e.target.value)} className={FIELD}>
        <option value="auto">Auto-detect from the job</option>
        <option value="off">Off for this diagnosis</option>
        {ALL_CONTEXTS.map((c) => (
          <option key={ctxKey(c)} value={ctxKey(c)}>
            {c.playbookSlug.toUpperCase()} — {c.jobTypeLabel}
          </option>
        ))}
      </select>
      <p className="mt-1 text-xs text-text-secondary">
        {ctx
          ? `Using ${ctx.jobTypeLabel}: causes are re-ranked with your verified history and anonymous network statistics.`
          : 'No matching job type — the diagnosis runs on the AI model alone.'}
      </p>
    </div>
  );
}

const asPct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

export function LoopPriorsPanel({ loop }: { loop: DiagnosisLoopSummary }) {
  const level = evidenceLevel(loop.prior_n);
  const meta = EVIDENCE_META[level];
  const rows = loop.blended.slice(0, 5);

  return (
    <div className="rounded-xl border border-accent/30 bg-accent/5 p-4" data-testid="loop-priors-panel">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles size={14} className="text-accent" aria-hidden="true" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-primary">Adaptive ranking</h3>
        <span className={`text-xs font-medium ${meta.className}`}>{meta.label}</span>
        {loop.priors_used && (
          <span className="text-xs text-text-secondary">
            {Math.round(loop.prior_n)} past case{Math.round(loop.prior_n) === 1 ? '' : 's'}
            {loop.network_contributors > 0 ? ` · ${loop.network_contributors} contributing businesses` : ''}
          </span>
        )}
      </div>

      {!loop.priors_used && (
        <p className="mt-2 text-xs text-text-secondary">
          Not enough verified history for this job type yet, so the ranking is the AI model alone. Every outcome you record
          teaches the next diagnosis.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="mt-3 space-y-2">
          {rows.map((r) => (
            <li key={r.cause_key} className="text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium text-text-primary">{r.cause}</span>
                <span className="tabular-nums text-text-secondary">
                  model {asPct(r.model_likelihood)} · history {asPct(r.prior_share)} → <b className="text-text-primary">{asPct(r.blended)}</b>
                </span>
              </div>
              <div
                className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-primary"
                role="img"
                aria-label={`${r.cause}: blended likelihood ${asPct(r.blended)}`}
              >
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.round(r.blended * 100))}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {loop.notes.length > 0 && (
        <ul className="mt-3 space-y-1">
          {loop.notes.map((n, i) => (
            <li key={i} className="text-xs text-text-secondary">• {n}</li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11px] text-text-secondary">
        Statistics only re-order likely causes. They never change safety warnings or severity.
      </p>
    </div>
  );
}
