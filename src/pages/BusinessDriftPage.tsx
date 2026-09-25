import { useCallback, useEffect, useState } from 'react';
import { Compass, Sparkles, TrendingUp, TrendingDown } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  runBusinessDriftScan,
  fetchBusinessDriftHistory,
  METRIC_LABELS,
  type BusinessDriftSnapshot,
} from '@/lib/businessDrift';

const SEVERITY_COLORS: Record<string, string> = {
  info: 'bg-accent/10 text-accent',
  warning: 'bg-warning-500/10 text-warning-500',
  critical: 'bg-danger/10 text-danger',
};

function scoreColor(score: number) {
  if (score >= 60) return 'text-danger';
  if (score >= 30) return 'text-warning-500';
  return 'text-success-500';
}

export function BusinessDriftPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [current, setCurrent] = useState<BusinessDriftSnapshot | null>(null);
  const [history, setHistory] = useState<BusinessDriftSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchBusinessDriftHistory();
      setHistory(rows);
      setCurrent(rows[0] ?? null);
    } catch {
      toast('Failed to load drift history', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (user) loadHistory();
  }, [user, loadHistory]);

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const snapshot = await runBusinessDriftScan();
      setCurrent(snapshot);
      setHistory((prev) => [snapshot, ...prev]);
    } catch {
      toast('Failed to run the drift scan', 'error');
    } finally {
      setScanning(false);
    }
  }, [toast]);

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Compass size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Business Drift Detector</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Last 30 days vs the prior 90-day baseline, across 7 signals — surfaced before it shows up
              in a monthly report as a margin or reputation problem.
            </p>
          </div>
        </div>

        <Card className="mb-8 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs text-text-secondary">Drift score</p>
              <p className={`text-4xl font-bold ${current ? scoreColor(current.drift_score) : 'text-text-primary'}`}>
                {current ? `${current.drift_score}%` : '—'}
              </p>
              <p className="mt-1 text-xs text-text-secondary">
                {current ? `${current.flagged_count} of 7 signals drifting the wrong way` : 'No scans yet'}
              </p>
            </div>
            <Button onClick={runScan} disabled={scanning}>
              <Sparkles size={14} />
              {scanning ? 'Scanning…' : 'Run scan'}
            </Button>
          </div>

          {current && (
            <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {Object.values(current.metrics).map((m) => (
                <div
                  key={m.metric}
                  className={`flex items-center justify-between rounded-lg border p-3 ${
                    m.flagged ? 'border-danger/40 bg-danger/5' : 'border-border'
                  }`}
                >
                  <div>
                    <p className="text-sm text-text-primary">{METRIC_LABELS[m.metric] ?? m.metric}</p>
                    <p className="text-xs text-text-secondary">
                      {m.sample_ok ? `${m.recent} ${m.unit} (was ${m.baseline})` : 'Not enough data yet'}
                    </p>
                  </div>
                  {m.sample_ok && (
                    <span className={`flex items-center gap-1 text-xs font-semibold ${m.flagged ? 'text-danger' : 'text-text-secondary'}`}>
                      {m.pct_change >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                      {Math.abs(m.pct_change)}%
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        {current && current.insights.length > 0 && (
          <Card className="mb-8 p-6">
            <h3 className="mb-4 text-sm font-semibold text-text-primary">What's actually going on</h3>
            <div className="space-y-3">
              {current.insights.map((insight, i) => (
                <div key={i} className="rounded-lg border border-border p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_COLORS[insight.severity]}`}>
                      {insight.severity}
                    </span>
                    <span className="text-sm font-semibold text-text-primary">{insight.headline}</span>
                  </div>
                  <p className="text-sm text-text-secondary">{insight.message}</p>
                  <p className="mt-1 text-xs text-text-secondary">→ {insight.recommended_action}</p>
                </div>
              ))}
            </div>
          </Card>
        )}

        <Card className="p-6">
          <h3 className="mb-4 text-sm font-semibold text-text-primary">Drift score over time</h3>
          {loading ? (
            <p className="text-sm text-text-secondary">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-text-secondary">No scans yet.</p>
          ) : (
            <div className="space-y-2">
              {history.map((snap) => (
                <button
                  key={snap.id}
                  type="button"
                  onClick={() => setCurrent(snap)}
                  className="flex w-full items-center justify-between rounded-lg border border-border p-3 text-left hover:border-accent/50"
                >
                  <span className="text-sm text-text-secondary">
                    {new Date(snap.created_at).toLocaleDateString()}
                  </span>
                  <span className={`text-sm font-bold ${scoreColor(snap.drift_score)}`}>{snap.drift_score}%</span>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>
    </DashboardLayout>
  );
}
