import { useMemo } from 'react';
import { BookOpen, ExternalLink, Factory, Info, LineChart, Wrench } from 'lucide-react';
import {
  COMPONENT_LABELS,
  SEVERITY_LABELS,
  SIGNAL_LABELS,
  buildChain,
  claimOpportunities,
  dataCoverageItems,
  evaluateWarranty,
  formatLabor,
  formatLift,
  formatMoney,
  formatPct,
  humanizeKey,
  reliabilityHeadline,
  type BenchmarkSignal,
  type OemGraph,
  type Severity,
} from '@/lib/oemGraph';
import { OemGraphChain } from '@/components/oem/OemGraphChain';

const SEVERITY_PILL: Record<Severity, string> = {
  low: 'bg-bg-tertiary text-text-secondary',
  medium: 'bg-warning-500/10 text-warning-500',
  high: 'bg-danger/10 text-danger',
  critical: 'bg-danger/10 text-danger',
};
const SIGNAL_PILL: Record<BenchmarkSignal, string> = {
  above_benchmark: 'bg-danger/10 text-danger',
  in_line: 'bg-bg-tertiary text-text-secondary',
  below_benchmark: 'bg-success-500/10 text-success-500',
};
const BOX = 'rounded-2xl border border-border bg-bg-secondary p-4';
const H = 'mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary';

function SafeLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href || !/^https:\/\//i.test(href)) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="focus-ring inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">
      {children} <ExternalLink size={11} aria-hidden="true" />
    </a>
  );
}

