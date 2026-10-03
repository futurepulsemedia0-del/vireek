/**
 * FailureAtlasPanel — network-wide failure intelligence for one equipment
 * make / model. Reusable anywhere a unit is on screen (job, customer, dispatch).
 * Reads only already-aggregated, k-anonymous Atlas cells.
 */

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ChevronDown,
  Clock,
  PackageCheck,
  RotateCcw,
  Stethoscope,
  Users,
  Wrench,
} from 'lucide-react';
import {
  atlasConfidence,
  bestPart,
  bestTest,
  fetchAtlasLookup,
  fetchTechnicianRecords,
  formatAgeMonths,
  formatMake,
  formatModelFamily,
  formatPct,
  humanizeKey,
  optionLabel,
  wilsonInterval,
  ATLAS_DIAGNOSTIC_TESTS,
  ATLAS_SYMPTOMS,
  type AtlasCell,
  type AtlasConfidence,
  type TechnicianRecord,
} from '@/lib/failureAtlas';

const CONFIDENCE_STYLES: Record<AtlasConfidence, string> = {
  high: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/25',
  medium: 'bg-amber-500/10 text-amber-600 border-amber-500/25',
  low: 'bg-bg-tertiary text-text-secondary border-border',
};

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
        <Icon size={12} aria-hidden="true" /> {label}
      </p>
      <p className="mt-1 text-base font-semibold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-text-secondary">{hint}</p>}
    </div>
  );
}

function TechnicianRows({ ownerId, cell }: { ownerId: string; cell: AtlasCell }) {
  const [rows, setRows] = useState<TechnicianRecord[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchTechnicianRecords(ownerId, cell.failure_mode, cell.first_visit_fix_pct)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId, cell.failure_mode, cell.first_visit_fix_pct]);

  if (failed)
    return (
      <p className="text-xs text-text-secondary">Could not load your team's record right now.</p>
    );
  if (rows === null) return <div className="h-10 animate-pulse rounded-xl bg-bg-tertiary" />;
  if (rows.length === 0) {
    return (
      <p className="text-xs text-text-secondary">
        No technician on your team has a recorded outcome for this failure mode yet — the network
        baseline of {formatPct(cell.first_visit_fix_pct, 0)} applies.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li
          key={r.technicianId}
          className="flex items-center justify-between gap-3 rounded-lg bg-bg-primary px-3 py-2 text-xs"
        >
          <span className="font-medium text-text-primary">{r.name}</span>
          <span className="text-text-secondary">
            {r.firstVisitFixes}/{r.jobs} first-visit fixes ·{' '}
            <span className="font-semibold text-text-primary">
              {Math.round(r.successProbability * 100)}%
            </span>{' '}
            success probability
          </span>
        </li>
      ))}
    </ul>
  );
}

