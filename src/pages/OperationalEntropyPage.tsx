/**
 * Operational Entropy Detector — /dashboard/entropy
 *
 * Define what "on standard" looks like per metric (branch, technician,
 * or process), log actual readings against it, and see the excess
 * drift beyond tolerance priced in dollars. See
 * src/lib/operationalEntropy.ts for the standards/readings model and
 * the deviation math (only the excess beyond declared tolerance ever
 * counts as "entropy" — normal noise is free).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Activity, ChevronDown, Loader2, Plus, Trash2, TrendingUp, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  createStandard,
  deleteStandard,
  EntityEntropyRow,
  EntityType,
  ENTITY_TYPE_LABELS,
  EntropyStandard,
  EntropyReading,
  fetchReadings,
  fetchStandards,
  formatDollars,
  latestReadingPerEntity,
  logReading,
  summarizeEntropy,
  toggleStandardActive,
} from '@/lib/operationalEntropy';

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/60';

// ============================================================
// NEW STANDARD FORM
// ============================================================

function NewStandardForm({ userId, onSaved }: { userId: string; onSaved: () => void }) {
  const { toast } = useToast();
  const [entityType, setEntityType] = useState<EntityType>('branch');
  const [metricName, setMetricName] = useState('');
  const [unit, setUnit] = useState('count');
  const [targetValue, setTargetValue] = useState('');
  const [tolerancePct, setTolerancePct] = useState('10');
  const [dollarImpact, setDollarImpact] = useState('');
  const [higherIsWorse, setHigherIsWorse] = useState(true);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!metricName.trim()) return toast('Name the metric (e.g. "Avg response time")', 'error');
    if (targetValue.trim() === '') return toast('Set the target value the org standard expects', 'error');
    setSaving(true);
    try {
      await createStandard(
        {
          entity_type: entityType,
          metric_name: metricName,
          unit,
          target_value: Number(targetValue) || 0,
          tolerance_pct: Number(tolerancePct) || 0,
          dollar_impact_per_unit: Number(dollarImpact) || 0,
          higher_is_worse: higherIsWorse,
          notes,
        },
        userId
      );
      toast('Standard created', 'success');
      setMetricName('');
      setUnit('count');
      setTargetValue('');
      setTolerancePct('10');
      setDollarImpact('');
      setNotes('');
      onSaved();
    } catch {
      toast('Could not save this standard', 'error');
    }
    setSaving(false);
  };

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Applies to</label>
          <select className={inputClass} value={entityType} onChange={(e) => setEntityType(e.target.value as EntityType)}>
            {(Object.keys(ENTITY_TYPE_LABELS) as EntityType[]).map((t) => (
              <option key={t} value={t}>{ENTITY_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </div>
        <div className="col-span-2 sm:col-span-2">
          <label className="mb-1 block text-xs text-text-secondary">Metric name</label>
          <input className={inputClass} placeholder='e.g. "Avg response time", "Callback rate"' value={metricName} onChange={(e) => setMetricName(e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Target value</label>
          <input className={inputClass} type="number" step="any" placeholder="e.g. 45" value={targetValue} onChange={(e) => setTargetValue(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Unit</label>
          <input className={inputClass} placeholder="min, %, count..." value={unit} onChange={(e) => setUnit(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Tolerance (%)</label>
          <input className={inputClass} type="number" min="0" step="1" value={tolerancePct} onChange={(e) => setTolerancePct(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">$ per unit of drift</label>
          <input className={inputClass} type="number" min="0" step="1" placeholder="0" value={dollarImpact} onChange={(e) => setDollarImpact(e.target.value)} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-text-secondary">Bad direction:</span>
        <button
          type="button"
          onClick={() => setHigherIsWorse(true)}
          className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${higherIsWorse ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary'}`}
        >
          Higher is worse
        </button>
        <button
          type="button"
          onClick={() => setHigherIsWorse(false)}
          className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${!higherIsWorse ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary'}`}
        >
          Lower is worse
        </button>
      </div>

      <textarea className={inputClass} rows={2} placeholder="Notes (optional) — what the standard actually is, where it came from" value={notes} onChange={(e) => setNotes(e.target.value)} />

      <button
        type="button"
        disabled={saving}
        onClick={() => void handleSave()}
        className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-60"
      >
        {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Create standard
      </button>
    </div>
  );
}

// ============================================================
// LOG READING FORM
// ============================================================

function LogReadingForm({ standards, userId, onSaved, onClose }: { standards: EntropyStandard[]; userId: string; onSaved: () => void; onClose: () => void }) {
  const { toast } = useToast();
  const [standardId, setStandardId] = useState(standards[0]?.id ?? '');
  const [entityLabel, setEntityLabel] = useState('');
  const [observedValue, setObservedValue] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!standardId) return toast('Create a standard first', 'error');
    if (!entityLabel.trim()) return toast('Name the branch, technician, or process being measured', 'error');
    if (observedValue.trim() === '') return toast('Enter the observed value', 'error');
    setSaving(true);
    try {
      await logReading({ standard_id: standardId, entity_label: entityLabel, observed_value: Number(observedValue), note }, userId);
      toast('Reading logged', 'success');
      setEntityLabel('');
      setObservedValue('');
      setNote('');
      onSaved();
    } catch {
      toast('Could not log this reading', 'error');
    }
    setSaving(false);
  };

  return (
    <div className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Standard</label>
          <select className={inputClass} value={standardId} onChange={(e) => setStandardId(e.target.value)}>
            {standards.map((s) => (
              <option key={s.id} value={s.id}>{s.metric_name} ({ENTITY_TYPE_LABELS[s.entity_type]})</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Which one</label>
          <input className={inputClass} placeholder='"Downtown", "Mike R."...' value={entityLabel} onChange={(e) => setEntityLabel(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Observed value</label>
          <input className={inputClass} type="number" step="any" value={observedValue} onChange={(e) => setObservedValue(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-secondary">Note (optional)</label>
          <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <div className="flex gap-1.5">
        <button type="button" disabled={saving} onClick={() => void handleSave()} className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white disabled:opacity-60">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Log reading
        </button>
        <button type="button" onClick={onClose} className="focus-ring rounded-xl bg-bg-tertiary px-3 py-2 text-xs font-medium text-text-secondary">Cancel</button>
      </div>
    </div>
  );
}

// ============================================================
// DRIFT ROW
// ============================================================

function DriftRow({ row }: { row: EntityEntropyRow }) {
  const [expanded, setExpanded] = useState(false);
  const d = row.deviation;
  return (
    <div className={`rounded-2xl border p-3 ${d.inDrift ? 'border-danger/40 bg-danger/5' : 'border-border bg-bg-secondary'}`}>
      <button type="button" onClick={() => setExpanded((v) => !v)} className="focus-ring flex w-full items-start justify-between gap-3 text-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-text-primary">{row.entityLabel}</span>
            <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
              {ENTITY_TYPE_LABELS[row.standard.entity_type]}
            </span>
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            {row.standard.metric_name}: {row.latestReading.observed_value}{row.standard.unit !== 'count' ? row.standard.unit : ''} vs target {row.standard.target_value}{row.standard.unit !== 'count' ? row.standard.unit : ''}
          </p>
        </div>
        <div className="shrink-0 text-end">
          <p className={`text-sm font-semibold ${d.inDrift ? 'text-danger' : 'text-success-500'}`}>{formatDollars(d.financialImpact)}</p>
          <p className="text-[10px] text-text-secondary">entropy {d.entropyScore.toFixed(0)}</p>
          <ChevronDown size={14} className={`ms-auto mt-1 text-text-secondary transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>
      {expanded && (
        <div className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-text-secondary">
          <p>Tolerance: {row.standard.tolerance_pct}% · Excess beyond tolerance: {d.excessUnits.toFixed(2)} {row.standard.unit}</p>
          <p>Last observed {new Date(row.latestReading.observed_at).toLocaleString()}</p>
          {row.latestReading.note && <p className="italic">"{row.latestReading.note}"</p>}
        </div>
      )}
    </div>
  );
}

// ============================================================
// STANDARD ROW
// ============================================================

function StandardRow({ standard, onChanged }: { standard: EntropyStandard; onChanged: () => void }) {
  const [pendingDelete, setPendingDelete] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-text-primary">{standard.metric_name}</span>
          <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
            {ENTITY_TYPE_LABELS[standard.entity_type]}
          </span>
          {!standard.active && <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-secondary">Inactive</span>}
        </div>
        <p className="mt-1 text-xs text-text-secondary">
          Target {standard.target_value}{standard.unit !== 'count' ? standard.unit : ''} ±{standard.tolerance_pct}% · ${standard.dollar_impact_per_unit}/unit of drift
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => void toggleStandardActive(standard.id, !standard.active).then(onChanged)}
          className="focus-ring rounded-full bg-bg-tertiary px-2.5 py-1 text-[11px] font-medium text-text-primary"
        >
          {standard.active ? 'Pause' : 'Activate'}
        </button>
        <button type="button" onClick={() => setPendingDelete(true)} className="focus-ring text-text-secondary hover:text-danger">
          <Trash2 size={14} />
        </button>
      </div>
      <ConfirmDialog
        open={pendingDelete}
        title="Delete this standard?"
        description={`"${standard.metric_name}" and all its logged readings will be removed.`}
        confirmLabel="Yes, delete it"
        onConfirm={() => void deleteStandard(standard.id).then(() => { setPendingDelete(false); onChanged(); })}
        onCancel={() => setPendingDelete(false)}
      />
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function OperationalEntropyPage() {
  const { user } = useAuth();
  const [standards, setStandards] = useState<EntropyStandard[]>([]);
  const [readings, setReadings] = useState<EntropyReading[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'feed' | 'standards'>('feed');
  const [showNewStandard, setShowNewStandard] = useState(false);
  const [showLogReading, setShowLogReading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, r] = await Promise.all([fetchStandards(), fetchReadings()]);
      setStandards(s);
      setReadings(r);
    } catch {
      /* empty state covers it */
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => latestReadingPerEntity(standards, readings), [standards, readings]);
  const summary = useMemo(() => summarizeEntropy(rows), [rows]);
  const activeStandards = useMemo(() => standards.filter((s) => s.active), [standards]);
  const sortedRows = useMemo(() => [...rows].sort((a, b) => b.deviation.financialImpact - a.deviation.financialImpact), [rows]);

  return (
    <DashboardLayout activeLabel="Operational Entropy">
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Activity size={18} /> Operational Entropy Detector
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              Define what "on standard" looks like, log what's actually happening at each branch, employee, or process, and see the drift priced in dollars.
            </p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={() => { setShowLogReading((v) => !v); setShowNewStandard(false); }}
              disabled={activeStandards.length === 0}
              className="focus-ring flex items-center gap-1.5 rounded-xl bg-bg-tertiary px-3 py-2 text-xs font-medium text-text-primary disabled:opacity-40"
            >
              <TrendingUp size={13} /> Log reading
            </button>
            <button
              type="button"
              onClick={() => { setShowNewStandard((v) => !v); setShowLogReading(false); }}
              className="focus-ring flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-medium text-white"
            >
              {showNewStandard ? <X size={13} /> : <Plus size={13} />} {showNewStandard ? 'Close' : 'New standard'}
            </button>
          </div>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">Financial impact</p>
            <p className="text-lg font-semibold text-danger">{formatDollars(summary.totalFinancialImpact)}</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">Avg entropy score</p>
            <p className="text-lg font-semibold text-text-primary">{summary.averageEntropyScore.toFixed(0)}</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">In drift</p>
            <p className={`text-lg font-semibold ${summary.entitiesInDrift ? 'text-danger' : 'text-text-primary'}`}>{summary.entitiesInDrift}</p>
          </div>
          <div className="rounded-2xl border border-border bg-bg-secondary p-3">
            <p className="text-[11px] text-text-secondary">Tracked</p>
            <p className="text-lg font-semibold text-text-primary">{summary.entitiesTracked}</p>
          </div>
        </div>

        {showNewStandard && user && (
          <div className="mb-5"><NewStandardForm userId={user.id} onSaved={() => { setShowNewStandard(false); void load(); }} /></div>
        )}
        {showLogReading && user && activeStandards.length > 0 && (
          <div className="mb-5">
            <LogReadingForm standards={activeStandards} userId={user.id} onSaved={() => { setShowLogReading(false); void load(); }} onClose={() => setShowLogReading(false)} />
          </div>
        )}

        <div className="mb-3 flex gap-1.5">
          <button type="button" onClick={() => setTab('feed')} className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${tab === 'feed' ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>
            Drift feed
          </button>
          <button type="button" onClick={() => setTab('standards')} className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium ${tab === 'standards' ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>
            Standards ({standards.length})
          </button>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => <div key={i} className="h-20 animate-pulse rounded-2xl bg-bg-tertiary" />)}
          </div>
        ) : tab === 'feed' ? (
          standards.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border py-10 text-center">
              <Activity className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
              <p className="mx-auto max-w-sm text-sm text-text-secondary">Start by defining a standard — the metric, its target, and its tolerance — then log readings against it.</p>
            </div>
          ) : sortedRows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border py-10 text-center">
              <TrendingUp className="mx-auto mb-2 h-6 w-6 text-text-secondary/50" />
              <p className="mx-auto max-w-sm text-sm text-text-secondary">No readings logged yet. Log one against a branch, technician, or process to see where it stands.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {sortedRows.map((row) => (
                <motion.div key={`${row.standard.id}::${row.entityLabel}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                  <DriftRow row={row} />
                </motion.div>
              ))}
            </div>
          )
        ) : standards.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border py-10 text-center">
            <p className="mx-auto max-w-sm text-sm text-text-secondary">No standards defined yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {standards.map((s) => <StandardRow key={s.id} standard={s} onChanged={() => void load()} />)}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