/** Everything the graph knows about one unit. Pure presentation over lib/oemGraph.ts. */
export function OemUnitDetail({ graph, now }: { graph: OemGraph; now: Date }) {
  const steps = useMemo(() => buildChain(graph, now), [graph, now]);
  const warranty = useMemo(() => evaluateWarranty(graph, now), [graph, now]);
  const claims = useMemo(() => claimOpportunities(graph, now), [graph, now]);
  const coverage = useMemo(() => dataCoverageItems(graph), [graph]);
  const eq = graph.equipment;
  const rel = graph.reliability;
  if (!eq) return null;

  return (
    <div className="space-y-4">
      <div className={BOX}>
        <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{eq.equipment_type}</p>
        <h2 className="text-lg font-bold text-text-primary">{[eq.make, eq.model].filter(Boolean).join(' ') || 'Unnamed unit'}</h2>
        <p className="mt-0.5 text-xs text-text-secondary">
          {[eq.customer_name, eq.install_date ? `Installed ${eq.install_date}` : null, eq.serial_number ? `Serial ${eq.serial_number}` : null].filter(Boolean).join(' · ')}
        </p>
      </div>

      {rel && (
        <div className={BOX}>
          <h3 className={H}>
            <LineChart size={15} className="text-accent" aria-hidden="true" /> Network benchmark
            <span className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium ${SIGNAL_PILL[rel.signal]}`}>{SIGNAL_LABELS[rel.signal]}</span>
          </h3>
          <p className="text-sm text-text-primary">{reliabilityHeadline(rel)}</p>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            {rel.scope === 'brand' ? 'Brand-wide figure for this equipment type (this exact model family has too little data to publish). ' : 'Based on this model family. '}
            {rel.contributor_count} contributing businesses · last {rel.window_months} months
            {rel.median_age_months ? ` · first failure typically around month ${rel.median_age_months}` : ''}
            {formatLift(rel.lift) ? ` · ${formatLift(rel.lift)} the benchmark` : ''}. Rounded and aggregated; no business can be identified.
          </p>
          {rel.top_failure_modes.length > 0 && (
            <ul className="mt-2 space-y-1">
              {rel.top_failure_modes.map((m) => (
                <li key={m.failure_mode} className="flex items-center justify-between gap-3 text-xs text-text-secondary">
                  <span>{humanizeKey(m.failure_mode)}</span>
                  <span className="tabular-nums">{formatPct(m.failure_rate_pct)}{m.median_age_months ? ` · ~${m.median_age_months} mo` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className={BOX}>
        <h3 className={H}>
          <Factory size={15} className="text-accent" aria-hidden="true" /> OEM chain
        </h3>
        <OemGraphChain steps={steps} />
      </div>

      {claims.length > 0 && (
        <div className={BOX}>
          <h3 className={H}>
            <Wrench size={15} className="text-accent" aria-hidden="true" /> Potential warranty claims
          </h3>
          <ul className="space-y-2">
            {claims.map((c) => (
              <li key={c.issue_id} className="rounded-xl border border-border bg-bg-primary p-3">
                <p className="text-sm font-semibold text-text-primary">{c.title}</p>
                <p className="mt-0.5 text-xs text-text-secondary">
                  {c.part_names.join(', ')}
                  {formatMoney(c.estimated_part_value) ? ` · ≈ ${formatMoney(c.estimated_part_value)} list` : ''}
                  {formatLabor(c.labor_minutes_min, c.labor_minutes_max) ? ` · labor ${formatLabor(c.labor_minutes_min, c.labor_minutes_max)}` : ''}
                </p>
                <p className="mt-1 text-xs text-text-secondary">
                  {c.needs_registration ? 'Only if the unit was registered with the manufacturer. ' : ''}
                  {c.basis === 'recorded_expiry' ? 'Based on the expiry date recorded on the unit, not OEM terms. ' : ''}
                  Coverage to {c.expires_on ?? 'unknown'}.
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">A lead to review, not a guarantee — the manufacturer decides every claim.</p>
        </div>
      )}

      {graph.issues.length > 0 && (
        <div className={BOX}>
          <h3 className={H}>Known issues</h3>
          <ul className="space-y-3">
            {graph.issues.map((issue) => (
              <li key={issue.id} className="rounded-xl border border-border bg-bg-primary p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-text-primary">{issue.title}</p>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY_PILL[issue.severity]}`}>{SEVERITY_LABELS[issue.severity]}</span>
                  {issue.applicability === 'possible' && <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] font-medium text-warning-500">Depends on build date</span>}
                  {issue.observed && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">Seen in network · {formatPct(issue.observed.failure_rate_pct)}</span>}
                </div>
                {issue.symptom && <p className="mt-1 text-xs text-text-secondary"><span className="font-medium text-text-primary">Symptom:</span> {issue.symptom}</p>}
                {issue.root_cause && <p className="mt-0.5 text-xs text-text-secondary"><span className="font-medium text-text-primary">Cause:</span> {issue.root_cause}</p>}
                {issue.recommended_repair && <p className="mt-0.5 text-xs text-text-secondary"><span className="font-medium text-text-primary">Repair:</span> {issue.recommended_repair}</p>}
                {formatLabor(issue.labor_minutes_min, issue.labor_minutes_max) && <p className="mt-0.5 text-xs text-text-secondary"><span className="font-medium text-text-primary">Labor:</span> {formatLabor(issue.labor_minutes_min, issue.labor_minutes_max)}</p>}
                {issue.parts.length > 0 && (
                  <p className="mt-0.5 text-xs text-text-secondary">
                    <span className="font-medium text-text-primary">Parts:</span>{' '}
                    {issue.parts.map((p) => `${p.quantity > 1 ? `${p.quantity}× ` : ''}${p.part_name}${p.part_number ? ` (${p.part_number})` : ''}`).join(', ')}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap gap-x-3">
                  {issue.bulletin && <span className="text-xs text-text-secondary">TSB {issue.bulletin.bulletin_number}</span>}
                  {issue.recall && <span className="text-xs text-text-secondary">Recall {issue.recall.recall_number}</span>}
                  <SafeLink href={issue.source_url ?? issue.bulletin?.source_url ?? issue.recall?.source_url ?? null}>Source</SafeLink>
                </div>
              </li>
            ))}
          </ul>
          {graph.serial.excluded_issues > 0 && (
            <p className="mt-2 text-[11px] text-text-secondary">{graph.serial.excluded_issues} other issue(s) were excluded because this unit was built outside the affected dates.</p>
          )}
        </div>
      )}

      {(graph.recalls.length > 0 || graph.bulletins.length > 0) && (
        <div className={BOX}>
          <h3 className={H}>Recalls &amp; service bulletins</h3>
          <ul className="space-y-2">
            {graph.recalls.map((r) => (
              <li key={r.id} className="rounded-xl border border-border bg-bg-primary p-3">
                <p className="text-sm font-semibold text-text-primary">Recall {r.recall_number}: {r.title}</p>
                {r.description && <p className="mt-0.5 text-xs text-text-secondary">{r.description}</p>}
                {r.remedy && <p className="mt-0.5 text-xs text-text-secondary"><span className="font-medium text-text-primary">Remedy:</span> {r.remedy}</p>}
                <SafeLink href={r.source_url}>Source</SafeLink>
              </li>
            ))}
            {graph.bulletins.map((b) => (
              <li key={b.id} className="rounded-xl border border-border bg-bg-primary p-3">
                <p className="text-sm font-semibold text-text-primary">TSB {b.bulletin_number}: {b.title}</p>
                {b.description && <p className="mt-0.5 text-xs text-text-secondary">{b.description}</p>}
                <SafeLink href={b.source_url}>Source</SafeLink>
              </li>
            ))}
          </ul>
        </div>
      )}

      {warranty.length > 0 && (
        <div className={BOX}>
          <h3 className={H}>Warranty terms</h3>
          <ul className="space-y-1.5">
            {warranty.map((w) => {
              const term = graph.warranty_terms.find((t) => t.component === w.component);
              return (
                <li key={w.component} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                  <span className="font-medium text-text-primary">{COMPONENT_LABELS[w.component]}</span>
                  <span className="text-text-secondary">
                    {term ? `${term.months} mo${term.registered_months ? ` · ${term.registered_months} mo if registered` : ''}` : ''}
                    {' — '}
                    {w.state === 'active' ? 'active' : w.state === 'active_if_registered' ? 'active only if registered' : w.state === 'expired' ? 'ended' : 'needs install date'}
                    {w.expires_on && w.state !== 'unknown' ? ` (${w.expires_on})` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {graph.claims.length > 0 && (
        <div className={BOX}>
          <h3 className={H}>Claims on this unit</h3>
          <ul className="space-y-1.5">
            {graph.claims.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                <span className="text-text-primary">{c.part_description ?? 'Warranty claim'}{c.claim_number ? ` · #${c.claim_number}` : ''}</span>
                <span className="text-text-secondary">{humanizeKey(c.status)}{c.claim_deadline ? ` · deadline ${c.claim_deadline}` : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {graph.documents.length > 0 && (
        <div className={BOX}>
          <h3 className={H}>
            <BookOpen size={15} className="text-accent" aria-hidden="true" /> OEM documentation
          </h3>
          <ul className="space-y-1.5">
            {graph.documents.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 truncate text-text-primary">{d.title}</span>
                <span className="flex shrink-0 items-center gap-2 text-text-secondary">
                  {humanizeKey(d.doc_type)}
                  <SafeLink href={d.url}>Open</SafeLink>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={BOX}>
        <h3 className={H}>
          <Info size={15} className="text-accent" aria-hidden="true" /> What the graph knows about this unit
        </h3>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {coverage.map((c) => (
            <li key={c.label} className="flex items-center gap-2 text-xs text-text-secondary">
              <span className={`h-2 w-2 shrink-0 rounded-full ${c.present ? 'bg-success-500' : 'bg-border'}`} aria-hidden="true" />
              {c.label}
              <span className="sr-only">{c.present ? ' — available' : ' — missing'}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
