/**
 * Missed-Revenue Recovery Ledger — /dashboard/recovery
 *
 * A worklist, not a report: every row is something that can still be
 * turned into money, ranked so the most urgent one is on top. The
 * underlying rows are created and closed automatically by database
 * triggers (see src/lib/revenueRecovery.ts) — this page's job is purely to
 * show the queue and log what a human did about each entry.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  Ban,
  Check,
  DollarSign,
  Loader2,
  Phone,
  PhoneCall,
  RefreshCw,
  Sparkles,
  TrendingUp,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import {
  backfillLedger,
  computeStats,
  daysSince,
  fetchLedger,
  formatCents,
  isOverdue,
  logFollowUp,
  markRecoveredManually,
  METHOD_LABELS,
  relativeTime,
  SOURCE_TYPE_COLORS,
  SOURCE_TYPE_LABELS,
  VALUE_BASIS_LABELS,
  writeOff,
} from '@/lib/revenueRecovery';
import type { RecoveryMethod, RecoverySourceType, RevenueRecoveryEvent } from '@/lib/revenueRecovery';

type FilterKey = 'active' | 'recovered' | 'written_off' | 'all';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'active', label: 'Needs attention' },
  { key: 'recovered', label: 'Recovered' },
  { key: 'written_off', label: 'Written off' },
  { key: 'all', label: 'All' },
];

const FOLLOW_UP_METHODS: { value: RecoveryMethod; label: string }[] = [
  { value: 'callback', label: 'Called back' },
  { value: 'sms', label: 'Sent a text' },
  { value: 'quote_resent', label: 'Resent the quote' },
  { value: 'other', label: 'Other' },
];

// ============================================================
// RECOVER-MANUALLY MODAL
// ============================================================

function RecoverManuallyModal({
  event,
  onClose,
  onConfirm,
}: {
  event: RevenueRecoveryEvent;
  onClose: () => void;
  onConfirm: (amountCents: number, note: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState(String(event.estimated_value_cents / 100));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const parsed = Math.round(Number(amount) * 100);
  const valid = Number.isFinite(parsed) && parsed >= 0;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-border bg-bg-secondary p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h4 className="text-sm font-semibold text-text-primary">Mark {event.customer_name} recovered</h4>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="focus-ring flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary"
          >
            <X size={14} />
          </button>
        </div>
        <p className="mt-1 text-xs text-text-secondary">
          For work that closed outside the platform — a cash job, a rebooking you handled directly.
        </p>

        <label className="mt-4 block text-xs text-text-secondary">Amount actually collected</label>
        <div className="relative mt-1">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-secondary">$</span>
          <input
            type="number"
            min={0}
            step="0.01"
            autoFocus
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="focus-ring w-full rounded-xl border border-border bg-bg-primary py-2.5 pl-7 pr-4 text-sm text-text-primary"
          />
        </div>

        <label className="mt-3 block text-xs text-text-secondary">Note (optional)</label>
        <textarea
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Rebooked directly for next Tuesday"
          className="focus-ring mt-1 w-full resize-y rounded-xl border border-border bg-bg-primary px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60"
        />

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="focus-ring rounded-xl px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || saving}
            onClick={async () => {
              setSaving(true);
              await onConfirm(parsed, note.trim());
              setSaving(false);
            }}
            className="focus-ring flex items-center gap-1.5 rounded-xl bg-success-500 px-4 py-2 text-sm font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            Mark recovered
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ============================================================
// ROW
// ============================================================

function LedgerRow({
  event,
  busy,
  onFollowUp,
  onWriteOff,
  onOpenRecover,
}: {
  event: RevenueRecoveryEvent;
  busy: boolean;
  onFollowUp: (method: RecoveryMethod) => void;
  onWriteOff: () => void;
  onOpenRecover: () => void;
}) {
  const overdue = isOverdue(event);
  const days = daysSince(event.occurred_at);
  const isActive = event.status === 'open' || event.status === 'contacted';

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-2xl border p-4 ${
        overdue ? 'border-danger/30 bg-danger/[0.03]' : 'border-border bg-bg-secondary'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-text-primary">{event.customer_name}</p>
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${SOURCE_TYPE_COLORS[event.source_type]}`}>
              {SOURCE_TYPE_LABELS[event.source_type]}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-text-secondary">
            {event.customer_phone ? `${event.customer_phone} · ` : ''}
            {days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days ?? '?'} days ago`}
            {event.follow_up_count > 0 && ` · followed up ${event.follow_up_count}×`}
          </p>
        </div>

        <div className="text-right">
          <p className="text-lg font-bold text-text-primary">
            {event.estimated_value_basis === 'none' ? '—' : formatCents(event.estimated_value_cents)}
          </p>
          <p className="text-[10px] text-text-secondary/70">{VALUE_BASIS_LABELS[event.estimated_value_basis]}</p>
        </div>
      </div>

      {event.status === 'recovered' && (
        <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-success-500">
          <Check size={12} />
          Recovered {formatCents(event.recovered_amount_cents ?? 0)}
          {event.recovery_method && ` · ${METHOD_LABELS[event.recovery_method]}`}
        </p>
      )}
      {event.status === 'written_off' && (
        <p className="mt-2 text-xs text-text-secondary">Written off {relativeTime(event.resolved_at)}</p>
      )}
      {overdue && isActive && (
        <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-danger">
          <AlertTriangle size={12} /> Needs a follow-up
        </p>
      )}
      {event.notes && <p className="mt-2 whitespace-pre-line text-xs text-text-secondary">{event.notes}</p>}

      {isActive && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-3">
          {FOLLOW_UP_METHODS.map((m) => (
            <button
              key={m.value}
              type="button"
              disabled={busy}
              onClick={() => onFollowUp(m.value)}
              className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-40"
            >
              <Phone size={11} /> {m.label}
            </button>
          ))}
          <button
            type="button"
            disabled={busy}
            onClick={onOpenRecover}
            className="focus-ring flex items-center gap-1 rounded-lg bg-success-500/10 px-2.5 py-1.5 text-xs font-medium text-success-500 transition-colors hover:bg-success-500/15 disabled:opacity-40"
          >
            <DollarSign size={11} /> Mark recovered
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onWriteOff}
            className="focus-ring ml-auto flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary disabled:opacity-40"
          >
            <Ban size={11} /> Write off
          </button>
        </div>
      )}
    </motion.div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function RevenueRecoveryLedgerPage() {
  const { user } = useAuth();
  const { toast } = useToast();

  const [events, setEvents] = useState<RevenueRecoveryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>('active');
  const [sourceFilter, setSourceFilter] = useState<RecoverySourceType | 'all'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [recoverTarget, setRecoverTarget] = useState<RevenueRecoveryEvent | null>(null);
  const [backfilling, setBackfilling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await fetchLedger({ status: 'all' }));
    } catch {
      toast('Could not load the recovery ledger', 'error');
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => computeStats(events), [events]);

  const filtered = useMemo(() => {
    let rows = events;
    if (filter === 'active') rows = rows.filter((e) => e.status === 'open' || e.status === 'contacted');
    else if (filter !== 'all') rows = rows.filter((e) => e.status === filter);
    if (sourceFilter !== 'all') rows = rows.filter((e) => e.source_type === sourceFilter);

    // Overdue and highest-value first — the queue should hand you the most
    // urgent, most valuable thing to work next, not just the newest.
    return [...rows].sort((a, b) => {
      const aOverdue = isOverdue(a);
      const bOverdue = isOverdue(b);
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
      return b.estimated_value_cents - a.estimated_value_cents;
    });
  }, [events, filter, sourceFilter]);

  const handleFollowUp = async (event: RevenueRecoveryEvent, method: RecoveryMethod) => {
    setBusyId(event.id);
    const ok = await logFollowUp(event.id, method);
    if (ok) {
      toast('Follow-up logged', 'success');
      await load();
    } else {
      toast('Could not log the follow-up', 'error');
    }
    setBusyId(null);
  };

  const handleWriteOff = async (event: RevenueRecoveryEvent) => {
    setBusyId(event.id);
    const ok = await writeOff(event.id);
    if (ok) {
      toast('Written off', 'success');
      await load();
    } else {
      toast('Could not write this off', 'error');
    }
    setBusyId(null);
  };

  const handleConfirmRecover = async (amountCents: number, note: string) => {
    if (!recoverTarget) return;
    const ok = await markRecoveredManually(recoverTarget.id, amountCents, 'manual', note || undefined);
    if (ok) {
      toast('Marked recovered', 'success');
      setRecoverTarget(null);
      await load();
    } else {
      toast('Could not save this', 'error');
    }
  };

  const handleBackfill = async () => {
    if (!user) return;
    setBackfilling(true);
    try {
      const count = await backfillLedger(user.id);
      toast(count > 0 ? `Added ${count} historical entr${count === 1 ? 'y' : 'ies'}` : 'Nothing new to add', count > 0 ? 'success' : 'info');
      if (count > 0) await load();
    } catch {
      toast('Could not run the historical sweep', 'error');
    }
    setBackfilling(false);
  };

  return (
    <DashboardLayout activeLabel="Recovery Ledger">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Missed-Revenue Recovery Ledger</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-secondary">
              Every missed call, declined quote, and cancelled job that could still become a job — logged
              automatically, closed automatically the moment it's actually paid.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleBackfill()}
            disabled={backfilling}
            className="focus-ring flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
          >
            <RefreshCw size={13} className={backfilling ? 'animate-spin' : ''} /> Scan history
          </button>
        </div>

        {/* Stats */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className={`rounded-2xl border p-4 ${stats.overdueCount > 0 ? 'border-danger/30 bg-danger/[0.04]' : 'border-border bg-bg-secondary'}`}>
            <p className={`text-2xl font-bold ${stats.overdueCount > 0 ? 'text-danger' : 'text-text-primary'}`}>
              {formatCents(stats.openValueCents)}
            </p>
            <p className="text-xs text-text-secondary">Sitting at risk</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-4">
            <p className="text-2xl font-bold text-text-primary">{stats.openCount}</p>
            <p className="text-xs text-text-secondary">Open entries</p>
          </div>
          <div className="rounded-2xl border border-success-500/25 bg-success-500/[0.05] p-4">
            <p className="text-2xl font-bold text-success-500">{formatCents(stats.recoveredThisMonthCents)}</p>
            <p className="text-xs text-text-secondary">Recovered this month</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-4">
            <p className="text-2xl font-bold text-text-primary">
              {stats.recoveryRatePercent === null ? '—' : `${stats.recoveryRatePercent}%`}
            </p>
            <p className="text-xs text-text-secondary">Recovery rate</p>
          </div>
        </div>

        {stats.overdueCount > 0 && (
          <div className="mb-4 flex items-center gap-2 rounded-2xl border border-danger/25 bg-danger/[0.04] px-4 py-3">
            <AlertTriangle size={15} className="shrink-0 text-danger" />
            <p className="text-xs text-text-secondary">
              <span className="font-semibold text-danger">{stats.overdueCount}</span> entr
              {stats.overdueCount === 1 ? 'y needs' : 'ies need'} a follow-up right now.
            </p>
          </div>
        )}

        {/* Filters */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  filter === f.key ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as RecoverySourceType | 'all')}
            className="focus-ring ml-auto rounded-xl border border-border bg-bg-primary px-3 py-1.5 text-xs text-text-secondary"
          >
            <option value="all">All types</option>
            {(Object.keys(SOURCE_TYPE_LABELS) as RecoverySourceType[]).map((t) => (
              <option key={t} value={t}>
                {SOURCE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>

        {/* List */}
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-2xl bg-bg-tertiary" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-10 text-center">
            {filter === 'active' ? (
              <>
                <Sparkles className="mx-auto mb-2 h-6 w-6 text-success-500/70" />
                <p className="text-sm text-text-secondary">Nothing outstanding — every miss has been worked.</p>
              </>
            ) : (
              <>
                <PhoneCall className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
                <p className="text-sm text-text-secondary">Nothing here yet.</p>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((event) => (
              <LedgerRow
                key={event.id}
                event={event}
                busy={busyId === event.id}
                onFollowUp={(method) => void handleFollowUp(event, method)}
                onWriteOff={() => void handleWriteOff(event)}
                onOpenRecover={() => setRecoverTarget(event)}
              />
            ))}
          </div>
        )}

        <p className="mt-6 flex items-center gap-1.5 text-xs text-text-secondary/70">
          <TrendingUp size={12} />
          Entries appear automatically from missed calls, declined or expired quotes, and cancelled jobs, and
          close automatically the moment a linked job is paid. Statuses below only track your follow-up.
        </p>
      </div>

      {recoverTarget && (
        <RecoverManuallyModal
          event={recoverTarget}
          onClose={() => setRecoverTarget(null)}
          onConfirm={handleConfirmRecover}
        />
      )}
    </DashboardLayout>
  );
}
