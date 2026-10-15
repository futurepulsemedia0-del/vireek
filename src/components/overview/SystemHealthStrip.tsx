import { Link } from 'react-router-dom';
import {
  Activity,
  Calculator,
  Calendar,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CreditCard,
  Mic,
  MessageSquare,
  Phone,
  RefreshCw,
  TriangleAlert,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { timeAgo, type HealthCheck, type HealthCheckId, type HealthState } from '@/lib/systemHealth';

const ICONS: Record<HealthCheckId, LucideIcon> = {
  voice: Mic,
  phone: Phone,
  sms: MessageSquare,
  stripe: CreditCard,
  calendar: Calendar,
  quickbooks: Calculator,
  webhooks: Webhook,
};

const STATE_UI: Record<HealthState, { word: string; Icon: LucideIcon; chip: string; text: string }> = {
  green: {
    word: 'Healthy',
    Icon: CircleCheck,
    chip: 'border-emerald-500/30 bg-emerald-500/5',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
  amber: {
    word: 'Warning',
    Icon: TriangleAlert,
    chip: 'border-amber-500/40 bg-amber-500/10',
    text: 'text-amber-600 dark:text-amber-400',
  },
  red: {
    word: 'Critical',
    Icon: CircleAlert,
    chip: 'border-red-500/40 bg-red-500/10',
    text: 'text-red-600 dark:text-red-400',
  },
  off: {
    word: 'Not set up',
    Icon: CircleDashed,
    chip: 'border-border bg-bg-secondary',
    text: 'text-text-secondary',
  },
};

function Chip({ check }: { check: HealthCheck }) {
  const ui = STATE_UI[check.state];
  const Icon = ICONS[check.id];
  return (
    <li
      data-testid={`health-${check.id}`}
      data-state={check.state}
      className={`flex min-w-[11rem] flex-1 flex-col gap-1 rounded-xl border px-3 py-2.5 ${ui.chip}`}
    >
      <div className="flex items-center gap-2">
        <Icon size={15} className="shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="truncate text-sm font-semibold text-text-primary">{check.label}</span>
        <span className={`ml-auto flex shrink-0 items-center gap-1 text-xs font-medium ${ui.text}`}>
          <ui.Icon size={13} aria-hidden="true" />
          {ui.word}
        </span>
      </div>
      <p className="line-clamp-2 text-xs text-text-secondary" title={check.summary}>
        {check.summary}
      </p>
      {check.state !== 'green' && check.fix && (
        <Link
          to={check.fix.href}
          className="focus-ring mt-auto w-fit rounded text-xs font-semibold text-accent hover:underline"
        >
          {check.fix.label} →
        </Link>
      )}
    </li>
  );
}

export function SystemHealthStrip() {
  const { status, checks, summary, checkedAt, refreshing, refresh } = useSystemHealth();

  return (
    <section aria-label="System health" aria-busy={status === 'loading'} className="mb-6">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Activity size={16} className="text-text-secondary" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-text-primary">System health</h2>
        <span
          role="status"
          className={`text-sm ${summary ? STATE_UI[summary.overall].text : 'text-text-secondary'}`}
        >
          {status === 'loading' && 'Checking…'}
          {status === 'error' && 'Could not run health checks'}
          {status === 'ready' && summary?.headline}
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs text-text-secondary">
          {checkedAt && <span>Checked {timeAgo(checkedAt.toISOString(), new Date())}</span>}
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh system health"
            className="focus-ring rounded p-1 text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
        </span>
      </div>

      {status === 'loading' && (
        <ul className="flex flex-wrap gap-2" aria-hidden="true">
          {Array.from({ length: 7 }, (_, i) => (
            <li key={i} className="h-[74px] min-w-[11rem] flex-1 animate-pulse rounded-xl border border-border bg-bg-secondary" />
          ))}
        </ul>
      )}

      {status === 'error' && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <p className="text-sm text-text-primary">
            We could not verify your integrations right now. Status is unknown — not healthy.
          </p>
          <button
            type="button"
            onClick={refresh}
            className="focus-ring rounded text-sm font-semibold text-accent hover:underline"
          >
            Retry
          </button>
        </div>
      )}

      {status === 'ready' && (
        <ul className="flex flex-wrap gap-2">
          {checks.map((c) => (
            <Chip key={c.id} check={c} />
          ))}
        </ul>
      )}
    </section>
  );
}
