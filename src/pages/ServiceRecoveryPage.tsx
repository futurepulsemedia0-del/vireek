import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { HeartHandshake, Plus, Trash2, X, Check, Send, ThumbsUp, ThumbsDown, EyeOff, AlertTriangle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { supabase, ServiceRecoverySignal } from '@/lib/supabase';
import {
  SignalType,
  SIGNAL_TYPE_LABELS,
  SIGNAL_TYPE_OPTIONS,
  Severity,
  SEVERITY_LABELS,
  SEVERITY_COLORS,
  SignalStatus,
  STATUS_LABELS,
  STATUS_COLORS,
  RecommendedChannel,
  bySeverityThenRecency,
  isOpenSignal,
  formatRelativeTime,
} from '@/lib/serviceRecovery';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors';

type FilterKey = 'open' | 'resolved' | 'all';
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'resolved', label: 'Resolved / ignored' },
  { key: 'all', label: 'All' },
];

// ============================================================
// MANUAL LOG FORM — for signal types with no automatic detector yet
// (payment_dispute today), or anything staff spot before the AI does.
// ============================================================

interface ManualFormState {
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  signal_type: SignalType;
  severity: Severity;
  signal_excerpt: string;
  recommended_channel: RecommendedChannel;
  recommended_message: string;
}

const EMPTY_FORM: ManualFormState = {
  customer_name: '',
  customer_phone: '',
  customer_email: '',
  signal_type: 'payment_dispute',
  severity: 'medium',
  signal_excerpt: '',
  recommended_channel: 'call',
  recommended_message: '',
};

function ManualLogForm({ onCancel, onSave }: { onCancel: () => void; onSave: (form: ManualFormState) => Promise<void> }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ManualFormState>(key: K, value: ManualFormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const handleSave = async () => {
    if (!form.customer_name.trim() || !form.signal_excerpt.trim()) return;
    setSaving(true);
    await onSave(form);
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <p className="mb-2 text-xs font-medium text-text-secondary">Customer</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <input type="text" value={form.customer_name} onChange={(e) => set('customer_name', e.target.value)} placeholder="Customer name" className={inputClass} />
        <input type="tel" value={form.customer_phone} onChange={(e) => set('customer_phone', e.target.value)} placeholder="Phone" className={inputClass} />
        <input type="email" value={form.customer_email} onChange={(e) => set('customer_email', e.target.value)} placeholder="Email (optional)" className={inputClass} />
      </div>

      <p className="mb-2 mt-4 text-xs font-medium text-text-secondary">What happened</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <select value={form.signal_type} onChange={(e) => set('signal_type', e.target.value as SignalType)} className={inputClass}>
          {SIGNAL_TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>{SIGNAL_TYPE_LABELS[t]}</option>
          ))}
        </select>
        <select value={form.severity} onChange={(e) => set('severity', e.target.value as Severity)} className={inputClass}>
          {(Object.keys(SEVERITY_LABELS) as Severity[]).map((s) => (
            <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>
          ))}
        </select>
      </div>
      <textarea value={form.signal_excerpt} onChange={(e) => set('signal_excerpt', e.target.value)} placeholder="Brief description — e.g. 'Customer disputing $340 charge, says work wasn't authorized'" rows={2} className={`${inputClass} mt-3`} />

      <p className="mb-2 mt-4 text-xs font-medium text-text-secondary">Planned response</p>
      <select value={form.recommended_channel} onChange={(e) => set('recommended_channel', e.target.value as RecommendedChannel)} className={inputClass}>
        <option value="call">Phone call</option>
        <option value="sms">Text message</option>
        <option value="email">Email</option>
      </select>
      <textarea value={form.recommended_message} onChange={(e) => set('recommended_message', e.target.value)} placeholder="Draft message or call notes (optional)" rows={2} className={`${inputClass} mt-3`} />

      <div className="mt-4 flex justify-end gap-2 border-t border-border/60 pt-3">
        <button type="button" onClick={onCancel} className="focus-ring flex items-center gap-1 rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
          <X size={14} /> Cancel
        </button>
        <button type="button" onClick={handleSave} disabled={saving || !form.customer_name.trim() || !form.signal_excerpt.trim()} className="focus-ring flex items-center gap-1 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50">
          <Check size={14} /> Log signal
        </button>
      </div>
    </div>
  );
}

// ============================================================
// SIGNAL CARD
// ============================================================

