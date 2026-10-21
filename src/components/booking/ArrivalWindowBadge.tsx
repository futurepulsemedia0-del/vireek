import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { fetchJobArrivalWindow, type CustomerArrivalWindow } from '@/lib/arrivalWindowsApi';
import { formatWindowDay, formatWindowRange } from '@/lib/arrivalWindows';

/** Customer-facing: shows the current arrival window for a job (by its reschedule/tracking token). Renders nothing if the job has none. */
export function ArrivalWindowBadge({ token, className = '' }: { token: string | undefined; className?: string }) {
  const [info, setInfo] = useState<CustomerArrivalWindow | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetchJobArrivalWindow(token).then((r) => { if (!cancelled) setInfo(r); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [token]);

  if (!info) return null;
  const { window: w, original, narrowed } = info;

  return (
    <div className={`rounded-xl border border-border bg-bg-secondary p-4 ${className}`} role="status">
      <p className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
        <Clock size={13} aria-hidden /> Arrival window
      </p>
      <p className="mt-1 text-lg font-semibold text-text-primary">
        {formatWindowDay(w.start)}, {formatWindowRange(w)}
      </p>
      {narrowed && original && (
        <p className="mt-1 text-xs text-text-secondary">
          Narrowed from {formatWindowRange(original)} now that your technician is assigned.
        </p>
      )}
    </div>
  );
}
