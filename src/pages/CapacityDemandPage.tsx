import { useCallback, useEffect, useState } from 'react';
import { Gauge, Sparkles, ListPlus, Settings2, Trash2, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  STATUS_LABELS,
  STATUS_COLORS,
  describeAction,
  fetchCapacityDemandInsights,
  fetchCapacityPolicy,
  fetchCapacityWaitlist,
  updateCapacityPolicy,
  addToCapacityWaitlist,
  updateCapacityWaitlistStatus,
  type CapacityPolicy,
  type CapacityStatusResult,
  type CapacityDemandInsight,
  type CapacityWaitlistEntry,
} from '@/lib/capacityDemand';

function StatusPill({ status }: { status: CapacityStatusResult['status'] }) {
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_COLORS[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function CapacityDemandPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [status, setStatus] = useState<CapacityStatusResult | null>(null);
  const [insights, setInsights] = useState<CapacityDemandInsight[]>([]);
  const [policy, setPolicy] = useState<CapacityPolicy | null>(null);
  const [waitlist, setWaitlist] = useState<CapacityWaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const [waitlistName, setWaitlistName] = useState('');
  const [waitlistPhone, setWaitlistPhone] = useState('');
  const [waitlistDate, setWaitlistDate] = useState('');
  const [addingToWaitlist, setAddingToWaitlist] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [policyRes, waitlistRes] = await Promise.all([fetchCapacityPolicy(), fetchCapacityWaitlist()]);
      setPolicy(policyRes);
      setWaitlist(waitlistRes);
    } catch {
      toast('Failed to load capacity demand data', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (user) loadAll();
  }, [user, loadAll]);

  const runControl = useCallback(async () => {
    setRunning(true);
    try {
      const result = await fetchCapacityDemandInsights();
      setStatus(result.status);
      setInsights(result.insights);
    } catch {
      toast('Failed to run capacity demand control', 'error');
    } finally {
      setRunning(false);
    }
  }, [toast]);

  const savePolicy = useCallback(
    async (patch: Partial<CapacityPolicy>) => {
      try {
        const updated = await updateCapacityPolicy(patch);
        setPolicy(updated);
        toast('Policy updated', 'success');
      } catch {
        toast('Failed to update policy', 'error');
      }
    },
    [toast],
  );

  const submitWaitlist = useCallback(async () => {
    if (!waitlistName.trim() || !waitlistDate) {
      toast('Name and requested date are required', 'error');
      return;
    }
    setAddingToWaitlist(true);
    try {
      const entry = await addToCapacityWaitlist({
        customerName: waitlistName,
        requestedDate: waitlistDate,
        customerPhone: waitlistPhone || undefined,
      });
      setWaitlist((prev) => [entry, ...prev]);
      setWaitlistName('');
      setWaitlistPhone('');
      setWaitlistDate('');
      toast('Added to waitlist', 'success');
    } catch {
      toast('Failed to add to waitlist', 'error');
    } finally {
      setAddingToWaitlist(false);
    }
  }, [waitlistName, waitlistPhone, waitlistDate, toast]);

  const markCancelled = useCallback(
    async (entryId: string) => {
      try {
        const updated = await updateCapacityWaitlistStatus(entryId, 'cancelled');
        setWaitlist((prev) => prev.map((e) => (e.id === entryId ? updated : e)));
      } catch {
        toast('Failed to update waitlist entry', 'error');
      }
    },
    [toast],
  );

  const markBooked = useCallback(
    async (entryId: string) => {
      try {
        const updated = await updateCapacityWaitlistStatus(entryId, 'booked');
        setWaitlist((prev) => prev.map((e) => (e.id === entryId ? updated : e)));
      } catch {
        toast('Failed to update waitlist entry', 'error');
      }
    },
    [toast],
  );

  const activeWaitlist = waitlist.filter((e) => e.status === 'waiting' || e.status === 'offered');

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Gauge size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">AI Capacity-Based Demand Control</h1>
            <p className="mt-1 text-sm text-text-secondary">
              When today's schedule has room, the AI recommends generating demand. When it's full, it
              protects the schedule with a waitlist and a reserved emergency buffer instead of overbooking.
            </p>
          </div>
        </div>

        <Card className="mb-8 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-text-primary">Today's status</h2>
              <p className="mt-1 text-xs text-text-secondary">
                Runs the same locked capacity numbers used by the Technician Capacity page — nothing here is
                a separate source of truth.
              </p>
            </div>
            <Button size="sm" onClick={runControl} disabled={running}>
              <Sparkles size={14} />
              {running ? 'Analyzing…' : 'Run AI analysis'}
            </Button>
          </div>

          {status && (
            <div className="mt-5">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <StatusPill status={status.status} />
                <span className="text-sm text-text-secondary">
                  {status.day_load} / {status.day_capacity} jobs booked today
                  {status.load_pct !== null ? ` (${status.load_pct}%)` : ''}
                </span>
              </div>
              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                  <p className="text-xl font-bold text-text-primary">{status.normal_slots_remaining}</p>
                  <p className="text-xs text-text-secondary">Open bookable slots</p>
                </div>
                <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                  <p className="text-xl font-bold text-text-primary">{status.emergency_slots_remaining}</p>
                  <p className="text-xs text-text-secondary">Emergency reserve left</p>
                </div>
                <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                  <p className="text-xl font-bold text-text-primary">{activeWaitlist.length}</p>
                  <p className="text-xs text-text-secondary">On waitlist</p>
                </div>
              </div>
              {status.action_taken && (
                <p className="mb-4 text-xs font-semibold text-text-secondary">
                  AI recommendation: {describeAction(status.action_taken)}
                </p>
              )}
              {insights.length > 0 && (
                <div className="space-y-2">
                  {insights.map((insight, i) => (
                    <div key={i} className="rounded-xl border border-border/70 p-3">
                      <p className="text-sm font-semibold text-text-primary">{insight.title}</p>
                      <p className="mt-1 text-xs text-text-secondary">{insight.description}</p>
                      <p className="mt-1 text-xs font-medium text-accent">{insight.recommended_action}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>

        <Card className="mb-8 p-6">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Settings2 size={16} /> Policy
          </h2>
          {!loading && policy && (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-xs font-medium text-text-secondary">
                Low-capacity threshold (%)
                <Input
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={policy.low_threshold_pct}
                  onBlur={(e) => savePolicy({ low_threshold_pct: Number(e.target.value) })}
                  className="mt-1"
                />
              </label>
              <label className="text-xs font-medium text-text-secondary">
                Full-capacity threshold (%)
                <Input
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={policy.full_threshold_pct}
                  onBlur={(e) => savePolicy({ full_threshold_pct: Number(e.target.value) })}
                  className="mt-1"
                />
              </label>
              <label className="text-xs font-medium text-text-secondary">
                Emergency reserve (slots/day)
                <Input
                  type="number"
                  min={0}
                  defaultValue={policy.emergency_reserve_slots}
                  onBlur={(e) => savePolicy({ emergency_reserve_slots: Number(e.target.value) })}
                  className="mt-1"
                />
              </label>
              <div className="flex flex-col gap-2 pt-5 text-xs font-medium text-text-secondary">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={policy.waitlist_enabled}
                    onChange={(e) => savePolicy({ waitlist_enabled: e.target.checked })}
                  />
                  Waitlist mode when full
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={policy.auto_demand_campaigns_enabled}
                    onChange={(e) => savePolicy({ auto_demand_campaigns_enabled: e.target.checked })}
                  />
                  Recommend demand campaigns when under capacity
                </label>
              </div>
            </div>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-text-primary">
            <ListPlus size={16} /> Waitlist
          </h2>

          <div className="mb-5 grid gap-2 sm:grid-cols-4">
            <Input
              placeholder="Customer name"
              value={waitlistName}
              onChange={(e) => setWaitlistName(e.target.value)}
            />
            <Input
              placeholder="Phone (optional)"
              value={waitlistPhone}
              onChange={(e) => setWaitlistPhone(e.target.value)}
            />
            <Input type="date" value={waitlistDate} onChange={(e) => setWaitlistDate(e.target.value)} />
            <Button size="sm" onClick={submitWaitlist} disabled={addingToWaitlist}>
              Add
            </Button>
          </div>

          <div className="space-y-1.5">
            {activeWaitlist.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2 text-xs"
              >
                <span className="font-medium text-text-primary">{entry.customer_name}</span>
                <span className="text-text-secondary">Wants: {entry.requested_date}</span>
                <span className="text-text-secondary/70">{entry.status}</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => markBooked(entry.id)}
                    className="flex items-center gap-1 text-success-500 hover:underline"
                  >
                    <CheckCircle2 size={12} /> Booked
                  </button>
                  <button
                    onClick={() => markCancelled(entry.id)}
                    className="flex items-center gap-1 text-danger hover:underline"
                  >
                    <Trash2 size={12} /> Cancel
                  </button>
                </div>
              </div>
            ))}

            {activeWaitlist.length === 0 && (
              <p className="py-6 text-center text-sm text-text-secondary">
                Nobody on the waitlist right now.
              </p>
            )}
          </div>
        </Card>
      </div>
    </DashboardLayout>
  );
}
