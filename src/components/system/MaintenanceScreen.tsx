import { Wrench, ExternalLink, RefreshCw, PhoneCall } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useConnectivity } from '@/contexts/ConnectivityContext';

function formatEta(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * Full-viewport maintenance state. Calm, honest, brand-aligned.
 * Voice path messaging is intentional: operators care that phones still answer.
 */
export function MaintenanceScreen() {
  const { maintenance, refresh } = useConnectivity();
  const etaLabel = formatEta(maintenance.eta);
  const statusIsInternal = maintenance.statusUrl.startsWith('/');

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg-primary px-6 py-16">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />

      <div className="w-full max-w-lg text-center">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <Wrench size={28} />
        </span>

        <p className="mt-6 text-xs font-semibold uppercase tracking-wider text-accent">
          Maintenance
        </p>
        <h1 className="mt-3 text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
          {maintenance.title}
        </h1>
        <p className="mx-auto mt-4 max-w-md text-base leading-relaxed text-text-secondary">
          {maintenance.message}
        </p>

        {etaLabel && (
          <p className="mt-4 rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm text-text-primary">
            Expected back around{' '}
            <span className="font-semibold">{etaLabel}</span>
          </p>
        )}

        <div className="mt-6 flex items-start gap-3 rounded-2xl border border-border bg-bg-secondary/80 px-4 py-3.5 text-left">
          <PhoneCall size={18} className="mt-0.5 shrink-0 text-success-500" />
          <p className="text-sm leading-relaxed text-text-secondary">
            <span className="font-medium text-text-primary">Inbound calls:</span>{' '}
            Sarah is built to keep answering during dashboard maintenance whenever
            the voice layer is healthy. Check the status page for live component health.
          </p>
        </div>

        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={() => void refresh()}
            className="focus-ring inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
          >
            <RefreshCw size={16} />
            Check again
          </button>

          {statusIsInternal ? (
            <Link
              to={maintenance.statusUrl}
              className="focus-ring inline-flex items-center justify-center gap-2 rounded-xl border border-border px-5 py-2.5 text-sm font-semibold text-text-primary transition hover:bg-bg-secondary"
            >
              System status
              <ExternalLink size={14} />
            </Link>
          ) : (
            <a
              href={maintenance.statusUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring inline-flex items-center justify-center gap-2 rounded-xl border border-border px-5 py-2.5 text-sm font-semibold text-text-primary transition hover:bg-bg-secondary"
            >
              System status
              <ExternalLink size={14} />
            </a>
          )}
        </div>

        <p className="mt-10 text-xs text-text-secondary">
          Need help?{' '}
          <a href="mailto:ali@vireek.com" className="font-medium text-accent hover:underline">
            ali@vireek.com
          </a>
        </p>
      </div>
    </div>
  );
}
