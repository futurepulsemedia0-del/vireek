/**
 * Owner-visible catalog of the rules in force: plain-language explanation,
 * source references, effective dates and version history.
 */

import { useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, Scale } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import {
  KIND_LABELS, SEVERITY_LABELS, SURFACE_LABELS, formatJurisdiction, groupCatalog, timelineLabel,
  type RuleVersion, type Timeline,
} from '@/lib/complianceRules';

const TIMELINE_STYLE: Record<Timeline, string> = {
  active: 'bg-success-500/10 text-success-500',
  upcoming: 'bg-warning-500/10 text-warning-500',
  expired: 'bg-bg-tertiary text-text-secondary',
  inactive: 'bg-bg-tertiary text-text-secondary',
};

function Sources({ v }: { v: RuleVersion }) {
  return (
    <ul className="mt-2 space-y-1 text-xs text-text-secondary">
      {v.sourceRefs.map((s, i) => (
        <li key={i}>
          {s.url && /^https:\/\//.test(s.url) ? (
            <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              {s.citation} <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          ) : (
            <span>{s.citation}</span>
          )}
          {s.retrievedOn && <span className="ml-1 opacity-70">(checked {s.retrievedOn})</span>}
        </li>
      ))}
    </ul>
  );
}

export function RulesList({ catalog, dateKey }: { catalog: RuleVersion[]; dateKey: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [juris, setJuris] = useState('all');
  const groups = useMemo(() => groupCatalog(catalog, dateKey), [catalog, dateKey]);
  const jurisdictions = useMemo(() => [...new Set(groups.map((g) => g.current.jurisdiction))].sort(), [groups]);
  const shown = juris === 'all' ? groups : groups.filter((g) => g.current.jurisdiction === juris);

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={Scale}
        title="No rules are in force yet"
        description="Rules appear here once Vireek's compliance staff have reviewed them with legal counsel and approved them. Until then nothing is enforced automatically."
      />
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <label htmlFor="rules-juris" className="text-sm text-text-secondary">Jurisdiction</label>
        <select
          id="rules-juris" value={juris} onChange={(e) => setJuris(e.target.value)}
          className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
        >
          <option value="all">All ({groups.length})</option>
          {jurisdictions.map((j) => <option key={j} value={j}>{formatJurisdiction(j)}</option>)}
        </select>
      </div>
      <ul className="space-y-3">
        {shown.map(({ key, current: v, timeline, history }) => {
          const expanded = open === key;
          return (
            <li key={key} className="rounded-2xl border border-border bg-bg-secondary">
              <button
                type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : key)}
                className="focus-ring flex w-full items-start gap-3 rounded-2xl p-4 text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">{formatJurisdiction(v.jurisdiction)}</span>
                    <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${TIMELINE_STYLE[timeline]}`}>{timelineLabel(timeline)}</span>
                    <span className="text-xs text-text-secondary">{KIND_LABELS[v.kind]} · v{v.version}</span>
                  </div>
                  <p className="mt-1.5 text-sm font-semibold text-text-primary">{v.title}</p>
                  <p className="mt-0.5 text-xs text-text-secondary">
                    Applies to {v.appliesTo.map((s) => SURFACE_LABELS[s].toLowerCase()).join(', ')} · {SEVERITY_LABELS[v.severity]}
                  </p>
                </div>
                <ChevronDown className={`mt-1 h-4 w-4 shrink-0 text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden />
              </button>
              {expanded && (
                <div className="space-y-3 border-t border-border px-4 pb-4 pt-3">
                  <p className="text-sm text-text-primary">{v.ownerExplanation}</p>
                  <dl className="grid gap-x-6 gap-y-1 text-xs text-text-secondary sm:grid-cols-2">
                    <div><dt className="inline font-medium">Effective from: </dt><dd className="inline">{v.effectiveFrom}</dd></div>
                    <div><dt className="inline font-medium">Effective until: </dt><dd className="inline">{v.effectiveTo ?? 'no end date'}</dd></div>
                    {v.legalReviewer && <div className="sm:col-span-2"><dt className="inline font-medium">Legal review: </dt><dd className="inline">{v.legalReviewer}{v.legalReviewedAt ? `, ${new Date(v.legalReviewedAt).toLocaleDateString()}` : ''}</dd></div>}
                  </dl>
                  <div>
                    <p className="text-xs font-medium text-text-primary">Sources</p>
                    <Sources v={v} />
                  </div>
                  {history.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-text-primary">Earlier versions</p>
                      <ul className="mt-1 space-y-0.5 text-xs text-text-secondary">
                        {history.map((h) => (
                          <li key={h.id}>v{h.version}: {h.effectiveFrom} → {h.effectiveTo ?? 'open'} ({h.status === 'retired' ? 'retired' : 'superseded'})</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
