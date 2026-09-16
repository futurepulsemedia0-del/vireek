import { Activity, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useConnectivity } from '@/contexts/ConnectivityContext';

export function DegradedBanner() {
  const { mode } = useConnectivity();
  const [dismissed, setDismissed] = useState(false);

  if (mode !== 'degraded' || dismissed) return null;

  return (
    <div
      role="status"
      className="sticky top-0 z-[99] border-b border-accent/25 bg-accent/5 px-4 py-2.5"
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 text-sm text-text-primary">
          <Activity size={16} className="shrink-0 text-accent" />
          <span>
            <span className="font-semibold">Some systems are slower than usual.</span>{' '}
            <span className="text-text-secondary">
              You can keep working —{' '}
              <Link to="/status" className="font-medium text-accent hover:underline">
                view status
              </Link>
              .
            </span>
          </span>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
          className="rounded-lg p-1.5 text-text-secondary transition hover:bg-bg-tertiary hover:text-text-primary"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
