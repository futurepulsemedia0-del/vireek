import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, ClipboardCheck } from 'lucide-react';
import { fetchPortalSummaries, type PortalSummaryItem } from '@/lib/jobSummariesApi';
import { formatDateLong } from '@/lib/jobSummaries';

/** "Service summaries" card for the customer portal. Renders nothing when there are none. */
export function PortalJobSummaries({ portalToken }: { portalToken: string }) {
  const [items, setItems] = useState<PortalSummaryItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetchPortalSummaries(portalToken).then((r) => {
      if (!cancelled) setItems(r);
    });
    return () => {
      cancelled = true;
    };
  }, [portalToken]);

  if (items.length === 0) return null;
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <ClipboardCheck size={16} className="text-accent" aria-hidden="true" /> Service summaries
      </h2>
      <ul className="mt-4 space-y-2">
        {items.map((s) => (
          <li key={s.token}>
            <Link to={`/summary/${s.token}`} className="focus-ring flex items-center justify-between gap-3 rounded-xl border border-border/60 p-3.5 hover:bg-bg-tertiary">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-text-primary">{s.headline}</span>
                <span className="block truncate text-xs text-text-secondary">
                  {formatDateLong(s.service_date) || new Date(s.sent_at).toLocaleDateString()}
                  {s.first_item ? ` · ${s.first_item}` : ''}
                </span>
              </span>
              <ChevronRight size={16} className="shrink-0 text-text-secondary" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
