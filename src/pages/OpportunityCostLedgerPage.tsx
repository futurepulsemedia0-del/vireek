import { useCallback, useEffect, useState } from 'react';
import { Hourglass, Sparkles, Check, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import {
  fetchOpportunityCostEntries,
  fetchOpportunityCostSummary,
  runOpportunityCostScan,
  updateOpportunityCostStatus,
  ENTRY_TYPE_LABELS,
  type OpportunityCostEntry,
  type OpportunityCostSummaryRow,
  type OpportunityCostType,
} from '@/lib/opportunityCostLedger';

const TYPE_FILTERS: ('all' | OpportunityCostType)[] = ['all', 'technician_low_margin_time', 'quote_stalled_followup', 'idle_capacity'];

export function OpportunityCostLedgerPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [entries, setEntries] = useState<OpportunityCostEntry[]>([]);
  const [summary, setSummary] = useState<OpportunityCostSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState<'all' | OpportunityCostType>('all');

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [entriesRes, summaryRes] = await Promise.all([
        fetchOpportunityCostEntries('open'),
        fetchOpportunityCostSummary(),
      ]);
      setEntries(entriesRes);
      setSummary(summaryRes);
    } catch {
      toast('Failed to load the opportunity cost ledger', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (user) loadAll();
  }, [user, loadAll]);

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const { inserted, ranked } = await runOpportunityCostScan();
      toast(`Scan complete — ${inserted} new entr${inserted === 1 ? 'y' : 'ies'}, ${ranked} ranked`, 'success');
      await loadAll();
    } catch {
      toast('Failed to run the scan', 'error');
    } finally {
      setScanning(false);
    }
  }, [loadAll, toast]);

  const setStatus = useCallback(
    async (id: string, status: 'acknowledged' | 'dismissed') => {
      try {
        await updateOpportunityCostStatus(id, status);
        setEntries((prev) => prev.filter((e) => e.id !== id));
      } catch {
        toast('Failed to update entry', 'error');
      }
    },
    [toast],
  );

  const totalCents = summary.reduce((s, r) => s + r.total_cost_cents, 0);
  const visibleEntries = filter === 'all' ? entries : entries.filter((e) => e.entry_type === filter);

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Hourglass size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Opportunity Cost Ledger</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Not what went wrong — what was left on the table. Every entry is a dollar figure computed
              from your own jobs, quotes, and capacity, ranked by what to fix first.
            </p>
          </div>
        </div>

        <Card className="mb-8 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs text-text-secondary">Left on the table — last 30 days</p>
              <p className="text-3xl font-bold text-text-primary">${(totalCents / 100).toLocaleString()}</p>
            </div>
            <Button onClick={runScan} disabled={scanning}>
              <Sparkles size={14} />
              {scanning ? 'Scanning…' : 'Run scan'}
            </Button>
          </div>
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(['technician_low_margin_time', 'quote_stalled_followup', 'idle_capacity'] as OpportunityCostType[]).map((type) => {
              const row = summary.find((s) => s.entry_type === type);
              return (
                <div key={type} className="rounded-lg bg-bg-tertiary p-3">
                  <p className="text-xs text-text-secondary">{ENTRY_TYPE_LABELS[type]}</p>
                  <p className="mt-1 text-lg font-bold text-text-primary">${((row?.total_cost_cents ?? 0) / 100).toLocaleString()}</p>
                  <p className="text-[11px] text-text-secondary">{row?.entry_count ?? 0} entries</p>
                </div>
              );
            })}
          </div>
        </Card>

        <div className="mb-4 flex flex-wrap gap-2">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                filter === f ? 'bg-accent text-white' : 'border border-border text-text-secondary hover:border-accent'
              }`}
            >
              {f === 'all' ? 'All' : ENTRY_TYPE_LABELS[f]}
            </button>
          ))}
        </div>

        <div className="space-y-3">
          {loading ? (
            <p className="text-sm text-text-secondary">Loading…</p>
          ) : visibleEntries.length === 0 ? (
            <Card className="p-6 text-center text-sm text-text-secondary">
              Nothing open here. Run a scan to check for new opportunity cost.
            </Card>
          ) : (
            visibleEntries.map((entry) => (
              <Card key={entry.id} className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="rounded bg-bg-tertiary px-2 py-0.5 text-[10px] font-semibold uppercase text-text-secondary">
                        {ENTRY_TYPE_LABELS[entry.entry_type]}
                      </span>
                      {entry.priority_score != null && (
                        <span className="text-[11px] font-semibold text-accent">Priority {entry.priority_score}</span>
                      )}
                    </div>
                    <p className="text-sm text-text-primary">{entry.ai_narrative ?? entry.headline}</p>
                    {entry.ai_recommended_action && (
                      <p className="mt-1 text-xs text-text-secondary">→ {entry.ai_recommended_action}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <span className="text-lg font-bold text-danger">${(entry.estimated_cost_cents / 100).toLocaleString()}</span>
                    <div className="flex gap-1">
                      <button type="button" onClick={() => setStatus(entry.id, 'acknowledged')} className="rounded p-1 text-text-secondary hover:text-success-500" title="Acknowledge">
                        <Check size={16} />
                      </button>
                      <button type="button" onClick={() => setStatus(entry.id, 'dismissed')} className="rounded p-1 text-text-secondary hover:text-danger" title="Dismiss">
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