function SignalCard({
  signal,
  onSend,
  onResolve,
  onIgnore,
  onDelete,
}: {
  signal: ServiceRecoverySignal;
  onSend: (signal: ServiceRecoverySignal, message: string, channel: RecommendedChannel) => Promise<void>;
  onResolve: (id: string, outcome: 'recovered' | 'lost') => Promise<void>;
  onIgnore: (id: string) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [message, setMessage] = useState(signal.recommended_message ?? '');
  const [sending, setSending] = useState(false);
  const canAutoSend = signal.recommended_channel !== 'call';

  const handleSend = async () => {
    setSending(true);
    await onSend(signal, message, signal.recommended_channel);
    setSending(false);
  };

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-text-primary">{signal.customer_name || 'Unknown customer'}</p>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY_COLORS[signal.severity]}`}>{SEVERITY_LABELS[signal.severity]}</span>
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium text-text-secondary">{SIGNAL_TYPE_LABELS[signal.signal_type]}</span>
          </div>
          <p className="mt-1 text-xs text-text-secondary">{signal.signal_excerpt}</p>
          <p className="mt-1 text-[11px] text-text-secondary">{formatRelativeTime(signal.detected_at)} {signal.customer_phone ? `· ${signal.customer_phone}` : ''}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_COLORS[signal.status]}`}>{STATUS_LABELS[signal.status]}</span>
      </div>

      {isOpenSignal(signal.status) && (
        <div className="mt-3 border-t border-border/60 pt-3">
          {canAutoSend ? (
            <>
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} className={inputClass} placeholder="Response message…" />
              <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                <button type="button" onClick={() => onIgnore(signal.id)} className="focus-ring flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary">
                  <EyeOff size={12} /> Ignore
                </button>
                <button type="button" onClick={() => onResolve(signal.id, 'lost')} className="focus-ring flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:text-danger">
                  <ThumbsDown size={12} /> Mark lost
                </button>
                <button type="button" onClick={() => onResolve(signal.id, 'recovered')} className="focus-ring flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:text-success-500">
                  <ThumbsUp size={12} /> Mark recovered
                </button>
                <button type="button" onClick={handleSend} disabled={sending || !message.trim()} className="focus-ring flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50">
                  <Send size={12} /> Send via {signal.recommended_channel === 'sms' ? 'text' : 'email'}
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-xs text-text-secondary">
                <AlertTriangle size={12} className="text-warning-500" /> Flagged for a personal phone call — no automated send.
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={() => onIgnore(signal.id)} className="focus-ring flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary">
                  <EyeOff size={12} /> Ignore
                </button>
                <button type="button" onClick={() => onResolve(signal.id, 'lost')} className="focus-ring flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:text-danger">
                  <ThumbsDown size={12} /> Mark lost
                </button>
                <button type="button" onClick={() => onResolve(signal.id, 'recovered')} className="focus-ring flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:brightness-110">
                  <ThumbsUp size={12} /> Called — mark recovered
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {!isOpenSignal(signal.status) && (
        <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-3">
          <p className="text-xs text-text-secondary">
            {signal.executed_at ? `Sent via ${signal.executed_channel} · ${formatRelativeTime(signal.executed_at)}` : 'No response sent'}
          </p>
          <button type="button" onClick={() => onDelete(signal.id)} className="focus-ring flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-danger/10 hover:text-danger" aria-label="Delete signal">
            <Trash2 size={13} />
          </button>
        </div>
      )}
    </motion.div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function ServiceRecoveryPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [signals, setSignals] = useState<ServiceRecoverySignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<FilterKey>('open');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase.from('service_recovery_signals').select('*').order('detected_at', { ascending: false }).limit(300);
    if (error) {
      toast('Failed to load service recovery signals', 'error');
    } else {
      setSignals((data as ServiceRecoverySignal[]) ?? []);
    }
    setLoading(false);
  }, [user, toast]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const filtered = useMemo(() => {
    const base = filter === 'all' ? signals : filter === 'resolved' ? signals.filter((s) => !isOpenSignal(s.status)) : signals.filter((s) => isOpenSignal(s.status));
    return bySeverityThenRecency(base);
  }, [signals, filter]);

  const stats = useMemo(() => {
    const open = signals.filter((s) => isOpenSignal(s.status));
    const critical = open.filter((s) => s.severity === 'critical').length;
    const recovered = signals.filter((s) => s.outcome === 'recovered').length;
    const lost = signals.filter((s) => s.outcome === 'lost').length;
    return { openCount: open.length, critical, recovered, lost };
  }, [signals]);

  const handleManualSave = async (form: ManualFormState) => {
    if (!user) return;
    const { error } = await supabase.from('service_recovery_signals').insert({
      user_id: user.id,
      customer_name: form.customer_name.trim(),
      customer_phone: form.customer_phone.trim() || null,
      customer_email: form.customer_email.trim() || null,
      signal_type: form.signal_type,
      source_table: 'manual',
      source_id: null,
      severity: form.severity,
      signal_excerpt: form.signal_excerpt.trim(),
      recommended_channel: form.recommended_channel,
      recommended_message: form.recommended_message.trim() || null,
    });
    if (error) {
      toast('Could not log this signal', 'error');
      return;
    }
    toast('Signal logged', 'success');
    setAdding(false);
    fetchAll();
  };

  const handleSend = async (signal: ServiceRecoverySignal, message: string, channel: RecommendedChannel) => {
    const { data, error } = await supabase.functions.invoke('send-service-recovery-response', {
      body: { signal_id: signal.id, message, channel },
    });
    if (error || data?.error) {
      toast(data?.error || 'Could not send the response', 'error');
      return;
    }
    toast('Response sent', 'success');
    setSignals((prev) => prev.map((s) => (s.id === signal.id ? { ...s, status: 'action_sent', executed_at: new Date().toISOString(), executed_channel: channel } : s)));
  };

  const handleResolve = async (id: string, outcome: 'recovered' | 'lost') => {
    const { error } = await supabase.from('service_recovery_signals').update({ status: 'resolved', outcome, resolved_at: new Date().toISOString() }).eq('id', id);
    if (error) {
      toast('Could not update this signal', 'error');
      return;
    }
    setSignals((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'resolved' as SignalStatus, outcome, resolved_at: new Date().toISOString() } : s)));
  };

  const handleIgnore = async (id: string) => {
    const { error } = await supabase.from('service_recovery_signals').update({ status: 'ignored' }).eq('id', id);
    if (error) {
      toast('Could not update this signal', 'error');
      return;
    }
    setSignals((prev) => prev.map((s) => (s.id === id ? { ...s, status: 'ignored' as SignalStatus } : s)));
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    const { error } = await supabase.from('service_recovery_signals').delete().eq('id', deletingId);
    if (error) {
      toast('Could not delete this signal', 'error');
    } else {
      setSignals((prev) => prev.filter((s) => s.id !== deletingId));
      toast('Signal deleted', 'success');
    }
    setDeletingId(null);
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-danger/10 text-danger">
            <HeartHandshake size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Service Recovery & Complaint Prevention</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Missed ETAs, overdue promises, negative sentiment, and low private reviews — caught and answered before
              they become a public review or a lost customer.
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
                <p className="text-xl font-bold text-text-primary">{stats.openCount}</p>
                <p className="text-xs text-text-secondary">Open signals</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-danger">{stats.critical}</p>
                <p className="text-xs text-text-secondary">Critical, open</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-success-500">{stats.recovered}</p>
                <p className="text-xs text-text-secondary">Customers recovered</p>
              </div>
              <div className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                <p className="text-xl font-bold text-text-primary">{stats.lost}</p>
                <p className="text-xs text-text-secondary">Customers lost</p>
              </div>
            </div>

            <div className="mb-3 flex items-center justify-between">
              <div className="flex gap-1.5">
                {FILTERS.map((f) => (
                  <button key={f.key} type="button" onClick={() => setFilter(f.key)} className={`focus-ring rounded-full px-3 py-1 text-xs font-medium transition-colors ${filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>
                    {f.label}
                  </button>
                ))}
              </div>
              {!adding && (
                <button type="button" onClick={() => setAdding(true)} className="focus-ring flex items-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent">
                  <Plus size={14} /> Log signal manually
                </button>
              )}
            </div>

            {adding && (
              <div className="mb-4">
                <ManualLogForm onCancel={() => setAdding(false)} onSave={handleManualSave} />
              </div>
            )}

            {filtered.length === 0 && !adding ? (
              <div className="rounded-2xl border border-dashed border-border py-10 text-center">
                <p className="text-sm text-text-secondary">
                  {filter === 'open' ? 'Nothing at risk right now — every open signal has been handled.' : 'Nothing in this view yet.'}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map((signal) => (
                  <SignalCard key={signal.id} signal={signal} onSend={handleSend} onResolve={handleResolve} onIgnore={handleIgnore} onDelete={setDeletingId} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deletingId)}
        title="Delete this signal?"
        description="This removes the record permanently. It won't undo any message that was already sent."
        confirmLabel="Yes, delete this signal"
        onConfirm={handleDelete}
        onCancel={() => setDeletingId(null)}
      />
    </DashboardLayout>
  );
}
