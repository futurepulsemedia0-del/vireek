import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Bot, ChevronDown } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { SelfHealingTimeline } from '@/components/SelfHealingTimeline';
import {
  SelfHealingIncident, SelfHealingAction,
  fetchSelfHealingIncidents, fetchSelfHealingActions,
  INCIDENT_TYPE_LABELS, RISK_TIER_LABELS, RISK_TIER_COLORS, STAGE_LABELS,
  OUTCOME_LABELS, OUTCOME_COLORS, formatRelativeTime, isActiveIncident,
} from '@/lib/selfHealing';

type FilterKey = 'active' | 'resolved' | 'all';
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'all', label: 'All' },
];

function IncidentRow({ incident, actions, expanded, onToggle }: {
  incident: SelfHealingIncident;
  actions: SelfHealingAction[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-border bg-bg-secondary">
      <button type="button" onClick={onToggle} className="focus-ring flex w-full items-center justify-between gap-3 p-4 text-left">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-text-primary">{INCIDENT_TYPE_LABELS[incident.incident_type]}</p>
            {incident.risk_tier && (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${RISK_TIER_COLORS[incident.risk_tier]}`}>
                {RISK_TIER_LABELS[incident.risk_tier]}
              </span>
            )}
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">
              {STAGE_LABELS[incident.stage]}
            </span>
            {incident.outcome && (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${OUTCOME_COLORS[incident.outcome]}`}>
                {OUTCOME_LABELS[incident.outcome]}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            Detected {formatRelativeTime(incident.detected_at)} · {actions.length} action{actions.length === 1 ? '' : 's'} taken
          </p>
        </div>
        <ChevronDown size={16} className={`shrink-0 text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded && (
        <div className="border-t border-border/60 p-4 pt-4">
          <SelfHealingTimeline incident={incident} actions={actions} />
        </div>
      )}
    </motion.div>
  );
}

export function SelfHealingPage() {
  const [incidents, setIncidents] = useState<SelfHealingIncident[]>([]);
  const [actionsByIncident, setActionsByIncident] = useState<Record<string, SelfHealingAction[]>>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>('active');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const incidentRows = await fetchSelfHealingIncidents();
      setIncidents(incidentRows);
      const actionRows = await fetchSelfHealingActions(incidentRows.map((i) => i.id));
      const grouped: Record<string, SelfHealingAction[]> = {};
      for (const a of actionRows) {
        (grouped[a.incident_id] ??= []).push(a);
      }
      setActionsByIncident(grouped);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const filtered = useMemo(() => {
    if (filter === 'active') return incidents.filter(isActiveIncident);
    if (filter === 'resolved') return incidents.filter((i) => !isActiveIncident(i));
    return incidents;
  }, [incidents, filter]);

  const stats = useMemo(() => {
    const active = incidents.filter(isActiveIncident).length;
    const recovered = incidents.filter((i) => i.outcome === 'recovered').length;
    const failed = incidents.filter((i) => i.outcome === 'failed').length;
    const critical = incidents.filter((i) => isActiveIncident(i) && i.risk_tier === 'critical').length;
    return { active, recovered, failed, critical };
  }, [incidents]);

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Bot size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Self-Healing Operations</h1>
            <p className="mt-1 text-sm text-text-secondary">
              When a technician runs late, the business repairs itself — notify, reassign, re-route, reschedule downstream
              jobs, reserve parts, and call in the contractor network if needed. No one has to click anything.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="space-y-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : (
          <>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{stats.active}</p>
                <p className="text-xs text-text-secondary">Active incidents</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-danger">{stats.critical}</p>
                <p className="text-xs text-text-secondary">Critical, active</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-success-500">{stats.recovered}</p>
                <p className="text-xs text-text-secondary">Auto-recovered</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{stats.failed}</p>
                <p className="text-xs text-text-secondary">Needs a human</p>
              </div>
            </div>

            <div className="mb-3 flex gap-1.5">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" onClick={() => setFilter(f.key)} className={`focus-ring rounded-full px-3 py-1 text-xs font-medium transition-colors ${filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>
                  {f.label}
                </button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-10 text-center">
                <p className="text-sm text-text-secondary">
                  {filter === 'active' ? 'Nothing needs healing right now — every delay so far has been resolved.' : 'Nothing in this view yet.'}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map((incident) => (
                  <IncidentRow
                    key={incident.id}
                    incident={incident}
                    actions={actionsByIncident[incident.id] ?? []}
                    expanded={expandedId === incident.id}
                    onToggle={() => setExpandedId((id) => (id === incident.id ? null : incident.id))}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
