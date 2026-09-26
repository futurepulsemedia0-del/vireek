// src/pages/BusinessImmuneSystemPage.tsx
//
// Full Business Immune System console: signal feed, filters, manual
// containment (pause an automation), resolution feedback and settings.
// Mirrors src/pages/ServiceRecoveryPage.tsx's structure and idioms.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Siren, CheckCircle2, XCircle, PauseCircle, ThumbsUp, ThumbsDown, ChevronDown, ChevronUp, Settings2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { supabase, BusinessImmuneSignal, BusinessImmuneSettings } from '@/lib/supabase';
import {
  CATEGORY_LABELS,
  CATEGORY_DESCRIPTIONS,
  STATUS_LABELS,
  STATUS_COLORS,
  SEVERITY_COLORS,
  severityLabel,
  isOpenImmuneSignal,
  byActiveSeverityThenRecency,
  immuneHealthScore,
  formatRelativeTime,
} from '@/lib/businessImmuneSystem';

type FilterKey = 'active' | 'resolved' | 'all';
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'active', label: 'Active' },
  { key: 'resolved', label: 'Resolved / dismissed' },
  { key: 'all', label: 'All' },
];

interface Automation {
  id: string;
  name: string;
  status: string;
}

function SignalCard({
  signal,
  automations,
  onAck,
  onContain,
  onResolve,
  onDismiss,
}: {
  signal: BusinessImmuneSignal;
  automations: Automation[];
  onAck: (id: string) => void;
  onContain: (id: string, automationId: string | null) => void;
  onResolve: (id: string, outcome: 'true_positive' | 'false_positive') => void;
  onDismiss: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [automationId, setAutomationId] = useState('');
  const sev = severityLabel(signal.severity_score);
  const open = isOpenImmuneSignal(signal.status);

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-text-primary">{signal.title}</p>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${SEVERITY_COLORS[sev]}`}>{sev}</span>
            <span title={CATEGORY_DESCRIPTIONS[signal.category]} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">
              {CATEGORY_LABELS[signal.category]}
            </span>
          </div>
          <p className="mt-1 text-xs text-text-secondary">{signal.detail}</p>
          <p className="mt-1 text-[11px] text-text-secondary">{formatRelativeTime(signal.detected_at)}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_COLORS[signal.status]}`}>{STATUS_LABELS[signal.status]}</span>
      </div>

      {signal.recommended_actions?.length > 0 && (
        <>
          <button type="button" onClick={() => setExpanded((v) => !v)} className="focus-ring mt-2 flex items-center gap-1 text-xs text-accent">
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />} Recommended actions
          </button>
          {expanded && (
            <ul className="mt-2 list-inside list-disc space-y-1 rounded-lg bg-bg-primary p-3 text-xs text-text-secondary">
              {signal.recommended_actions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}
        </>
      )}

      {open && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-border/60 pt-3">
          {signal.status === 'active' && (
            <button type="button" onClick={() => onAck(signal.id)} className="focus-ring flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary">
              <CheckCircle2 size={12} /> Acknowledge
            </button>
          )}
          {automations.length > 0 && (
            <>
              <select value={automationId} onChange={(e) => setAutomationId(e.target.value)} className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-xs">
                <option value="">Pause an automation…</option>
                {automations.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!automationId}
                onClick={() => onContain(signal.id, automationId)}
                className="focus-ring flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:text-danger disabled:opacity-40"
              >
                <PauseCircle size={12} /> Contain
              </button>
            </>
          )}
          <button type="button" onClick={() => onResolve(signal.id, 'false_positive')} className="focus-ring flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary">
            <ThumbsDown size={12} /> False alarm
          </button>
          <button type="button" onClick={() => onResolve(signal.id, 'true_positive')} className="focus-ring flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:brightness-110">
            <ThumbsUp size={12} /> Resolved
          </button>
          <button type="button" onClick={() => onDismiss(signal.id)} className="focus-ring flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:text-danger">
            <XCircle size={12} /> Dismiss
          </button>
        </div>
      )}
    </motion.div>
  );
}

export function BusinessImmuneSystemPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [signals, setSignals] = useState<BusinessImmuneSignal[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [settings, setSettings] = useState<BusinessImmuneSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>('active');
  const [showSettings, setShowSettings] = useState(false);

  const fetchAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [{ data: sigData, error: sigError }, { data: autoData }, { data: settingsData }] = await Promise.all([
      supabase.from('business_immune_signals').select('*').order('detected_at', { ascending: false }).limit(300),
      supabase.from('workflow_definitions').select('id, name, status').eq('status', 'active'),
      supabase.from('business_immune_settings').select('*').maybeSingle(),
    ]);
    if (sigError) toast('Failed to load immune signals', 'error');
    setSignals((sigData as BusinessImmuneSignal[]) ?? []);
    setAutomations((autoData as Automation[]) ?? []);
    setSettings(
      (settingsData as BusinessImmuneSettings) ?? {
        user_id: user.id,
        enabled: true,
        sensitivity: 'standard',
        notify_critical_via_sms: true,
        muted_categories: [],
        updated_at: new Date().toISOString(),
      },
    );
    setLoading(false);
  }, [user, toast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const filtered = useMemo(() => {
    const base = filter === 'all' ? signals : filter === 'resolved' ? signals.filter((s) => !isOpenImmuneSignal(s.status)) : signals.filter((s) => isOpenImmuneSignal(s.status));
    return byActiveSeverityThenRecency(base);
  }, [signals, filter]);

  const active = useMemo(() => signals.filter((s) => isOpenImmuneSignal(s.status)), [signals]);
  const health = immuneHealthScore(active);

  const logAction = async (signalId: string, action_type: string, detail?: string) => {
    if (!user) return;
    await supabase.from('business_immune_actions').insert({ user_id: user.id, signal_id: signalId, action_type, actor: 'user', detail: detail ?? null });
  };

  const handleAck = async (id: string) => {
    const { error } = await supabase.from('business_immune_signals').update({ status: 'acknowledged', acknowledged_at: new Date().toISOString() }).eq('id', id);
    if (error) return toast('Could not update this signal', 'error');
    await logAction(id, 'acknowledged');
    setSignals((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'acknowledged' } : s)));
  };

  const handleContain = async (id: string, automationId: string | null) => {
    if (automationId) {
      const { error: pauseError } = await supabase.from('workflow_definitions').update({ status: 'paused' }).eq('id', automationId);
      if (pauseError) return toast('Could not pause that automation', 'error');
      await logAction(id, 'automation_paused', `Paused automation ${automationId}`);
    }
    const { error } = await supabase.from('business_immune_signals').update({ status: 'contained', contained_at: new Date().toISOString() }).eq('id', id);
    if (error) return toast('Could not update this signal', 'error');
    toast('Threat contained', 'success');
    fetchAll();
  };

  const handleResolve = async (id: string, outcome: 'true_positive' | 'false_positive') => {
    const { error } = await supabase.from('business_immune_signals').update({ status: 'resolved', resolved_outcome: outcome, resolved_at: new Date().toISOString() }).eq('id', id);
    if (error) return toast('Could not update this signal', 'error');
    await logAction(id, 'resolved', outcome);
    setSignals((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'resolved', resolved_outcome: outcome } : s)));
    toast('Signal resolved', 'success');
  };

  const handleDismiss = async (id: string) => {
    const { error } = await supabase.from('business_immune_signals').update({ status: 'dismissed' }).eq('id', id);
    if (error) return toast('Could not update this signal', 'error');
    await logAction(id, 'dismissed');
    setSignals((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'dismissed' } : s)));
  };

  const saveSettings = async (patch: Partial<BusinessImmuneSettings>) => {
    if (!user || !settings) return;
    const next = { ...settings, ...patch, user_id: user.id, updated_at: new Date().toISOString() };
    setSettings(next);
    const { error } = await supabase.from('business_immune_settings').upsert(next);
    if (error) toast('Could not save settings', 'error');
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger">
              <Siren size={20} />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Business Immune System</h1>
              <p className="mt-1 text-sm text-text-secondary">Detects operational, financial, and reputational anomalies, contains them, and guides recovery — before they become real damage.</p>
            </div>
          </div>
          <button type="button" onClick={() => setShowSettings((v) => !v)} className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary">
            <Settings2 size={14} /> Settings
          </button>
        </div>

        {showSettings && settings && (
          <div className="mb-6 rounded-2xl border border-border bg-bg-secondary p-4">
            <div className="flex items-center justify-between py-2">
              <p className="text-sm text-text-primary">Immune system enabled</p>
              <input type="checkbox" checked={settings.enabled} onChange={(e) => saveSettings({ enabled: e.target.checked })} />
            </div>
            <div className="flex items-center justify-between py-2">
              <p className="text-sm text-text-primary">Page me by SMS on critical threats</p>
              <input type="checkbox" checked={settings.notify_critical_via_sms} onChange={(e) => saveSettings({ notify_critical_via_sms: e.target.checked })} />
            </div>
            <div className="flex items-center justify-between py-2">
              <p className="text-sm text-text-primary">Sensitivity</p>
              <select
                value={settings.sensitivity}
                onChange={(e) => saveSettings({ sensitivity: e.target.value as BusinessImmuneSettings['sensitivity'] })}
                className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-xs"
              >
                <option value="low">Low</option>
                <option value="standard">Standard</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>
        )}

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
                <p className={`text-xl font-bold ${health >= 80 ? 'text-success-500' : health >= 50 ? 'text-warning-500' : 'text-danger'}`}>{health}</p>
                <p className="text-xs text-text-secondary">Health score</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{active.length}</p>
                <p className="text-xs text-text-secondary">Active threats</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-danger">{active.filter((s) => severityLabel(s.severity_score) === 'critical').length}</p>
                <p className="text-xs text-text-secondary">Critical, open</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-success-500">{signals.filter((s) => s.resolved_outcome === 'true_positive').length}</p>
                <p className="text-xs text-text-secondary">Confirmed &amp; resolved</p>
              </div>
            </div>

            <div className="mb-3 flex gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFilter(f.key)}
                  className={`focus-ring rounded-full px-3 py-1 text-xs font-medium transition-colors ${filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}
                >
                  {f.label}
                </button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-10 text-center">
                <p className="text-sm text-text-secondary">{filter === 'active' ? 'No active threats — every system is nominal.' : 'Nothing in this view yet.'}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map((s) => (
                  <SignalCard key={s.id} signal={s} automations={automations} onAck={handleAck} onContain={handleContain} onResolve={handleResolve} onDismiss={handleDismiss} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
