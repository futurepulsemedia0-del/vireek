import { AlertTriangle, ArrowRight } from 'lucide-react';
import type { Integration } from '@/lib/supabase';
import { getIntegrationHealth, listUnhealthyIntegrations } from '@/lib/integrationRecovery';

const TYPE_LABELS: Record<string, string> = {
  google_calendar: 'Google Calendar',
  hubspot: 'HubSpot',
  zapier: 'Zapier',
  webhook: 'Webhook',
  jobber: 'Jobber',
  service_titan: 'ServiceTitan',
  quickbooks: 'QuickBooks',
};

interface Props {
  integrations: Integration[];
  /** Scroll/focus target — e.g. #integration-webhook */
  onFixClick?: (integrationType: string) => void;
}

export function IntegrationRecoveryBanner({ integrations, onFixClick }: Props) {
  const broken = listUnhealthyIntegrations(integrations);
  if (broken.length === 0) return null;

  return (
    <div
      role="alert"
      className="mb-6 rounded-2xl border border-warning-500/40 bg-warning-500/5 px-4 py-4 sm:px-5"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-warning-500/15 text-warning-500">
          <AlertTriangle size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary">
            {broken.length === 1
              ? 'One integration needs attention'
              : `${broken.length} integrations need attention`}
          </p>
          <ul className="mt-2 space-y-1.5">
            {broken.map((row) => {
              const health = getIntegrationHealth(row);
              const label = TYPE_LABELS[row.integration_type] ?? row.integration_type;
              return (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-secondary"
                >
                  <span>
                    <span className="font-medium text-text-primary">{label}</span>
                    {' — '}
                    {health.title}
                    {health.detail ? (
                      <span className="text-text-secondary/80"> · {health.detail}</span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => onFixClick?.(row.integration_type)}
                    className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-accent hover:underline"
                  >
                    {health.primaryActionLabel}
                    <ArrowRight size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
