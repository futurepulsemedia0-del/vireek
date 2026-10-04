import { Layers, TriangleAlert as AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import {
  PATTERN_STATUS_META,
  explainPattern,
  humanize,
  modelLabelFromKey,
  type ExposureRow,
  type TagShare,
} from '@/lib/failureGenome';

const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);

function Evidence({ title, items }: { title: string; items: TagShare[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((t) => (
          <span key={t.tag} className="rounded-full bg-bg-tertiary px-2.5 py-0.5 text-xs text-text-secondary">
            {humanize(t.tag)} <span className="text-text-secondary/60">{pct(t.share)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function PatternCard({ row, onViewUnits }: { row: ExposureRow; onViewUnits: (ids: string[]) => void }) {
  const p = row.pattern;
  const meta = PATTERN_STATUS_META[p.status];
  const stats: [string, string][] = [
    ['Recent', `${p.recent_events} (${p.recent_rate}/100 units)`],
    ['Expected', `${p.baseline_rate}/100 units`],
    ['Lift', p.lift == null ? '—' : `${p.lift}×`],
    ['Cohort', `${p.units_exposed} units · ${p.contributor_count} businesses`],
  ];

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.className}`}>
              {p.status === 'emerging' && <AlertTriangle size={11} aria-hidden="true" />}
              {meta.label}
            </span>
            {p.age_band !== 'any' && <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-text-secondary">Age {p.age_band}</span>}
            {p.climate_band !== 'any' && (
              <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-text-secondary">{humanize(p.climate_band)}</span>
            )}
          </div>
          <h3 className="text-base font-semibold text-text-primary">
            {humanize(p.failure_component)} · {modelLabelFromKey(p.model_key)}
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">{explainPattern(p)}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => onViewUnits(row.my_equipment_ids)}>
          <Layers size={14} aria-hidden="true" /> {row.my_units} of your unit{row.my_units === 1 ? '' : 's'}
        </Button>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">{label}</dt>
            <dd className="mt-0.5 text-sm font-medium text-text-primary">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Evidence title="Typical symptoms" items={p.top_symptoms} />
        <Evidence title="Parts involved" items={p.top_parts} />
        <Evidence title="Common repairs" items={p.top_repairs} />
      </div>

      <p className="mt-4 text-xs text-text-secondary">
        Fixed first time {pct(p.fix_rate)} · repeat/callback {pct(p.recurrence_rate)} · unit replaced {pct(p.replacement_rate)}
        {p.avg_repair_cost != null && ` · avg repair ${Math.round(p.avg_repair_cost)}`}
      </p>
    </div>
  );
}
