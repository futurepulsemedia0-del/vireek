/**
 * Emergency / Disaster Operations Mode — /dashboard/emergency-ops
 * Ties together: weather-triggered surge, emergency triage queue,
 * on-call activation, and mass communication.
 */

import { useCallback, useEffect, useState } from 'react';
import { Siren, ListOrdered, Megaphone, Power, Loader2, AlertTriangle, Send } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  activateEmergencyMode,
  deactivateEmergencyMode,
  fetchBroadcastHistory,
  fetchEmergencyStatus,
  fetchTriageQueue,
  sendEmergencyBroadcast,
  toggleEmergencyOpsEnabled,
  updateTriageStatus,
  type BroadcastLogItem,
  type EmergencyStatus,
  type TriageItem,
} from '@/lib/emergencyOps';

const TIER_STYLES: Record<TriageItem['priority_tier'], string> = {
  critical: 'bg-error-500/15 text-error-500',
  high: 'bg-warning-500/15 text-warning-500',
  standard: 'bg-bg-tertiary text-text-secondary',
};

export function EmergencyOperationsPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [status, setStatus] = useState<EmergencyStatus | null>(null);
  const [queue, setQueue] = useState<TriageItem[]>([]);
  const [history, setHistory] = useState<BroadcastLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [headline, setHeadline] = useState('');
  const [broadcastMsg, setBroadcastMsg] = useState('');
  const [audience, setAudience] = useState<'customers' | 'team' | 'on_call'>('on_call');

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [s, q, h] = await Promise.all([fetchEmergencyStatus(user.id), fetchTriageQueue(), fetchBroadcastHistory()]);
      setStatus(s);
      setQueue(q);
      setHistory(h);
    } catch {
      toast('Could not load Emergency Operations data.', 'error');
    } finally {
      setLoading(false);
    }
  }, [user, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggleOptIn = async () => {
    if (!user || !status) return;
    setBusy(true);
    try {
      await toggleEmergencyOpsEnabled(user.id, !status.emergency_ops_enabled);
      setStatus({ ...status, emergency_ops_enabled: !status.emergency_ops_enabled });
      toast('Setting saved.', 'success');
    } catch {
      toast('Could not save setting.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleActivate = async () => {
    setBusy(true);
    try {
      const result = await activateEmergencyMode(headline || 'Manual emergency declared.');
      if (!result.activated) {
        toast(result.error ?? 'Already active.', 'error');
      } else {
        toast(`Emergency Mode active. ${result.triage_count ?? 0} job(s) in triage queue.`, 'success');
      }
      await load();
    } catch {
      toast('Could not activate Emergency Mode.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDeactivate = async () => {
    setBusy(true);
    try {
      await deactivateEmergencyMode();
      toast('Emergency Mode turned off.', 'success');
      await load();
    } catch {
      toast('Could not deactivate.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleTriageAction = async (id: string, next: TriageItem['status']) => {
    try {
      await updateTriageStatus(id, next);
      setQueue((prev) => prev.filter((item) => item.id !== id));
    } catch {
      toast('Could not update this item.', 'error');
    }
  };

  const handleBroadcast = async () => {
    if (!broadcastMsg.trim()) return;
    setBusy(true);
    try {
      const result = await sendEmergencyBroadcast(broadcastMsg.trim(), audience);
      toast(`Sent to ${result.sent}/${result.targeted} recipient(s).`, 'success');
      setBroadcastMsg('');
      await load();
    } catch {
      toast('Broadcast failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading || !status) {
    return (
      <DashboardLayout activeLabel="Emergency Operations">
        <div className="flex h-64 items-center justify-center"><Loader2 className="animate-spin" /></div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Emergency Operations">
      <div className="space-y-6 p-6">
        <div className={`rounded-2xl border p-5 ${status.emergency_mode_active ? 'border-error-500/40 bg-error-500/10' : 'border-border bg-bg-secondary'}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Siren className={status.emergency_mode_active ? 'text-error-500' : 'text-text-secondary'} size={22} />
              <div>
                <p className="text-sm font-semibold text-text-primary">
                  {status.emergency_mode_active ? 'Emergency Operations Mode: ACTIVE' : 'Emergency Operations Mode: inactive'}
                </p>
                {status.emergency_mode_headline && <p className="text-xs text-text-secondary">{status.emergency_mode_headline}</p>}
              </div>
            </div>
            <button
              onClick={status.emergency_mode_active ? handleDeactivate : handleActivate}
              disabled={busy}
              className={`focus-ring flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium ${
                status.emergency_mode_active ? 'bg-error-500 text-white' : 'bg-cta text-white'
              }`}
            >
              <Power size={16} /> {status.emergency_mode_active ? 'Deactivate' : 'Activate now'}
            </button>
          </div>
          {!status.emergency_mode_active && (
            <input
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              placeholder="Optional headline (e.g. Regional flooding — activating emergency triage)"
              className="focus-ring mt-3 w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary"
            />
          )}
          <label className="mt-4 flex items-center gap-2 text-xs text-text-secondary">
            <input type="checkbox" checked={status.emergency_ops_enabled} onChange={handleToggleOptIn} disabled={busy} />
            Also let severe weather alerts (from Weather Surge) auto-activate this mode
          </label>
        </div>

        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <div className="mb-3 flex items-center gap-2">
            <ListOrdered size={18} className="text-text-secondary" />
            <p className="text-sm font-semibold text-text-primary">Triage Queue ({queue.length})</p>
          </div>
          {queue.length === 0 ? (
            <p className="text-sm text-text-secondary">No open items right now.</p>
          ) : (
            <div className="space-y-2">
              {queue.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${TIER_STYLES[item.priority_tier]}`}>
                        {item.priority_tier}
                      </span>
                      <p className="truncate text-sm font-medium text-text-primary">{item.customer_name}</p>
                    </div>
                    {item.reason && <p className="mt-0.5 text-xs text-text-secondary">{item.reason}</p>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button onClick={() => handleTriageAction(item.id, 'dispatched')} className="focus-ring rounded-lg bg-cta/15 px-3 py-1.5 text-xs font-medium text-cta">
                      Dispatch
                    </button>
                    <button onClick={() => handleTriageAction(item.id, 'resolved')} className="focus-ring rounded-lg bg-success-500/15 px-3 py-1.5 text-xs font-medium text-success-500">
                      Resolve
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-bg-secondary p-5">
          <div className="mb-3 flex items-center gap-2">
            <Megaphone size={18} className="text-text-secondary" />
            <p className="text-sm font-semibold text-text-primary">Mass Communication</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(['on_call', 'team', 'customers'] as const).map((a) => (
              <button
                key={a}
                onClick={() => setAudience(a)}
                className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium capitalize ${
                  audience === a ? 'bg-cta text-white' : 'bg-bg-tertiary text-text-secondary'
                }`}
              >
                {a.replace('_', ' ')}
              </button>
            ))}
          </div>
          <textarea
            value={broadcastMsg}
            onChange={(e) => setBroadcastMsg(e.target.value)}
            rows={3}
            placeholder="Message to send..."
            className="focus-ring mt-3 w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary"
          />
          <button
            onClick={handleBroadcast}
            disabled={busy || !broadcastMsg.trim()}
            className="focus-ring mt-3 flex items-center gap-2 rounded-xl bg-cta px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            <Send size={16} /> Send broadcast
          </button>

          {history.length > 0 && (
            <div className="mt-4 space-y-2 border-t border-border pt-3">
              {history.map((h) => (
                <div key={h.id} className="flex items-start gap-2 text-xs text-text-secondary">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span>
                    <strong className="text-text-primary">{h.audience}</strong> — {h.recipients_sent}/{h.recipients_targeted} sent — “{h.message}”
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
