/**
 * Renders a Home Service Passport. Used by both the dashboard preview and the
 * public verification page, so what a manager previews is exactly what the
 * recipient sees.
 */

import { AlertTriangle, BadgeCheck, CalendarClock, FileText, History, Home, Wallet, Wrench } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import {
  CONDITION_META,
  PERMIT_STATUS_LABELS,
  SEVERITY_META,
  formatAddress,
  formatPassportDate,
  formatUsd,
  formatYears,
  type HomePassportPayload,
} from '@/lib/homeServicePassport';

const SECTION = '!p-6 hover:!translate-y-0';

function SectionTitle({ icon: Icon, children }: { icon: typeof Home; children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
      <Icon size={16} className="text-accent" aria-hidden="true" /> {children}
    </h2>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-xl font-bold ${tone ?? 'text-text-primary'}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

const GRADE_TONE: Record<string, string> = {
  A: 'text-success-500',
  B: 'text-success-500',
  C: 'text-warning-500',
  D: 'text-danger',
  F: 'text-danger',
};

export function HomePassportView({ data }: { data: HomePassportPayload }) {
  const { summary, health, projections } = data;
  const problems = data.known_problems;
  const activeEquipment = data.equipment.filter((e) => e.status === 'active');
  const retiredEquipment = data.equipment.filter((e) => e.status !== 'active');

  return (
    <div className="space-y-4">
      <Card className={SECTION}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-accent">
              <Home size={14} aria-hidden="true" /> Home Service Passport
            </p>
            <h1 className="mt-1 break-words text-2xl font-bold text-text-primary">{formatAddress(data.property)}</h1>
            <p className="mt-1 text-sm text-text-secondary">
              {data.serviced_by ? `Serviced by ${data.serviced_by} · ` : ''}
              {summary.service_visits} recorded service visit{summary.service_visits === 1 ? '' : 's'}
              {summary.first_service_date ? ` since ${formatPassportDate(summary.first_service_date)}` : ''}
            </p>
          </div>
          {health && (
            <div className="shrink-0 rounded-xl border border-border bg-bg-primary px-5 py-3 text-center">
              <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">Home Health</p>
              <p className={`text-3xl font-bold ${GRADE_TONE[health.grade] ?? 'text-text-primary'}`}>{health.grade}</p>
              <p className="text-xs text-text-secondary">{health.score}/100</p>
            </div>
          )}
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Systems on record" value={String(summary.active_equipment)} hint={`${summary.retired_equipment} retired`} />
          <Tile
            label="Need attention"
            value={String(summary.needs_attention)}
            hint={`${summary.on_watch} on watch`}
            tone={summary.needs_attention > 0 ? 'text-danger' : 'text-success-500'}
          />
          <Tile
            label="Active warranties"
            value={String(summary.warranties_active)}
            hint={summary.warranties_expiring_12m > 0 ? `${summary.warranties_expiring_12m} expire within 12 mo` : undefined}
          />
          <Tile label="Avg remaining life" value={formatYears(summary.avg_remaining_years)} hint={`${summary.record_completeness_pct}% record completeness`} />
        </div>
      </Card>

      <section aria-labelledby="hp-problems">
<Card className={SECTION}>
        <SectionTitle icon={AlertTriangle}>
          <span id="hp-problems">Known problems</span>
        </SectionTitle>
        {problems.length === 0 ? (
          <p className="mt-3 text-sm text-text-secondary">No open problems are recorded for this property.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {problems.map((p, i) => (
              <li key={`${p.kind}-${i}`} className="rounded-xl border border-border bg-bg-primary p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${SEVERITY_META[p.severity].className}`}>
                    {SEVERITY_META[p.severity].label}
                  </span>
                  <p className="text-sm font-medium text-text-primary">{p.title}</p>
                </div>
                {p.detail && <p className="mt-1 text-xs text-text-secondary">{p.detail}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>
</section>

      <section aria-labelledby="hp-equipment">
<Card className={SECTION}>
        <SectionTitle icon={Wrench}>
          <span id="hp-equipment">Equipment, age and warranty</span>
        </SectionTitle>
        {activeEquipment.length === 0 ? (
          <p className="mt-3 text-sm text-text-secondary">No equipment is recorded yet.</p>
        ) : (
          <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            {activeEquipment.map((e, i) => (
              <li key={`${e.label}-${e.serial_number ?? i}`} className="rounded-xl border border-border bg-bg-primary p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-primary">{e.label}</p>
                    <p className="text-xs capitalize text-text-secondary">
                      {e.equipment_type}
                      {e.serial_number ? ` · S/N ${e.serial_number}` : ''}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${CONDITION_META[e.condition].className}`}>
                    {CONDITION_META[e.condition].label}
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <dt className="text-text-secondary">Installed</dt>
                  <dd className="text-right text-text-primary">{formatPassportDate(e.install_date)}</dd>
                  <dt className="text-text-secondary">Age / expected life</dt>
                  <dd className="text-right text-text-primary">
                    {e.age_years === null ? '—' : formatYears(e.age_years)} / {formatYears(e.lifespan_years)}
                  </dd>
                  <dt className="text-text-secondary">Remaining life</dt>
                  <dd className="text-right text-text-primary">{formatYears(e.remaining_years)}</dd>
                  <dt className="text-text-secondary">Warranty</dt>
                  <dd className="text-right text-text-primary">
                    {e.warranty_status === 'unknown'
                      ? 'Not recorded'
                      : `${e.warranty_status === 'active' ? 'Until' : 'Expired'} ${formatPassportDate(e.warranty_expires_at)}`}
                  </dd>
                  <dt className="text-text-secondary">Last / next service</dt>
                  <dd className="text-right text-text-primary">
                    {formatPassportDate(e.last_service_date)} / {formatPassportDate(e.next_service_due)}
                  </dd>
                  <dt className="text-text-secondary">Visits (repairs 24 mo)</dt>
                  <dd className="text-right text-text-primary">
                    {e.service_count} ({e.repair_count_24m})
                  </dd>
                </dl>
                {e.warranty_notes && <p className="mt-2 text-xs text-text-secondary">Warranty note: {e.warranty_notes}</p>}
              </li>
            ))}
          </ul>
        )}
        {retiredEquipment.length > 0 && (
          <p className="mt-3 text-xs text-text-secondary">
            Previously installed (replaced or removed): {retiredEquipment.map((e) => e.label).join(', ')}.
          </p>
        )}
      </Card>
</section>

      <section aria-labelledby="hp-predicted">
<Card className={SECTION}>
        <SectionTitle icon={CalendarClock}>
          <span id="hp-predicted">Predicted maintenance</span>
        </SectionTitle>
        {data.predicted_maintenance.length === 0 ? (
          <p className="mt-3 text-sm text-text-secondary">Not enough install or service dates to predict upcoming maintenance.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {data.predicted_maintenance.map((m, i) => (
              <li key={`${m.equipment}-${i}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span className="font-medium text-text-primary">{m.equipment}</span>
                <span className={m.overdue ? 'font-semibold text-danger' : 'text-text-secondary'}>
                  {m.overdue ? 'Overdue since ' : 'Due '}
                  {formatPassportDate(m.next_due ?? m.predicted_issue_due)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
</section>

      {projections && (
        <section aria-labelledby="hp-costs">
<Card className={SECTION}>
          <SectionTitle icon={Wallet}>
            <span id="hp-costs">Expected future costs (estimate)</span>
          </SectionTitle>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Tile label="Next 12 months" value={formatUsd(projections.annual)} hint={`${formatUsd(projections.annualLow)} – ${formatUsd(projections.annualHigh)}`} />
            <Tile label="Next 5 years" value={formatUsd(projections.fiveYear)} hint={`${formatUsd(projections.fiveYearLow)} – ${formatUsd(projections.fiveYearHigh)}`} />
            <Tile label="Suggested reserve" value={`${formatUsd(projections.suggestedMonthlyReserve)}/mo`} hint={`${projections.confidence} confidence`} />
          </div>
          {projections.categories.length > 0 && (
            <ul className="mt-3 divide-y divide-border text-sm">
              {projections.categories.map((c) => (
                <li key={c.key} className="flex items-center justify-between py-2">
                  <span className="text-text-primary">{c.label}</span>
                  <span className="text-text-secondary">
                    {formatUsd(c.annual)}/yr · {formatUsd(c.fiveYear)} over 5 yrs
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-text-secondary">
            Modelled from the records in this passport (age vs. expected life, service history, warranty). These are planning
            estimates, not quotes or guarantees.
          </p>
          {projections.assumptions.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-text-secondary">
              {projections.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}
        </Card>
</section>
      )}

      <section aria-labelledby="hp-permits">
<Card className={SECTION}>
        <SectionTitle icon={FileText}>
          <span id="hp-permits">Permits</span>
        </SectionTitle>
        {data.permits.length === 0 ? (
          <p className="mt-3 text-sm text-text-secondary">No permits are on file for this property.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {data.permits.map((p, i) => (
              <li key={`${p.permit_number ?? p.permit_type}-${i}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-text-primary">{p.permit_type}</p>
                  <p className="text-xs text-text-secondary">
                    {[p.permit_number ? `#${p.permit_number}` : null, p.jurisdiction, p.issued_on ? `issued ${formatPassportDate(p.issued_on)}` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <span className="rounded-full bg-bg-primary px-2.5 py-0.5 text-xs font-medium text-text-secondary">
                  {PERMIT_STATUS_LABELS[p.status]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
</section>

      <section aria-labelledby="hp-history">
<Card className={SECTION}>
        <SectionTitle icon={History}>
          <span id="hp-history">Service history</span>
        </SectionTitle>
        {data.service_history.length === 0 ? (
          <p className="mt-3 text-sm text-text-secondary">No completed service visits are recorded yet.</p>
        ) : (
          <ol className="mt-3 divide-y divide-border">
            {data.service_history.map((v, i) => (
              <li key={`${v.date}-${i}`} className="flex flex-wrap items-start justify-between gap-2 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="font-medium capitalize text-text-primary">{v.service_type ?? 'Service visit'}</p>
                  {v.equipment.length > 0 && <p className="text-xs text-text-secondary">{v.equipment.join(', ')}</p>}
                </div>
                <div className="flex items-center gap-2 text-xs text-text-secondary">
                  {v.evidence_verified && (
                    <span className="inline-flex items-center gap-1 text-success-500">
                      <BadgeCheck size={13} aria-hidden="true" /> Evidence verified
                    </span>
                  )}
                  {v.was_rework && <span className="text-warning-500">Return visit</span>}
                  <span>{formatPassportDate(v.date)}</span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
</section>
    </div>
  );
}
