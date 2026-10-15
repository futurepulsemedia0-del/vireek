import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, CheckCircle2, Info } from 'lucide-react';
import { CONTRACT_STATUS_COLORS, CONTRACT_STATUS_LABELS, BILLING_FREQUENCY_LABELS, CONTRACT_TYPE_LABELS, formatMinutes, type ContractType } from '@/lib/contracts';
import { HEALTH_LABELS, HEALTH_STYLES, formatDate, formatMoney, type RecommendedAction } from '@/lib/serviceAgreement';
import { KeyValue, Panel, Pill, ProgressBar, type TabProps } from './AgreementUi';

const SEVERITY_ICON = { critical: AlertTriangle, warning: AlertTriangle, info: Info } as const;
const SEVERITY_TONE: Record<RecommendedAction['severity'], string> = {
  critical: 'text-danger',
  warning: 'text-warning-500',
  info: 'text-accent',
};

function barTone(score: number): string {
  if (score >= 85) return 'bg-success-500';
  if (score >= 65) return 'bg-accent';
  if (score >= 40) return 'bg-warning-500';
  return 'bg-danger';
}

export function OverviewTab({ data, derived, canSeeMoney, goTab }: TabProps) {
  const { contract, customer, terms, termsReview } = data;
  const { health, actions, renewalState } = derived;
  const openClaims = data.claims.filter((c) => c.status === 'open' || c.status === 'under_review').length;

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <Panel title="Agreement health" description="Weighted from SLA, maintenance, usage, claims, margin, renewal and data quality.">
            <div className="flex items-end gap-3">
              <p className="text-5xl font-bold text-text-primary">{health.score}</p>
              <Pill className={`mb-2 ${HEALTH_STYLES[health.grade]}`}>{HEALTH_LABELS[health.grade]}</Pill>
            </div>
            <ul className="mt-5 space-y-3">
              {health.factors.map((f) => (
                <li key={f.key}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-text-primary">{f.label}</span>
                    <span className="text-text-secondary">{Math.round(f.score)}</span>
                  </div>
                  <ProgressBar pct={f.score} tone={barTone(f.score)} label={f.label} />
                  <p className="mt-1 text-xs text-text-secondary">{f.detail}</p>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <div className="lg:col-span-2">
          <Panel title="Recommended actions" description="What to do next, most urgent first.">
            {actions.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-success-500">
                <CheckCircle2 size={16} aria-hidden="true" /> Everything on this agreement is on track.
              </div>
            ) : (
              <ul className="space-y-2">
                {actions.map((a) => {
                  const Icon = SEVERITY_ICON[a.severity];
                  return (
                    <li key={a.text}>
                      <button
                        type="button"
                        onClick={() => goTab(a.tab)}
                        className="focus-ring flex w-full items-start gap-3 rounded-lg border border-border bg-bg-primary p-3 text-left hover:border-accent/40"
                      >
                        <Icon size={16} className={`mt-0.5 shrink-0 ${SEVERITY_TONE[a.severity]}`} aria-hidden="true" />
                        <span className="flex-1 text-sm text-text-primary">{a.text}</span>
                        <ArrowRight size={14} className="mt-1 shrink-0 text-text-secondary" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel title="Agreement at a glance">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <KeyValue
                label="Customer"
                value={
                  customer ? (
                    <Link to={`/dashboard/customers/${customer.id}`} className="text-accent hover:underline">
                      {customer.name}
                    </Link>
                  ) : (
                    'Not linked'
                  )
                }
              />
              <KeyValue label="Type" value={CONTRACT_TYPE_LABELS[contract.contract_type as ContractType] ?? contract.contract_type} />
              <KeyValue label="Status" value={<Pill className={CONTRACT_STATUS_COLORS[contract.status]}>{CONTRACT_STATUS_LABELS[contract.status]}</Pill>} />
              <KeyValue label="Term" value={`${formatDate(contract.start_date)} → ${contract.end_date ? formatDate(contract.end_date) : 'open-ended'}`} />
              <KeyValue label="Renewal" value={renewalState.headline} />
              <KeyValue label="Auto-renew" value={contract.auto_renew ? `Yes (${contract.renewal_notice_days}-day notice)` : 'No'} />
              <KeyValue label="Response (standard / critical)" value={`${formatMinutes(contract.sla_response_minutes_standard)} / ${formatMinutes(contract.sla_response_minutes_critical)}`} />
              <KeyValue label="Resolution target" value={contract.sla_resolution_hours ? `${contract.sla_resolution_hours} hr` : 'Not set'} />
              {canSeeMoney && (
                <KeyValue label="Fee" value={contract.contract_value_cents === null ? 'Not on file' : `${formatMoney(contract.contract_value_cents)} / ${BILLING_FREQUENCY_LABELS[contract.billing_frequency].toLowerCase()}`} />
              )}
            </dl>
          </Panel>
        </div>
      </div>

      <Panel title="Linked records" description="Everything connected to this agreement, reused from the rest of Vireek.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Covered properties & equipment', value: data.assets.length, tab: 'coverage' as const },
            { label: 'Active maintenance plans', value: data.pmPlans.filter((p) => p.active).length, tab: 'maintenance' as const },
            { label: 'SLA breaches logged', value: data.breaches.length, tab: 'sla' as const },
            { label: 'Open claims', value: openClaims, tab: 'claims' as const },
          ].map((l) => (
            <button key={l.label} type="button" onClick={() => goTab(l.tab)} className="focus-ring rounded-lg border border-border bg-bg-primary p-3 text-left hover:border-accent/40">
              <p className="text-xl font-bold text-text-primary">{l.value}</p>
              <p className="text-xs text-text-secondary">{l.label}</p>
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="text-text-secondary">
            Contract terms:{' '}
            <span className="font-medium text-text-primary">
              {termsReview === 'verified' ? 'verified' : termsReview === 'draft' ? 'extracted, awaiting verification' : 'not structured yet'}
            </span>
            {termsReview !== 'none' && terms.coverage.service_types.length > 0 && ` · ${terms.coverage.service_types.length} service types`}
          </span>
          <Link to="/dashboard/contract-intelligence" className="text-accent hover:underline">
            Open Contract Intelligence →
          </Link>
          <Link to="/dashboard/contracts" className="text-accent hover:underline">
            Edit agreement header →
          </Link>
          {contract.document_url && (
            <a href={contract.document_url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
              Signed document ↗
            </a>
          )}
        </div>
      </Panel>
    </>
  );
}
