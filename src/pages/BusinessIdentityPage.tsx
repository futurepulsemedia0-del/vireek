/**
 * Continual Identity Learner — /dashboard/identity
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, Check, ChevronDown, Fingerprint, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  DECISION_TEMPLATES,
  SEVERITY_LABELS,
  acknowledgeDrift,
  fetchDriftEvents,
  fetchIdentityProfile,
  fetchIdentitySnapshots,
  fetchRecentDecisionEvents,
  logFromTemplate,
  recomputeIdentitySnapshot,
  type DriftSeverity,
  type IdentityDecisionEvent,
  type IdentityDimension,
  type IdentityDriftEvent,
  type IdentitySnapshot,
} from '@/lib/identityLearner';

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const SEVERITY_CLASSES: Record<DriftSeverity, string> = {
  notable: 'bg-warning-500/10 text-warning-500 ring-1 ring-warning-500/20',
  significant: 'bg-cta/10 text-cta ring-1 ring-cta/20',
  major: 'bg-danger/10 text-danger ring-1 ring-danger/20',
};

function DimensionBar({ dim, history }: { dim: IdentityDimension; history: IdentitySnapshot[] }) {
  const [expanded, setExpanded] = useState(false);
  const pct = ((dim.score + 1) / 2) * 100;
  const hasData = dim.sample_count > 0;

  const points = useMemo(() => {
    return history
      .map((s) => s.vector[dim.dimension_key])
      .filter((v): v is number => typeof v === 'number');
  }, [history, dim.dimension_key]);

  const path = useMemo(() => {
    if (points.length < 2) return null;
    const w = 300;
    const h = 56;
    const xStep = w / (points.length - 1);
    const yFor = (v: number) => h / 2 - (v * (h / 2 - 4));
    return points.map((v, i) => `${i === 0 ? 'M' : 'L'} ${i * xStep} ${yFor(v)}`).join(' ');
  }, [points]);

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <button type="button" onClick={() => setExpanded((v) => !v)} className="focus-ring flex w-full flex-col gap-2 text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-text-primary">{dim.label}</span>
          <span className="flex items-center gap-2">
            <span className={`text-xs ${hasData ? 'text-text-secondary' : 'text-text-secondary/50'}`}>
              {hasData ? `${dim.sample_count} decision${dim.sample_count === 1 ? '' : 's'} · ${timeAgo(dim.last_event_at)}` : 'No data yet'}
            </span>
            <ChevronDown size={14} className={`text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <span className="w-28 shrink-0 text-right">{dim.pole_negative_label}</span>
          <span className="relative h-2 flex-1 rounded-full bg-bg-tertiary">
            <span className="absolute left-1/2 top-0 h-2 w-px -translate-x-1/2 bg-border" />
            <motion.span
              initial={false}
              animate={{ left: `${pct}%` }}
              transition={{ type: 'spring', stiffness: 200, damping: 24 }}
              className={`absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg-secondary shadow-sm ${
                hasData ? 'bg-accent' : 'bg-text-secondary/40'
              }`}
            />
          </span>
          <span className="w-28 shrink-0">{dim.pole_positive_label}</span>
        </div>
      </button>

      {expanded && (
        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} className="overflow-hidden">
          <p className="mt-3 text-xs text-text-secondary">{dim.description}</p>
          {path ? (
            <svg viewBox="0 0 300 56" className="mt-3 w-full" style={{ height: 56 }}>
              <line x1="0" y1="28" x2="300" y2="28" stroke="rgb(var(--border-default))" strokeDasharray="2 4" />
              <path d={path} fill="none" stroke="rgb(var(--accent-primary))" strokeWidth="2" />
            </svg>
          ) : (
            <p className="mt-3 text-xs text-text-secondary/60">Not enough history yet for a trend line.</p>
          )}
        </motion.div>
      )}
    </div>
  );
}

function DriftCard({ drift, onAcknowledge }: { drift: IdentityDriftEvent; onAcknowledge: (id: string) => void }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning-500" />
          <div>
            <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY_CLASSES[drift.severity]}`}>
              {SEVERITY_LABELS[drift.severity]}
            </span>
            <p className="mt-1.5 text-sm text-text-primary">{drift.narrative}</p>
            <p className="mt-1 text-xs text-text-secondary">Detected {timeAgo(drift.detected_at)}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onAcknowledge(drift.id)}
          className="focus-ring shrink-0 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary"
        >
          Acknowledge
        </button>
      </div>
    </div>
  );
}

export function BusinessIdentityPage() {
  const { toast } = useToast();
  const [dimensions, setDimensions] = useState<IdentityDimension[]>([]);
  const [snapshots, setSnapshots] = useState<IdentitySnapshot[]>([]);
  const [drifts, setDrifts] = useState<IdentityDriftEvent[]>([]);
  const [events, setEvents] = useState<IdentityDecisionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [logging, setLogging] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [profile, hist, driftList, recent] = await Promise.all([
        fetchIdentityProfile(),
        fetchIdentitySnapshots(),
        fetchDriftEvents(),
        fetchRecentDecisionEvents(10),
      ]);
      setDimensions(profile);
      setSnapshots(hist);
      setDrifts(driftList.filter((d) => !d.acknowledged));
      setEvents(recent);
    } catch {
      toast('Could not load your business identity profile.', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void (async () => {
      try { await recomputeIdentitySnapshot(false); } catch { /* non-critical on load */ }
      await load();
    })();
  }, [load]);

  const handleAnalyzeNow = async () => {
    setAnalyzing(true);
    try {
      const result = await recomputeIdentitySnapshot(true);
      await load();
      toast(
        result.drift_detected_count > 0
          ? `Analysis complete — ${result.drift_detected_count} shift${result.drift_detected_count === 1 ? '' : 's'} detected.`
          : 'Analysis complete — no significant identity shifts.',
        'success'
      );
    } catch {
      toast('Could not run the analysis.', 'error');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleAcknowledge = async (id: string) => {
    setDrifts((prev) => prev.filter((d) => d.id !== id));
    try {
      await acknowledgeDrift(id);
    } catch {
      toast('Could not acknowledge this alert.', 'error');
      void load();
    }
  };

  const handleLogTemplate = async (key: string) => {
    setLogging(key);
    try {
      await logFromTemplate(key);
      await load();
      toast('Decision logged.', 'success');
    } catch {
      toast('Could not log this decision.', 'error');
    } finally {
      setLogging(null);
    }
  };

  return (
    <DashboardLayout activeLabel="Identity Learner">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Fingerprint size={18} /> Continual Identity Learner
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Learns who this business actually is from real decisions — not a preferences form — and flags it when priorities have genuinely shifted.
            </p>
          </div>
          <button
            type="button"
            onClick={handleAnalyzeNow}
            disabled={analyzing}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-60"
          >
            {analyzing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Analyze now
          </button>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl bg-bg-tertiary" />)}
          </div>
        ) : (
          <div className="space-y-6">
            {drifts.length > 0 && (
              <div className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary/60">Identity shifts</h2>
                {drifts.map((d) => (
                  <DriftCard key={d.id} drift={d} onAcknowledge={handleAcknowledge} />
                ))}
              </div>
            )}

            <div className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary/60">Current profile</h2>
              {dimensions.map((dim) => (
                <DimensionBar key={dim.dimension_key} dim={dim} history={snapshots} />
              ))}
            </div>

            <div className="rounded-2xl border border-border bg-bg-secondary p-4">
              <h2 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-text-secondary/60">
                <Sparkles size={13} /> Log a real decision
              </h2>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {DECISION_TEMPLATES.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => void handleLogTemplate(t.key)}
                    disabled={logging === t.key}
                    className="focus-ring flex items-center justify-between gap-2 rounded-xl border border-border px-3 py-2.5 text-left text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-60"
                  >
                    {t.label}
                    {logging === t.key ? <Loader2 size={14} className="shrink-0 animate-spin" /> : <Check size={14} className="shrink-0 opacity-0" />}
                  </button>
                ))}
              </div>
            </div>

            {events.length > 0 && (
              <div className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary/60">Recent decisions</h2>
                {events.map((e) => (
                  <div key={e.id} className="flex items-center justify-between gap-2 rounded-xl border border-border/60 px-3 py-2 text-xs text-text-secondary">
                    <span className="truncate">{e.note || e.source.replace(/_/g, ' ')}</span>
                    <span className="shrink-0">{timeAgo(e.occurred_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
