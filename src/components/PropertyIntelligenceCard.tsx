import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Database,
  Info,
  Loader2,
  RefreshCw,
  Sparkles,
  Wind,
} from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import {
  LEVEL_LABELS,
  PROVIDER_LABELS,
  enrichProperty,
  fetchPropertyBriefing,
  type GraphNode,
  type LikelihoodLevel,
  type NodeState,
  type ProviderId,
  type PropertyBriefing,
  type PropertySignal,
} from '@/lib/propertyIntelligence';

const LEVEL_STYLES: Record<LikelihoodLevel, string> = {
  high: 'bg-danger-500/10 text-danger-500',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-success-500/10 text-success-500',
  unknown: 'bg-bg-tertiary text-text-secondary',
};

const SIGNAL_STYLES: Record<PropertySignal['severity'], string> = {
  alert: 'bg-danger-500/10 text-danger-500',
  watch: 'bg-warning-500/10 text-warning-500',
  info: 'bg-bg-tertiary text-text-secondary',
};

const STATE_ICON: Record<NodeState, JSX.Element> = {
  known: <CheckCircle2 size={14} className="text-success-500" aria-label="Known" />,
  estimated: <Wind size={14} className="text-warning-500" aria-label="Estimated" />,
  missing: <CircleDashed size={14} className="text-text-secondary" aria-label="Missing" />,
};

const PROVIDER_ORDER: ProviderId[] = ['census', 'rentcast', 'attom_permits', 'nasa_power', 'eia'];

