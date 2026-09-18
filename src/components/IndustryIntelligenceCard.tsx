// src/components/IndustryIntelligenceCard.tsx
//
// Self-contained card: fetches and renders the anonymized, cross-tenant
// signals from the Vertical AI Data Pipeline (see
// src/lib/verticalIntelligence.ts). Deliberately independent of whatever
// page embeds it — it takes only a userId and fetches everything else
// itself — so dropping it into a page is a single import + one JSX line.
// Renders nothing (returns null) while loading resolves to "no data",
// so it never leaves an awkward empty state on pages that embed it.

import { useEffect, useState } from 'react';
import { ShieldAlert, TrendingUp, Sparkles, Users } from 'lucide-react';
import {
  fetchVerticalIntelligence,
  capitalizeSignal,
  type VerticalIntelligenceReport,
  type VerticalIntelligenceSignal,
} from '@/lib/verticalIntelligence';
import { getIndustryBySlug } from '@/lib/industries';

function SignalRow({
  signal,
  rate,
  rateLabel,
}: {
  signal: VerticalIntelligenceSignal;
  rate: number | null;
  rateLabel: string;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <span className="min-w-0 truncate text-sm text-text-primary">{capitalizeSignal(signal.signal_key)}</span>
      {rate !== null && (
        <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
          {rate}% {rateLabel}
        </span>
      )}
    </li>
  );
}

export function IndustryIntelligenceCard({ userId }: { userId: string | undefined }) {
  const [report, setReport] = useState<VerticalIntelligenceReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchVerticalIntelligence(userId)
      .then((result) => {
        if (!cancelled) setReport(result);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (loading || !report) return null;

  const industryName = getIndustryBySlug(report.industry)?.name ?? report.industry;
  const hasAnySignal = report.topObjections.length > 0 || report.topIntents.length > 0 || report.topUpsells.length > 0;
  if (!hasAnySignal) return null;

  return (
    <div className="mb-6 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Users size={20} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Industry Intelligence — {industryName}</h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            Anonymized patterns mined from every {industryName} business on Vireek, updated nightly. No individual
            business's calls are ever identifiable in these numbers.
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {report.topObjections.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
              <ShieldAlert size={13} /> Top objections
            </div>
            <ul className="mt-2 divide-y divide-border">
              {report.topObjections.map((s) => (
                <SignalRow key={s.id} signal={s} rate={s.resolution_rate} rateLabel="resolved" />
              ))}
            </ul>
          </div>
        )}

        {report.topIntents.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
              <TrendingUp size={13} /> Top reasons for calling
            </div>
            <ul className="mt-2 divide-y divide-border">
              {report.topIntents.map((s) => (
                <SignalRow key={s.id} signal={s} rate={s.booking_rate} rateLabel="booked" />
              ))}
            </ul>
          </div>
        )}

        {report.topUpsells.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
              <Sparkles size={13} /> Upsells the AI catches
            </div>
            <ul className="mt-2 divide-y divide-border">
              {report.topUpsells.map((s) => (
                <SignalRow key={s.id} signal={s} rate={null} rateLabel="" />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
