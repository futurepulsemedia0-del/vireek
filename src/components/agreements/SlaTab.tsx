import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { BREACH_SEVERITY_COLORS, BREACH_SEVERITY_LABELS, BREACH_TYPE_LABELS, formatMinutes, type BreachSeverity, type BreachType } from '@/lib/contracts';
import { EmptyState } from '@/components/EmptyState';
import { formatDate, formatMoney, formatPct } from '@/lib/serviceAgreement';
import { KeyValue, Panel, Pill, StatTile, type TabProps } from './AgreementUi';
import { Gauge, Timer, Wallet } from 'lucide-react';

const PENALTY_LABELS = {
  none: 'No penalty',
  percent_of_invoice: '% of the job invoice',
  flat_cents: 'Flat amount',
  percent_of_monthly_fee: '% of the monthly fee',
} as const;

export function SlaTab({ data, canSeeMoney }: TabProps) {
  const { contract, terms, breaches } = data;
  const sla = terms.sla;
  const cutoff = Date.now() - 90 * 86_400_000;
  const recent = breaches.filter((b) => new Date(b.created_at).getTime() >= cutoff);
  const unresolved = breaches.filter((b) => !b.resolved);
  const totalPenalty = breaches.reduce((s, b) => s + (b.penalty_amount_cents ?? 0), 0);

  // Response times: structured terms win; fall back to the flat columns on the contract.
  const emergency = sla.response_emergency_minutes ?? contract.sla_response_minutes_critical;
  const urgent = sla.response_urgent_minutes;
  const standard = sla.response_standard_minutes ?? contract.sla_response_minutes_standard;
  const resolution = sla.resolution_hours ?? contract.sla_resolution_hours;

  const penaltyType = sla.penalty_type !== 'none' ? sla.penalty_type : (contract.penalty_percentage ?? 0) > 0 ? 'percent_of_invoice' : 'none';
  const penaltyAmount = sla.penalty_type !== 'none' ? sla.penalty_amount : contract.penalty_percentage;

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Breaches (90 days)" value={recent.length} icon={Gauge} tone={recent.length ? 'text-warning-500' : 'text-success-500'} />
        <StatTile label="Unresolved" value={unresolved.length} icon={Timer} tone={unresolved.length ? 'text-danger' : 'text-success-500'} />
        {canSeeMoney && <StatTile label="Penalties incurred" value={formatMoney(totalPenalty)} icon={Wallet} tone="text-danger" />}
        <StatTile label="Terms" value={data.termsReview === 'verified' ? 'Verified' : data.termsReview === 'draft' ? 'Draft' : 'Basic'} icon={ShieldCheck} tone="text-accent" />
      </div>

      <Panel title="Response & resolution commitments" description="The clock every job on this agreement is held to. Edited in Contract Intelligence (detailed) or the agreement header (basic).">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <KeyValue label="Emergency response" value={formatMinutes(emergency)} />
          <KeyValue label="Urgent response" value={formatMinutes(urgent)} />
          <KeyValue label="Standard response" value={formatMinutes(standard)} />
          <KeyValue label="Resolution target" value={resolution ? `${resolution} hr` : 'Not set'} />
          <KeyValue label="Clock" value={sla.clock === 'business' ? `Business hours (${sla.business_start}–${sla.business_end})` : '24/7 calendar'} />
          <KeyValue label="After-hours" value={terms.coverage.after_hours_covered ? 'Covered' : 'Not covered'} />
          {canSeeMoney && (
            <KeyValue
              label="Penalty"
              value={
                penaltyType === 'none'
                  ? 'No penalty'
                  : `${penaltyType === 'flat_cents' ? formatMoney(penaltyAmount) : formatPct(penaltyAmount, 1)} ${penaltyType === 'flat_cents' ? '' : PENALTY_LABELS[penaltyType]}`.trim()
              }
            />
          )}
          {canSeeMoney && <KeyValue label="Penalty cap" value={contract.penalty_cap_percentage !== null ? `${formatPct(contract.penalty_cap_percentage)} of fee` : 'None'} />}
        </dl>
        <p className="mt-4 text-sm text-text-secondary">
          Live job-by-job SLA clocks, coverage verdicts and one-click breach logging are in{' '}
          <Link to="/dashboard/contract-intelligence" className="text-accent hover:underline">
            Contract Intelligence
          </Link>
          .
        </p>
      </Panel>

      <Panel title="Breach history" description="Every missed commitment on this agreement, newest first.">
        {breaches.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No SLA breaches" description="Breaches logged from Contract Intelligence appear here with how late the response was and any penalty." />
        ) : (
          <ul className="divide-y divide-border">
            {breaches.slice(0, 50).map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">{BREACH_TYPE_LABELS[b.breach_type as BreachType] ?? b.breach_type}</p>
                  <p className="text-xs text-text-secondary">
                    {formatDate(b.created_at)}
                    {b.minutes_over !== null && ` · ${formatMinutes(b.minutes_over)} over target`}
                    {canSeeMoney && b.penalty_amount_cents ? ` · penalty ${formatMoney(b.penalty_amount_cents)}` : ''}
                  </p>
                </div>
                <Pill className={BREACH_SEVERITY_COLORS[b.severity as BreachSeverity]}>{BREACH_SEVERITY_LABELS[b.severity as BreachSeverity]}</Pill>
                <Pill className={b.resolved ? 'bg-success-500/10 text-success-500' : 'bg-warning-500/10 text-warning-500'}>{b.resolved ? 'Resolved' : 'Open'}</Pill>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