function GraphNodeRow({ node, last }: { node: GraphNode; last: boolean }) {
  return (
    <li className="relative flex gap-3 pb-3">
      {!last && <span className="absolute left-[6px] top-5 h-full w-px bg-border" aria-hidden="true" />}
      <span className="relative mt-0.5 shrink-0">{STATE_ICON[node.state]}</span>
      <div className="min-w-0">
        <p className="text-xs text-text-secondary">{node.label}</p>
        <p className={`text-sm font-medium ${node.state === 'missing' ? 'text-text-secondary' : 'text-text-primary'}`}>{node.value}</p>
        {(node.detail || node.source) && (
          <p className="text-xs text-text-secondary">
            {[node.detail, node.source ? `Source: ${node.source}` : null].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>
    </li>
  );
}

export function PropertyIntelligenceCard({ siteId, hasAddress }: { siteId: string; hasAddress: boolean }) {
  const { toast } = useToast();
  const [briefing, setBriefing] = useState<PropertyBriefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setLoadError(false);
    try {
      const result = await fetchPropertyBriefing(siteId);
      if (id === requestId.current) setBriefing(result);
    } catch {
      if (id === requestId.current) setLoadError(true);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setEnriching(true);
    try {
      const result = await enrichProperty(siteId);
      requestId.current++;
      setBriefing(result);
      setLoadError(false);
      toast(result.status === 'failed' ? 'No property records found for this address.' : 'Property intelligence updated.', result.status === 'failed' ? 'error' : 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update property intelligence.', 'error');
    } finally {
      setEnriching(false);
    }
  }, [siteId, toast]);

  const header = (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Database size={16} className="text-cta" />
        <p className="text-sm font-semibold text-text-primary">Property Intelligence Graph</p>
      </div>
      <Button size="sm" variant="secondary" onClick={() => void refresh()} disabled={enriching || loading || !hasAddress}>
        {enriching ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        {briefing && briefing.status !== 'not_enriched' ? 'Refresh data' : 'Enrich this property'}
      </Button>
    </div>
  );

  if (loading && !briefing) {
    return (
      <div className="rounded-2xl border border-border bg-bg-secondary p-5" aria-busy="true">
        {header}
        <div className="space-y-2">
          <div className="h-4 w-1/3 animate-pulse rounded bg-bg-tertiary" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-bg-tertiary" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-bg-tertiary" />
        </div>
      </div>
    );
  }

  if (loadError && !briefing) {
    return (
      <div className="rounded-2xl border border-border bg-bg-secondary p-5">
        {header}
        <p className="text-sm text-text-secondary">Property intelligence could not be loaded.</p>
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => void load()}>Try again</Button>
      </div>
    );
  }
  if (!briefing) return null;

  const { hvac, graph, signals, permits, providers } = briefing;
  const enriched = briefing.status !== 'not_enriched';
  const connected = PROVIDER_ORDER.filter((id) => providers[id]);
  const notConnected = connected.filter((id) => providers[id]?.state === 'skipped');
  const coveragePct = Math.round(graph.coverage * 100);

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-5">
      {header}

      {!hasAddress && (
        <p className="mb-3 flex items-center gap-2 rounded-xl border border-warning-500/30 bg-warning-500/5 p-3 text-xs text-warning-500">
          <AlertTriangle size={14} /> Add a street address plus a city/state or ZIP to this site to enable property enrichment.
        </p>
      )}

      {!enriched && hasAddress && (
        <p className="mb-3 flex items-center gap-2 rounded-xl border border-border bg-bg-primary p-3 text-xs text-text-secondary">
          <Info size={14} /> Not enriched yet. Select “Enrich this property” to pull parcel, permit, climate and energy data. Scores below already use your own equipment and job history.
        </p>
      )}

      {briefing.status === 'failed' && (
        <p className="mb-3 flex items-center gap-2 rounded-xl border border-warning-500/30 bg-warning-500/5 p-3 text-xs text-warning-500">
          <AlertTriangle size={14} /> No external records were found for this address. Check the spelling, or try again later.
        </p>
      )}

      {briefing.is_stale && (
        <p className="mb-3 text-xs text-text-secondary">This data is more than 60 days old — refresh to pick up new permits and records.</p>
      )}

      {/* HVAC replacement likelihood */}
      <div className="mb-4 rounded-xl border border-border bg-bg-primary p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-cta" />
            <p className="text-sm font-semibold text-text-primary">HVAC replacement likelihood</p>
          </div>
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${LEVEL_STYLES[hvac.level]}`}>
            {LEVEL_LABELS[hvac.level]}
            {hvac.score !== null ? ` · ${hvac.score}/100` : ''}
          </span>
        </div>
        {hvac.ceiling_score !== null && (
          <p className="mt-1 text-xs text-text-secondary">Could be up to {hvac.ceiling_score}/100 if the original system is still in place.</p>
        )}
        <ul className="mt-2 space-y-1 text-xs text-text-secondary">
          {hvac.reasons.map((reason) => (
            <li key={reason}>• {reason}</li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
          {hvac.score !== null && <span>Confidence {Math.round(hvac.confidence * 100)}%</span>}
          {hvac.ask_caller && <span className="text-text-primary">→ {hvac.ask_caller}</span>}
        </div>
        <p className="mt-2 text-[11px] text-text-secondary">An estimate to help preparation — not a diagnosis. Always confirm on site.</p>
      </div>

      {signals.length > 0 && (
        <div className="mb-4 space-y-2">
          {signals.map((signal) => (
            <div key={signal.id} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-text-primary">{signal.label}</p>
                <p className="text-xs text-text-secondary">{signal.detail}</p>
              </div>
              <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${SIGNAL_STYLES[signal.severity]}`}>{signal.severity.toUpperCase()}</span>
            </div>
          ))}
        </div>
      )}

      {/* The graph itself */}
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-medium text-text-secondary">Property graph</p>
        <p className="text-xs text-text-secondary">{coveragePct}% complete</p>
      </div>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-valuenow={coveragePct} aria-valuemin={0} aria-valuemax={100} aria-label="Property graph completeness">
        <div className="h-full rounded-full bg-cta transition-[width] duration-500" style={{ width: `${coveragePct}%` }} />
      </div>
      <ol className="grid gap-x-6 sm:grid-cols-2">
        {graph.nodes.map((node, index) => (
          <GraphNodeRow key={node.id} node={node} last={index >= graph.nodes.length - 2} />
        ))}
      </ol>

      {permits.length > 0 && (
        <div className="mt-2">
          <p className="mb-2 text-xs font-medium text-text-secondary">Recent permits</p>
          <div className="space-y-1.5">
            {permits.slice(0, 5).map((permit, index) => (
              <div key={`${permit.permit_number ?? 'p'}-${index}`} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs">
                <span className="min-w-0 truncate text-text-primary">
                  {permit.description ?? permit.permit_type ?? 'Permit'}
                </span>
                <span className="shrink-0 text-text-secondary">
                  {permit.work_category.replace('_', ' ')}
                  {permit.issued_date ? ` · ${permit.issued_date}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {notConnected.length > 0 && (
        <p className="mt-3 text-xs text-text-secondary">
          Not connected: {notConnected.map((id) => PROVIDER_LABELS[id]).join(', ')}. Add the API key in your Supabase secrets to enable it.
        </p>
      )}
      <p className="mt-3 text-[11px] text-text-secondary">
        Facts come from public and commercial property records and may be incomplete or out of date. Owner names, sale prices and tax values are never stored or used.
      </p>
    </div>
  );
}