function FailureModeCard({ cell, ownerId }: { cell: AtlasCell; ownerId: string | null }) {
  const [open, setOpen] = useState(false);
  const confidence = atlasConfidence(cell);
  const ci = wilsonInterval(cell.failed_units, Math.max(cell.units_observed, 1));
  const part = bestPart(cell);
  const test = bestTest(cell);
  const iqr =
    cell.p25_age_months !== null && cell.p75_age_months !== null
      ? `Typical range ${formatAgeMonths(cell.p25_age_months)} – ${formatAgeMonths(cell.p75_age_months)}`
      : undefined;

  return (
    <motion.article
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-border bg-bg-secondary p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            {humanizeKey(cell.failure_mode)}
          </h3>
          <p className="mt-0.5 text-xs text-text-secondary">
            {formatMake(cell.make_key)} · {formatModelFamily(cell.model_family)} ·{' '}
            {humanizeKey(cell.equipment_type)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {cell.model_family === '*' && (
            <span className="rounded-full border border-border bg-bg-tertiary px-2.5 py-1 text-[11px] font-semibold text-text-secondary">
              Brand-wide
            </span>
          )}
          <span
            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${CONFIDENCE_STYLES[confidence]}`}
          >
            {confidence} confidence
          </span>
        </div>
      </div>

      <div className="mt-3 flex items-end gap-3">
        <p className="text-3xl font-bold text-text-primary">{formatPct(cell.failure_rate_pct)}</p>
        <p className="pb-1 text-xs text-text-secondary">
          of ~{cell.units_observed.toLocaleString()} observed units had this failure
          <span className="block">
            95% interval ≈ {ci.low.toFixed(1)}% – {ci.high.toFixed(1)}%
          </span>
        </p>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <Stat
          icon={Clock}
          label="Median age at failure"
          value={formatAgeMonths(cell.median_age_months)}
          hint={iqr}
        />
        <Stat
          icon={Wrench}
          label="First-visit fix"
          value={formatPct(cell.first_visit_fix_pct, 0)}
        />
        <Stat
          icon={RotateCcw}
          label="Callback rate"
          value={formatPct(cell.callback_pct, 0)}
          hint={`Rework ${formatPct(cell.rework_pct, 0)}`}
        />
      </div>

      {(part || test || cell.top_symptoms.length > 0) && (
        <dl className="mt-3 space-y-1.5 text-xs">
          {part && (
            <div className="flex items-start gap-2">
              <PackageCheck size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
              <div>
                <dt className="inline font-semibold text-text-primary">Best part: </dt>
                <dd className="inline text-text-secondary">
                  <span className="capitalize">{part.part}</span> —{' '}
                  {formatPct(part.first_visit_fix_pct, 0)} first-visit fix (n≈{part.sample})
                </dd>
              </div>
            </div>
          )}
          {test && (
            <div className="flex items-start gap-2">
              <Stethoscope size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
              <div>
                <dt className="inline font-semibold text-text-primary">Best diagnostic test: </dt>
                <dd className="inline text-text-secondary">
                  {optionLabel(ATLAS_DIAGNOSTIC_TESTS, test.test)} —{' '}
                  {formatPct(test.first_visit_fix_pct, 0)} first-visit fix (n≈{test.sample})
                </dd>
              </div>
            </div>
          )}
          {cell.top_symptoms.length > 0 && (
            <p className="pl-6 text-text-secondary">
              <span className="font-semibold text-text-primary">Typical symptoms: </span>
              {cell.top_symptoms
                .map(
                  (s) => `${optionLabel(ATLAS_SYMPTOMS, s.symptom)} (${Math.round(s.share_pct)}%)`,
                )
                .join(' · ')}
            </p>
          )}
        </dl>
      )}

      {ownerId && (
        <div className="mt-3 border-t border-border pt-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="focus-ring flex w-full items-center justify-between rounded-lg text-xs font-semibold text-text-primary"
          >
            <span className="flex items-center gap-1.5">
              <Users size={13} aria-hidden="true" /> Technician success probability
            </span>
            <ChevronDown
              size={14}
              className={`transition-transform ${open ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </button>
          {open && (
            <div className="mt-2">
              <TechnicianRows ownerId={ownerId} cell={cell} />
              <p className="mt-2 text-[11px] text-text-secondary">
                Computed from your own recorded outcomes only, blended with the network baseline so
                small samples don't mislead.
              </p>
            </div>
          )}
        </div>
      )}

      <p className="mt-3 text-[11px] text-text-secondary/80">
        {cell.contributor_count} contributing businesses · last {cell.window_months} months ·
        updated {new Date(cell.computed_at).toLocaleDateString()}
      </p>
    </motion.article>
  );
}

export interface FailureAtlasPanelProps {
  ownerId: string | null;
  equipmentType: string;
  make: string;
  model?: string;
}

export function FailureAtlasPanel({ ownerId, equipmentType, make, model }: FailureAtlasPanelProps) {
  const [cells, setCells] = useState<AtlasCell[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCells(null);
    setError(false);
    fetchAtlasLookup({ equipmentType, make, model })
      .then((c) => {
        if (!cancelled) setCells(c);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [equipmentType, make, model]);

  if (error) {
    return (
      <p className="rounded-2xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary">
        The Atlas could not be loaded. Please try again shortly.
      </p>
    );
  }
  if (cells === null) {
    return (
      <div className="space-y-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-48 animate-pulse rounded-2xl bg-bg-tertiary" />
        ))}
      </div>
    );
  }
  if (cells.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center">
        <p className="mx-auto max-w-md text-sm text-text-secondary">
          The Atlas has no published pattern for this equipment yet. A pattern appears only once
          enough independent businesses have contributed outcomes for it — nothing is shown for thin
          or single-source data.
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {cells.map((c) => (
        <FailureModeCard key={c.id} cell={c} ownerId={ownerId} />
      ))}
    </div>
  );
}
