import { useMemo } from 'react';
import { buildTimeline, formatIsoDate, segmentContains, type RegulationVersion } from '@/lib/temporalRegulation';

const DOT: Record<string, string> = {
  in_force: 'bg-success-500',
  repealed: 'bg-danger',
  gap: 'bg-text-secondary/40',
};

/**
 * Validity timeline of one regulation, as known now: when each version governed, where the gaps and
 * repeals are, and which segment contains the date being inspected.
 */
export function RegulationTimeline({ versions, asOf }: { versions: RegulationVersion[]; asOf: string }) {
  const segments = useMemo(() => buildTimeline(versions), [versions]);

  if (segments.length === 0) {
    return <p className="text-xs text-text-secondary">No known versions yet.</p>;
  }

  return (
    <ol className="space-y-1.5" aria-label="Validity timeline">
      {segments.map((seg, i) => {
        const current = segmentContains(seg, asOf);
        const v = seg.version;
        const label =
          seg.kind === 'gap'
            ? 'Not in force (expired)'
            : seg.status === 'repealed'
              ? 'Repealed'
              : `v${v?.version_no}${v?.label ? ` · ${v.label}` : ''}`;
        return (
          <li
            key={`${seg.from}-${i}`}
            className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
              current ? 'border-accent/50 bg-accent/5' : 'border-border/60 bg-bg-primary'
            }`}
            aria-current={current ? 'date' : undefined}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[seg.status] ?? DOT.gap}`} />
            <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{label}</span>
            <span className="shrink-0 text-text-secondary">
              {formatIsoDate(seg.from)} → {seg.to ? formatIsoDate(seg.to) : 'open'}
            </span>
            {current && <span className="shrink-0 rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">on date</span>}
          </li>
        );
      })}
    </ol>
  );
}
