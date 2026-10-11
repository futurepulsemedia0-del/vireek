import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  Camera,
  Check,
  ChevronLeft,
  ClipboardCheck,
  Download,
  EyeOff,
  Lock,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  ScanLine,
  Search,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton, SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { exportToCsv } from '@/lib/csvExport';
import { detectCapabilities, scanCode } from '@/lib/native/capabilities';
import { isNative } from '@/lib/native/platform';
import {
  COUNT_EVENT_LABELS,
  COUNT_SCOPE_LABELS,
  COUNT_STATUS_LABELS,
  COUNT_TYPE_LABELS,
  approveInventoryCount,
  buildVarianceCsvColumns,
  cancelInventoryCount,
  classifyLine,
  countErrorMessage,
  countInventoryPart,
  countStatusTone,
  filterLines,
  formatPct,
  formatSigned,
  formatSignedCents,
  getInventoryCount,
  getInventoryCountEvents,
  getInventoryCountLines,
  getInventoryCountOptions,
  isNoMatchError,
  lineVarianceQty,
  listInventoryCounts,
  normalizeScanCode,
  parseQuantityInput,
  returnInventoryCountForRecount,
  setInventoryCountLine,
  setInventoryCountLineNote,
  shouldIgnoreRescan,
  sortByVarianceImpact,
  startInventoryCount,
  submitInventoryCount,
  summarizeLines,
  variancePct,
  type CountOptions,
  type CountScope,
  type CountStatus,
  type CountSummary,
  type CountType,
  type InventoryCount,
  type InventoryCountEvent,
  type InventoryCountLine,
  type LineFilterMode,
  type StatusTone,
} from '@/lib/inventoryCounts';

// ============================================================
// SHARED BITS
// ============================================================

type ToastFn = (message: string, type?: 'success' | 'error' | 'info') => void;

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';
const panelClass = 'rounded-2xl border border-border bg-bg-secondary p-4';
const labelClass = 'mb-1.5 block text-sm font-medium text-text-primary';
const iconBtnClass =
  'focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-tertiary text-text-primary transition-colors hover:border-accent/40 active:scale-95 disabled:pointer-events-none disabled:opacity-40';

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary',
  good: 'bg-success/10 text-success',
  warn: 'bg-warning/10 text-warning',
  bad: 'bg-danger/10 text-danger',
};

function StatusPill({ text, tone = 'neutral' }: { text: string; tone?: StatusTone }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASSES[tone]}`}>
      {text}
    </span>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string | number; tone?: StatusTone }) {
  const color = tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warning' : tone === 'good' ? 'text-success' : 'text-text-primary';
  return (
    <div className={panelClass}>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
      <p className="mt-0.5 text-xs text-text-secondary">{label}</p>
    </div>
  );
}

function ProgressBar({ pct, label }: { pct: number; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-2 w-full overflow-hidden rounded-full bg-bg-tertiary"
    >
      <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`focus-ring rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  );
}

function formatWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

// ============================================================
// PAGE
// ============================================================

export function InventoryCountsPage() {
  const { user, profile, teamMember, isOwner, permissions, profileLoading } = useAuth();
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const countId = params.get('count');

  // Counts belong to the ACCOUNT OWNER; team members read/write the owner's counts.
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  // Permission gate: approving / returning / cancelling others' counts needs team-management rights,
  // and dollar values need billing visibility. The server enforces both — this only shapes the UI.
  const canManage = isOwner || permissions.can_manage_team;
  const canViewCosts = isOwner || permissions.can_view_billing;

  const openCount = useCallback((id: string) => setParams({ count: id }), [setParams]);
  const closeCount = useCallback(() => setParams({}), [setParams]);

  let body: React.ReactNode;
  if (profileLoading || (!accountOwnerId && !profile)) {
    body = (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <SkeletonStatGrid count={4} />
        <SkeletonCardList count={3} />
      </div>
    );
  } else if (!accountOwnerId) {
    body = (
      <EmptyState
        icon={Lock}
        title="We couldn't find your account"
        description="Your user isn't linked to a business account yet. Ask the account owner to re-send your invite."
      />
    );
  } else if (countId) {
    body = (
      <CountDetail
        key={countId}
        accountOwnerId={accountOwnerId}
        countId={countId}
        userId={user?.id ?? null}
        canManage={canManage}
        canViewCosts={canViewCosts}
        toast={toast}
        onBack={closeCount}
      />
    );
  } else {
    body = (
      <CountList
        accountOwnerId={accountOwnerId}
        canManage={canManage}
        canViewCosts={canViewCosts}
        toast={toast}
        onOpen={openCount}
      />
    );
  }

  return (
    <DashboardLayout activeLabel="Cycle Counts">
      <div className="mx-auto max-w-6xl px-0 py-2 sm:px-2">{body}</div>
    </DashboardLayout>
  );
}

// ============================================================
// LIST
// ============================================================

function CountList({
  accountOwnerId,
  canManage,
  canViewCosts,
  toast,
  onOpen,
}: {
  accountOwnerId: string;
  canManage: boolean;
  canViewCosts: boolean;
  toast: ToastFn;
  onOpen: (id: string) => void;
}) {
  const [counts, setCounts] = useState<InventoryCount[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [filter, setFilter] = useState<'all' | CountStatus>('all');
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      setCounts(await listInventoryCounts(accountOwnerId));
      setPhase('ready');
    } catch {
      setPhase('error');
    }
  }, [accountOwnerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const approved = counts.filter((c) => c.status === 'approved');
    const accuracies = approved.map((c) => c.accuracy_pct).filter((n): n is number => n !== null);
    return {
      open: counts.filter((c) => c.status === 'in_progress').length,
      pending: counts.filter((c) => c.status === 'pending_approval').length,
      approved: approved.length,
      avgAccuracy: accuracies.length ? Math.round((accuracies.reduce((a, b) => a + b, 0) / accuracies.length) * 10) / 10 : null,
    };
  }, [counts]);

  const visible = filter === 'all' ? counts : counts.filter((c) => c.status === filter);

  const filters: { key: 'all' | CountStatus; label: string }[] = [
    { key: 'all', label: `All (${counts.length})` },
    { key: 'in_progress', label: `Counting (${stats.open})` },
    { key: 'pending_approval', label: `Awaiting approval (${stats.pending})` },
    { key: 'approved', label: `Approved (${stats.approved})` },
    { key: 'cancelled', label: 'Cancelled' },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <ClipboardCheck size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Cycle Counts</h1>
            <p className="mt-1 text-sm text-text-secondary">
              Count what's really on the shelf, review the variance, and post approved adjustments to the stock ledger.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/dashboard/inventory"
            className="focus-ring rounded-xl px-3 py-2 text-sm font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          >
            Parts &amp; Inventory
          </Link>
          {!starting && (
            <Button size="sm" onClick={() => setStarting(true)}>
              <Plus size={16} /> Start a count
            </Button>
          )}
        </div>
      </header>

      {starting && (
        <StartCountForm
          toast={toast}
          onCancel={() => setStarting(false)}
          onStarted={(id) => {
            setStarting(false);
            onOpen(id);
          }}
        />
      )}

      {phase === 'loading' && (
        <>
          <SkeletonStatGrid count={4} />
          <SkeletonCardList count={3} />
        </>
      )}

      {phase === 'error' && (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load your counts"
          description="Check your connection and try again."
          action={{ label: 'Retry', onClick: () => void load() }}
        />
      )}

      {phase === 'ready' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Counting now" value={stats.open} />
            <StatCard label="Awaiting approval" value={stats.pending} tone={stats.pending && canManage ? 'warn' : undefined} />
            <StatCard label="Approved counts" value={stats.approved} />
            <StatCard label="Average accuracy" value={formatPct(stats.avgAccuracy)} tone={stats.avgAccuracy !== null && stats.avgAccuracy < 90 ? 'bad' : 'good'} />
          </div>

          {canManage && stats.pending > 0 && filter !== 'pending_approval' && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4">
              <p className="text-sm font-medium text-text-primary">
                {stats.pending} count{stats.pending === 1 ? ' is' : 's are'} waiting for your approval.
              </p>
              <Button size="sm" variant="secondary" onClick={() => setFilter('pending_approval')}>
                Review now
              </Button>
            </div>
          )}

          {counts.length === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              title="No counts yet"
              description="Start a cycle count for a van or warehouse. Scan parts, review variances, then approve to correct your stock."
              action={{ label: 'Start your first count', onClick: () => setStarting(true) }}
            />
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter counts by status">
                {filters.map((f) => (
                  <Chip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
                    {f.label}
                  </Chip>
                ))}
              </div>

              {visible.length === 0 ? (
                <EmptyState icon={ClipboardCheck} title="Nothing in this view" description="Try a different status filter." />
              ) : (
                <ul className="space-y-3">
                  {visible.map((c) => (
                    <motion.li key={c.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                      <CountCard count={c} canViewCosts={canViewCosts} onOpen={() => onOpen(c.id)} />
                    </motion.li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function CountCard({ count, canViewCosts, onOpen }: { count: InventoryCount; canViewCosts: boolean; onOpen: () => void }) {
  const pct = count.line_count === 0 ? 0 : Math.round((count.counted_count / count.line_count) * 100);
  const hasVariance = count.status !== 'in_progress' && count.variance_line_count !== null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="focus-ring w-full rounded-2xl border border-border bg-bg-secondary p-4 text-left transition-colors hover:border-accent/40"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">{count.name}</p>
          <p className="mt-0.5 text-xs text-text-secondary">
            {count.count_number} · {count.location_name} · {COUNT_TYPE_LABELS[count.count_type]}
            {count.scope_detail ? ` · ${count.scope_detail}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {count.blind && <StatusPill text="Blind" />}
          <StatusPill text={COUNT_STATUS_LABELS[count.status]} tone={countStatusTone(count.status)} />
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        <ProgressBar pct={pct} label={`${count.name} progress`} />
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary">
          <span>
            {count.counted_count}/{count.line_count} counted
          </span>
          {hasVariance && (
            <span>
              {count.variance_line_count} variance{count.variance_line_count === 1 ? '' : 's'}
              {count.net_variance_units !== null && ` · net ${formatSigned(count.net_variance_units)} units`}
              {canViewCosts && count.net_variance_value_cents !== null && ` · ${formatSignedCents(count.net_variance_value_cents)}`}
              {count.accuracy_pct !== null && ` · ${count.accuracy_pct}% accurate`}
            </span>
          )}
          {!hasVariance && <span>Started {new Date(count.created_at).toLocaleDateString()}</span>}
        </div>
      </div>
    </button>
  );
}

// ============================================================
// START A COUNT
// ============================================================

function StartCountForm({
  toast,
  onCancel,
  onStarted,
}: {
  toast: ToastFn;
  onCancel: () => void;
  onStarted: (countId: string) => void;
}) {
  const [options, setOptions] = useState<CountOptions | null>(null);
  const [optionsError, setOptionsError] = useState(false);
  const [locationId, setLocationId] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [countType, setCountType] = useState<CountType>('cycle');
  const [scope, setScope] = useState<CountScope>('all');
  const [category, setCategory] = useState('');
  const [topN, setTopN] = useState('20');
  const [partQuery, setPartQuery] = useState('');
  const [partIds, setPartIds] = useState<Set<string>>(new Set());
  const [blind, setBlind] = useState(false);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  const loadOptions = useCallback(async () => {
    setOptionsError(false);
    try {
      setOptions(await getInventoryCountOptions());
    } catch {
      setOptionsError(true);
    }
  }, []);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  // Suggest a sensible name until the user types their own.
  useEffect(() => {
    if (nameTouched || !options) return;
    const loc = options.locations.find((l) => l.id === locationId);
    if (!loc) return;
    const kind = countType === 'full' ? 'stocktake' : 'cycle count';
    setName(`${loc.name} ${kind} — ${new Date().toLocaleDateString()}`);
  }, [options, locationId, countType, nameTouched]);

  const effectiveScope: CountScope = countType === 'full' ? 'all' : scope;

  const filteredParts = useMemo(() => {
    if (!options) return [];
    const q = partQuery.trim().toLowerCase();
    const list = q
      ? options.parts.filter((p) => `${p.name} ${p.part_number ?? ''}`.toLowerCase().includes(q))
      : options.parts;
    return list.slice(0, 40);
  }, [options, partQuery]);

  const togglePart = (id: string) =>
    setPartIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!locationId) e.location = 'Choose where you are counting.';
    if (!name.trim()) e.name = 'Give this count a name.';
    if (effectiveScope === 'category' && !category) e.category = 'Choose a category.';
    if (effectiveScope === 'selected' && partIds.size === 0) e.parts = 'Select at least one part.';
    if (effectiveScope === 'selected' && partIds.size > 500) e.parts = 'Select 500 parts or fewer.';
    if (effectiveScope === 'top_value') {
      const n = Number(topN);
      if (!Number.isInteger(n) || n < 1 || n > 200) e.topN = 'Enter a whole number from 1 to 200.';
    }
    return e;
  };

  const handleSubmit = async () => {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setSubmitting(true);
    try {
      const result = await startInventoryCount({
        locationId,
        name: name.trim(),
        countType,
        scope: effectiveScope,
        category: effectiveScope === 'category' ? category : null,
        partIds: effectiveScope === 'selected' ? Array.from(partIds) : null,
        topN: effectiveScope === 'top_value' ? Number(topN) : null,
        blind,
        notes: notes.trim() || null,
      });
      toast(`Count started — ${result.line_count} part${result.line_count === 1 ? '' : 's'} to count`, 'success');
      if (result.skipped_locked > 0) {
        toast(`${result.skipped_locked} part${result.skipped_locked === 1 ? ' was' : 's were'} skipped — already in another open count here.`, 'info');
      }
      onStarted(result.count_id);
    } catch (err) {
      toast(countErrorMessage(err, 'Could not start the count.'), 'error');
      setSubmitting(false);
    }
  };

  if (optionsError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load your locations"
        description="We need your locations and parts to set up a count."
        action={{ label: 'Retry', onClick: () => void loadOptions() }}
        secondaryAction={{ label: 'Cancel', onClick: onCancel }}
      />
    );
  }

  if (!options) {
    return (
      <div className={panelClass}>
        <Skeleton className="mb-3 h-5 w-40" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (options.locations.length === 0) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="Add a location first"
        description="Counts run against a warehouse or van. Create one under Parts & Inventory → Locations & Bins."
        action={{ label: 'Open Parts & Inventory', onClick: () => navigate('/dashboard/inventory') }}
        secondaryAction={{ label: 'Cancel', onClick: onCancel }}
      />
    );
  }

  return (
    <section className="rounded-2xl border border-accent/30 bg-bg-secondary p-4 sm:p-5" aria-label="Start a count">
      <h2 className="mb-4 text-base font-semibold text-text-primary">Start a count</h2>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="count-location" className={labelClass}>
            Location<span className="ml-0.5 text-danger">*</span>
          </label>
          <select
            id="count-location"
            className={selectClass}
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            aria-invalid={!!errors.location}
          >
            <option value="">Choose a warehouse or van…</option>
            {options.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {errors.location && <p role="alert" className="mt-1.5 text-xs text-danger">{errors.location}</p>}
        </div>

        <Input
          label="Count name"
          required
          value={name}
          maxLength={120}
          error={errors.name}
          onChange={(e) => {
            setName(e.target.value);
            setNameTouched(true);
          }}
        />

        <div>
          <span className={labelClass}>Type</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Count type">
            {(Object.keys(COUNT_TYPE_LABELS) as CountType[]).map((t) => (
              <Chip key={t} active={countType === t} onClick={() => setCountType(t)}>
                {COUNT_TYPE_LABELS[t]}
              </Chip>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-text-secondary">
            {countType === 'full'
              ? 'Every part stocked at this location, end to end.'
              : 'A focused slice — count part of the location on a rolling schedule.'}
          </p>
        </div>

        {countType === 'cycle' && (
          <div>
            <label htmlFor="count-scope" className={labelClass}>
              What to count
            </label>
            <select id="count-scope" className={selectClass} value={scope} onChange={(e) => setScope(e.target.value as CountScope)}>
              {(Object.keys(COUNT_SCOPE_LABELS) as CountScope[]).map((s) => (
                <option key={s} value={s}>
                  {COUNT_SCOPE_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {effectiveScope === 'category' && (
        <div className="mt-4">
          <label htmlFor="count-category" className={labelClass}>
            Category
          </label>
          <select id="count-category" className={selectClass} value={category} onChange={(e) => setCategory(e.target.value)} aria-invalid={!!errors.category}>
            <option value="">Choose a category…</option>
            {options.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {errors.category && <p role="alert" className="mt-1.5 text-xs text-danger">{errors.category}</p>}
        </div>
      )}

      {effectiveScope === 'top_value' && (
        <div className="mt-4 max-w-xs">
          <Input
            label="How many parts"
            type="number"
            inputMode="numeric"
            min={1}
            max={200}
            value={topN}
            error={errors.topN}
            helperText="Ranked by on-hand quantity × unit cost at this location."
            onChange={(e) => setTopN(e.target.value)}
          />
        </div>
      )}

      {effectiveScope === 'selected' && (
        <div className="mt-4">
          <Input
            label={`Parts to count (${partIds.size} selected)`}
            icon={Search}
            value={partQuery}
            placeholder="Search by name or part number"
            error={errors.parts}
            onChange={(e) => setPartQuery(e.target.value)}
          />
          <ul className="mt-2 max-h-56 divide-y divide-border overflow-y-auto rounded-xl border border-border">
            {filteredParts.map((p) => (
              <li key={p.id}>
                <label className="flex min-h-[44px] cursor-pointer items-center gap-3 px-3 py-2 text-sm text-text-primary hover:bg-bg-tertiary">
                  <input type="checkbox" checked={partIds.has(p.id)} onChange={() => togglePart(p.id)} className="h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.part_number && <span className="shrink-0 text-xs text-text-secondary">#{p.part_number}</span>}
                </label>
              </li>
            ))}
            {filteredParts.length === 0 && <li className="px-3 py-3 text-sm text-text-secondary">Nothing matches that search.</li>}
          </ul>
        </div>
      )}

      <div className="mt-4 space-y-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} className="mt-1 h-4 w-4" />
          <span>
            <span className="block text-sm font-medium text-text-primary">Blind count</span>
            <span className="block text-xs text-text-secondary">
              Counters can't see the expected quantity, so they count what's there instead of confirming the system. Managers still see everything.
            </span>
          </span>
        </label>
        <Textarea label="Notes (optional)" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void handleSubmit()} disabled={submitting}>
          <Check size={16} /> {submitting ? 'Starting…' : 'Start counting'}
        </Button>
      </div>
    </section>
  );
}

// ============================================================
// DETAIL
// ============================================================

type DialogKind = null | 'submit' | 'approve' | 'cancel';

function CountDetail({
  accountOwnerId,
  countId,
  userId,
  canManage,
  canViewCosts,
  toast,
  onBack,
}: {
  accountOwnerId: string;
  countId: string;
  userId: string | null;
  canManage: boolean;
  canViewCosts: boolean;
  toast: ToastFn;
  onBack: () => void;
}) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error' | 'missing'>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [count, setCount] = useState<InventoryCount | null>(null);
  const [lines, setLines] = useState<InventoryCountLine[]>([]);
  const [events, setEvents] = useState<InventoryCountEvent[]>([]);

  const [mode, setMode] = useState<LineFilterMode>('all');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [recountIds, setRecountIds] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);

  const pending = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setPhase('loading');
      try {
        const c = await getInventoryCount(accountOwnerId, countId);
        if (!c) {
          setPhase('missing');
          return;
        }
        const [ls, ev] = await Promise.all([getInventoryCountLines(countId), getInventoryCountEvents(accountOwnerId, countId)]);
        setCount(c);
        setLines(ls);
        setEvents(ev);
        setPhase('ready');
      } catch (err) {
        if (!silent) {
          setErrorMessage(countErrorMessage(err, "Couldn't load this count."));
          setPhase('error');
        }
      }
    },
    [accountOwnerId, countId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Several people can count one sheet: refresh quietly while the tab is visible and nothing is in flight.
  const status = count?.status;
  useEffect(() => {
    if (status !== 'in_progress' && status !== 'pending_approval') return;
    const tick = () => {
      if (document.visibilityState === 'visible' && pending.current === 0) void load(true);
    };
    const id = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [status, load]);

  const patchLine = useCallback((lineId: string, patch: Partial<InventoryCountLine>) => {
    setLines((prev) => prev.map((l) => (l.line_id === lineId ? { ...l, ...patch } : l)));
  }, []);

  const track = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    pending.current += 1;
    try {
      return await fn();
    } finally {
      pending.current -= 1;
    }
  }, []);

  const summary = useMemo(() => summarizeLines(lines), [lines]);

  // ---------- line mutations (optimistic, self-healing on error) ----------

  const handleBump = useCallback(
    async (line: InventoryCountLine, delta: number) => {
      setLines((prev) =>
        prev.map((l) => (l.line_id === line.line_id ? { ...l, counted_qty: Math.max(0, (l.counted_qty ?? 0) + delta) } : l)),
      );
      try {
        const r = await track(() => countInventoryPart({ countId, partId: line.part_id, increment: delta }));
        patchLine(line.line_id, { counted_qty: r.counted_qty });
      } catch (err) {
        toast(countErrorMessage(err, "Couldn't save that count."), 'error');
        void load(true);
      }
    },
    [countId, load, patchLine, toast, track],
  );

  const handleSet = useCallback(
    async (line: InventoryCountLine, value: number | null) => {
      patchLine(line.line_id, { counted_qty: value });
      try {
        await track(() => setInventoryCountLine(line.line_id, value));
      } catch (err) {
        toast(countErrorMessage(err, "Couldn't save that count."), 'error');
        void load(true);
      }
    },
    [load, patchLine, toast, track],
  );

  const handleNote = useCallback(
    async (line: InventoryCountLine, note: string) => {
      const next = note.trim() || null;
      if (next === (line.note ?? null)) return;
      patchLine(line.line_id, { note: next });
      try {
        await track(() => setInventoryCountLineNote(line.line_id, note));
      } catch (err) {
        toast(countErrorMessage(err, "Couldn't save that note."), 'error');
        void load(true);
      }
    },
    [load, patchLine, toast, track],
  );

  // ---------- workflow actions ----------

  const doSubmit = async () => {
    setWorking(true);
    try {
      await track(() => submitInventoryCount(countId, summary.uncounted > 0));
      toast('Count submitted for approval', 'success');
      setDialog(null);
      await load(true);
    } catch (err) {
      toast(countErrorMessage(err, "Couldn't submit this count."), 'error');
      setDialog(null);
    } finally {
      setWorking(false);
    }
  };

  const doApprove = async () => {
    setWorking(true);
    try {
      const r = await track(() => approveInventoryCount(countId, decisionNote));
      toast(`Approved — ${r.adjusted_lines} adjustment${r.adjusted_lines === 1 ? '' : 's'} posted to the ledger`, 'success');
      setDialog(null);
      setDecisionNote('');
      setRecountIds(new Set());
      await load(true);
    } catch (err) {
      toast(countErrorMessage(err, "Couldn't approve this count."), 'error');
      setDialog(null);
    } finally {
      setWorking(false);
    }
  };

  const doReturn = async () => {
    setWorking(true);
    try {
      await track(() => returnInventoryCountForRecount(countId, decisionNote, Array.from(recountIds)));
      toast('Returned for recount', 'success');
      setDecisionNote('');
      setRecountIds(new Set());
      await load(true);
    } catch (err) {
      toast(countErrorMessage(err, "Couldn't return this count."), 'error');
    } finally {
      setWorking(false);
    }
  };

  const doCancel = async () => {
    setWorking(true);
    try {
      await track(() => cancelInventoryCount(countId, decisionNote));
      toast('Count cancelled — no stock was changed', 'info');
      setDialog(null);
      setDecisionNote('');
      await load(true);
    } catch (err) {
      toast(countErrorMessage(err, "Couldn't cancel this count."), 'error');
      setDialog(null);
    } finally {
      setWorking(false);
    }
  };

  const toggleRecount = (lineId: string) =>
    setRecountIds((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });

  const exportReport = () => {
    if (!count) return;
    exportToCsv(sortByVarianceImpact(lines), buildVarianceCsvColumns(summary.netValueCents !== null), `${count.count_number}-variance`);
  };

  // ---------- render states ----------

  if (phase === 'loading') {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full rounded-2xl" />
        <SkeletonCardList count={4} />
      </div>
    );
  }
  if (phase === 'missing') {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="This count doesn't exist"
        description="It may have been removed, or it belongs to another account."
        action={{ label: 'Back to counts', onClick: onBack }}
      />
    );
  }
  if (phase === 'error' || !count) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load this count"
        description={errorMessage || 'Check your connection and try again.'}
        action={{ label: 'Retry', onClick: () => void load() }}
        secondaryAction={{ label: 'Back to counts', onClick: onBack }}
      />
    );
  }

  const isCounting = count.status === 'in_progress';
  const isPending = count.status === 'pending_approval';
  const hideExpected = count.blind && isCounting && !canManage;
  const canCancel = (canManage && (isCounting || isPending)) || (isCounting && !!userId && count.created_by === userId);
  const showCosts = summary.netValueCents !== null && canViewCosts;
  const approveDescription =
    `This posts ${summary.varianceLines} adjustment${summary.varianceLines === 1 ? '' : 's'} to the stock ledger` +
    (showCosts && summary.netValueCents !== null ? ` (net ${formatSignedCents(summary.netValueCents)})` : '') +
    ". It can't be undone — fix a mistake with a new count.";

  return (
    <div className="space-y-5">
      <div>
        <button
          type="button"
          onClick={onBack}
          className="focus-ring -ml-1 mb-2 flex items-center gap-1 rounded-lg px-1 py-1 text-sm font-medium text-text-secondary hover:text-text-primary"
        >
          <ChevronLeft size={16} /> All counts
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-text-primary sm:text-2xl">{count.name}</h1>
            <p className="mt-1 text-xs text-text-secondary sm:text-sm">
              {count.count_number} · {count.location_name} · {COUNT_TYPE_LABELS[count.count_type]}
              {count.scope_detail ? ` · ${count.scope_detail}` : ''}
              {count.created_by_name ? ` · started by ${count.created_by_name}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {count.blind && <StatusPill text="Blind" />}
            <StatusPill text={COUNT_STATUS_LABELS[count.status]} tone={countStatusTone(count.status)} />
          </div>
        </div>
      </div>

      <div className={panelClass}>
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="font-medium text-text-primary">
            {summary.counted} of {summary.total} counted
          </span>
          <span className="text-text-secondary">{summary.progressPct}%</span>
        </div>
        <ProgressBar pct={summary.progressPct} label="Counting progress" />
      </div>

      {isCounting && count.return_note && (
        <div role="status" className="flex items-start gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4">
          <RotateCcw size={18} className="mt-0.5 shrink-0 text-warning" />
          <div className="text-sm">
            <p className="font-semibold text-text-primary">Returned for recount</p>
            <p className="mt-0.5 text-text-secondary">{count.return_note}</p>
          </div>
        </div>
      )}
      {hideExpected && (
        <div className="flex items-start gap-3 rounded-2xl border border-border bg-bg-tertiary/60 p-4 text-sm text-text-secondary">
          <EyeOff size={18} className="mt-0.5 shrink-0" />
          <p>Blind count — expected quantities are hidden. Count exactly what you see on the shelf.</p>
        </div>
      )}
      {isPending && !canManage && (
        <div role="status" className="flex items-start gap-3 rounded-2xl border border-border bg-bg-tertiary/60 p-4 text-sm text-text-secondary">
          <Lock size={18} className="mt-0.5 shrink-0" />
          <p>Submitted — counting is locked until a manager approves it or sends it back for a recount.</p>
        </div>
      )}
      {count.status === 'approved' && (
        <div role="status" className="rounded-2xl border border-success/30 bg-success/10 p-4 text-sm">
          <p className="font-semibold text-text-primary">Approved {formatWhen(count.approved_at)} — adjustments posted to the ledger.</p>
          {count.approval_note && <p className="mt-0.5 text-text-secondary">{count.approval_note}</p>}
        </div>
      )}
      {count.status === 'cancelled' && (
        <div role="status" className="rounded-2xl border border-border bg-bg-tertiary/60 p-4 text-sm text-text-secondary">
          This count was cancelled. No stock was changed.
        </div>
      )}

      {isCounting && (
        <CountingSheet
          countId={countId}
          lines={lines}
          summary={summary}
          mode={mode}
          query={query}
          onMode={setMode}
          onQuery={setQuery}
          hideExpected={hideExpected}
          toast={toast}
          onBump={handleBump}
          onSet={handleSet}
          onNote={handleNote}
          onScanned={(addedLine) => {
            if (addedLine) void load(true);
          }}
          track={track}
        />
      )}

      {!isCounting && (
        <VarianceReport
          lines={lines}
          summary={summary}
          showCosts={showCosts}
          posted={count.status === 'approved'}
          selectable={isPending && canManage}
          selected={recountIds}
          onToggle={toggleRecount}
          onExport={exportReport}
        />
      )}

      {isCounting && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
          <div className="text-sm text-text-secondary">
            {summary.uncounted > 0
              ? `${summary.uncounted} line${summary.uncounted === 1 ? '' : 's'} still to count.`
              : 'Every line is counted. Ready to submit.'}
          </div>
          <div className="flex items-center gap-2">
            {canCancel && (
              <Button variant="ghost" size="sm" onClick={() => setDialog('cancel')} disabled={working}>
                Cancel count
              </Button>
            )}
            <Button size="sm" onClick={() => setDialog('submit')} disabled={working || summary.counted === 0}>
              <Check size={16} /> Submit for approval
            </Button>
          </div>
        </div>
      )}

      {isPending && canManage && (
        <section className={`${panelClass} space-y-4`} aria-label="Approval">
          <div>
            <h2 className="text-base font-semibold text-text-primary">Review &amp; decide</h2>
            <p className="mt-1 text-xs text-text-secondary">
              Tick lines above to send only those back for a recount, or approve to post every variance as a ledger adjustment.
              {recountIds.size > 0 && ` ${recountIds.size} line${recountIds.size === 1 ? '' : 's'} selected for recount.`}
            </p>
          </div>
          <Textarea
            label="Note"
            rows={2}
            maxLength={500}
            value={decisionNote}
            helperText="Required to return for recount; optional when approving or cancelling."
            onChange={(e) => setDecisionNote(e.target.value)}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDialog('cancel')} disabled={working}>
              Cancel count
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void doReturn()} disabled={working || decisionNote.trim().length < 3}>
              <RotateCcw size={16} /> Return for recount
            </Button>
            <Button size="sm" onClick={() => setDialog('approve')} disabled={working}>
              <Check size={16} /> Approve &amp; post adjustments
            </Button>
          </div>
        </section>
      )}

      <section className={panelClass} aria-label="History">
        <h2 className="mb-3 text-sm font-semibold text-text-primary">History</h2>
        {events.length === 0 ? (
          <p className="text-sm text-text-secondary">Events will appear here as the count moves along.</p>
        ) : (
          <ol className="space-y-2">
            {events.map((ev) => (
              <li key={ev.id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="text-text-primary">
                  {COUNT_EVENT_LABELS[ev.event_type]}
                  {ev.actor_name && <span className="text-text-secondary"> · {ev.actor_name}</span>}
                  {ev.note && <span className="block text-xs text-text-secondary">{ev.note}</span>}
                </span>
                <span className="text-xs text-text-secondary">{formatWhen(ev.created_at)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <ConfirmDialog
        open={dialog === 'submit'}
        title="Submit this count for approval?"
        description={
          (summary.uncounted > 0
            ? `${summary.uncounted} uncounted line${summary.uncounted === 1 ? '' : 's'} will be left unchanged. `
            : '') + 'Counting is locked once submitted, until a manager approves it or returns it for a recount.'
        }
        confirmLabel="Submit for approval"
        onConfirm={doSubmit}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === 'approve'}
        title="Approve and post adjustments?"
        description={approveDescription}
        confirmLabel="Approve & post"
        onConfirm={doApprove}
        onCancel={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === 'cancel'}
        title="Cancel this count?"
        description="No stock will change, and the parts are released so they can be counted again. Counts already entered are kept for the record."
        confirmLabel="Yes, cancel the count"
        onConfirm={doCancel}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}

// ============================================================
// COUNTING SHEET (scan bar + line cards)
// ============================================================

function CountingSheet({
  countId,
  lines,
  summary,
  mode,
  query,
  onMode,
  onQuery,
  hideExpected,
  toast,
  onBump,
  onSet,
  onNote,
  onScanned,
  track,
}: {
  countId: string;
  lines: InventoryCountLine[];
  summary: CountSummary;
  mode: LineFilterMode;
  query: string;
  onMode: (m: LineFilterMode) => void;
  onQuery: (q: string) => void;
  hideExpected: boolean;
  toast: ToastFn;
  onBump: (line: InventoryCountLine, delta: number) => void;
  onSet: (line: InventoryCountLine, value: number | null) => void;
  onNote: (line: InventoryCountLine, note: string) => void;
  /** Called after a successful scan. `true` when the part was NOT on the sheet and was added. */
  onScanned: (addedLine: boolean) => void;
  track: <T>(fn: () => Promise<T>) => Promise<T>;
}) {
  const [scanValue, setScanValue] = useState('');
  const [perScan, setPerScan] = useState('1');
  const [lastScan, setLastScan] = useState<{ lineId: string; name: string; qty: number; added: boolean } | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [caps, setCaps] = useState({ scan: false, nfc: false });
  const [scanning, setScanning] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastCodeRef = useRef<{ code: string; at: number } | null>(null);
  const perScanRef = useRef(1);

  useEffect(() => {
    const n = Number(perScan);
    perScanRef.current = Number.isInteger(n) && n >= 1 && n <= 999 ? n : 1;
  }, [perScan]);

  useEffect(() => {
    let alive = true;
    detectCapabilities()
      .then((c) => {
        if (alive) setCaps(c);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      abortRef.current?.abort();
    };
  }, []);

  const handleCode = useCallback(
    async (raw: string, source: 'typed' | 'camera') => {
      const code = normalizeScanCode(raw);
      if (!code) return;
      const now = Date.now();
      if (source === 'camera' && shouldIgnoreRescan(lastCodeRef.current, code, now)) return;
      lastCodeRef.current = { code, at: now };
      try {
        const r = await track(() => countInventoryPart({ countId, barcode: code, increment: perScanRef.current }));
        setScanError(null);
        setLastScan({ lineId: r.line_id, name: r.part_name, qty: r.counted_qty, added: r.added });
        navigator.vibrate?.(30);
        onScanned(r.added);
        window.setTimeout(() => {
          document.getElementById(`line-${r.line_id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 60);
      } catch (err) {
        setLastScan(null);
        setScanError(isNoMatchError(err) ? `No part matches "${code}". Check the code or add the barcode to the part first.` : countErrorMessage(err, "Couldn't record that scan."));
        navigator.vibrate?.([60, 40, 60]);
      }
    },
    [countId, onScanned, track],
  );

  const submitTyped = (e: React.FormEvent) => {
    e.preventDefault();
    const value = scanValue;
    setScanValue('');
    void handleCode(value, 'typed');
    // Keep the field ready for the next hardware-scanner burst on desktops/tablets; don't pop the phone keyboard.
    if (window.matchMedia?.('(pointer: fine)').matches) inputRef.current?.focus();
  };

  const startCamera = async () => {
    if (scanning) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setScanning(true);
    try {
      do {
        const { value } = await scanCode(videoRef.current, abort.signal);
        await handleCode(value, 'camera');
        if (isNative()) break; // the native scanner opens its own full-screen UI each time
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      } while (!abort.signal.aborted);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        toast('Could not open the camera scanner. You can still type or use a Bluetooth scanner.', 'error');
      }
    } finally {
      setScanning(false);
      abortRef.current = null;
    }
  };

  const stopCamera = () => abortRef.current?.abort();

  const visible = useMemo(() => filterLines(lines, { query, mode }), [lines, query, mode]);

  return (
    <div className="space-y-4">
      <div className="sticky top-[3.85rem] z-30 -mx-1 rounded-2xl border border-border bg-bg-secondary/95 p-3 shadow-sm backdrop-blur lg:top-0">
        <form onSubmit={submitTyped} className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Input
              ref={inputRef}
              icon={ScanLine}
              aria-label="Scan or type a barcode or part number"
              placeholder="Scan or type barcode / part number"
              value={scanValue}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="done"
              onChange={(e) => setScanValue(e.target.value)}
            />
          </div>
          <div className="w-20 shrink-0">
            <Input
              aria-label="Quantity added per scan"
              type="number"
              inputMode="numeric"
              min={1}
              max={999}
              value={perScan}
              title="Quantity added per scan"
              onChange={(e) => setPerScan(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" className="shrink-0" disabled={!scanValue.trim()}>
            Add
          </Button>
          {caps.scan && (
            <Button
              type="button"
              size="sm"
              variant={scanning ? 'primary' : 'secondary'}
              className="shrink-0"
              aria-pressed={scanning}
              aria-label={scanning ? 'Stop camera scanner' : 'Open camera scanner'}
              onClick={scanning ? stopCamera : () => void startCamera()}
            >
              <Camera size={16} />
              <span className="hidden sm:inline">{scanning ? 'Stop' : 'Camera'}</span>
            </Button>
          )}
        </form>
        <video ref={videoRef} muted playsInline className={scanning && !isNative() ? 'mt-3 aspect-video w-full rounded-xl bg-black object-cover' : 'hidden'} />
        <div aria-live="polite" className="mt-2 min-h-[1.25rem] text-sm">
          {scanError && (
            <p role="alert" className="flex items-start gap-1.5 text-danger">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {scanError}
            </p>
          )}
          {!scanError && lastScan && (
            <p className="flex items-start gap-1.5 text-success">
              <Check size={15} className="mt-0.5 shrink-0" />
              <span>
                {lastScan.name} → <strong>{lastScan.qty}</strong>
                {lastScan.added && <span className="text-warning"> · not on the sheet, added</span>}
              </span>
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] flex-1">
          <Input icon={Search} aria-label="Filter lines" placeholder="Filter this sheet…" value={query} onChange={(e) => onQuery(e.target.value)} />
        </div>
        <div className="flex gap-1.5" role="group" aria-label="Show lines">
          <Chip active={mode === 'all'} onClick={() => onMode('all')}>
            All ({summary.total})
          </Chip>
          <Chip active={mode === 'uncounted'} onClick={() => onMode('uncounted')}>
            To count ({summary.uncounted})
          </Chip>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={mode === 'uncounted' && !query ? 'Everything is counted' : 'Nothing matches'}
          description={mode === 'uncounted' && !query ? 'Submit the count when you are happy with the numbers.' : 'Try a different search or filter.'}
        />
      ) : (
        <ul className="space-y-2">
          {visible.map((line) => (
            <LineCard
              key={line.line_id}
              line={line}
              hideExpected={hideExpected}
              highlight={lastScan?.lineId === line.line_id}
              onBump={onBump}
              onSet={onSet}
              onNote={onNote}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function QtyInput({ value, label, onCommit }: { value: number | null; label: string; onCommit: (v: number | null) => void }) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);

  // Follow server/optimistic changes (scans, other devices) unless the user is mid-edit.
  useEffect(() => {
    if (!focused.current) {
      setDraft(value === null ? '' : String(value));
      setError(null);
    }
  }, [value]);

  const commit = () => {
    const parsed = parseQuantityInput(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    if (parsed.value !== value) onCommit(parsed.value);
  };

  return (
    <div className="w-24">
      <input
        aria-label={label}
        aria-invalid={!!error}
        inputMode="numeric"
        pattern="[0-9]*"
        placeholder="—"
        value={draft}
        onFocus={(e) => {
          focused.current = true;
          e.currentTarget.select();
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className={`focus-ring h-11 w-full rounded-xl border bg-bg-primary text-center text-lg font-semibold text-text-primary ${
          error ? 'border-danger' : 'border-border'
        }`}
      />
      {error && (
        <p role="alert" className="mt-1 text-[11px] leading-tight text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function LineCard({
  line,
  hideExpected,
  highlight,
  onBump,
  onSet,
  onNote,
}: {
  line: InventoryCountLine;
  hideExpected: boolean;
  highlight: boolean;
  onBump: (line: InventoryCountLine, delta: number) => void;
  onSet: (line: InventoryCountLine, value: number | null) => void;
  onNote: (line: InventoryCountLine, note: string) => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(line.note ?? '');
  const kind = classifyLine(line);
  const variance = lineVarianceQty(line);
  const meta = [line.part_number ? `#${line.part_number}` : null, line.category].filter(Boolean).join(' · ');

  return (
    <li
      id={`line-${line.line_id}`}
      className={`rounded-2xl border p-3 transition-colors ${highlight ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">{line.part_name}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-text-secondary">
            {meta && <span>{meta}</span>}
            {line.added_during_count && <StatusPill text="Added during count" tone="warn" />}
          </p>
        </div>
        {!hideExpected && line.expected_qty !== null && (
          <div className="shrink-0 text-right">
            <p className="text-[11px] text-text-secondary">Expected</p>
            <p className="text-sm font-semibold text-text-primary">{line.expected_qty}</p>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className={iconBtnClass}
          aria-label={`Remove one ${line.part_name}`}
          disabled={(line.counted_qty ?? 0) <= 0}
          onClick={() => onBump(line, -1)}
        >
          <Minus size={18} />
        </button>
        <QtyInput value={line.counted_qty} label={`Counted quantity for ${line.part_name}`} onCommit={(v) => onSet(line, v)} />
        <button type="button" className={iconBtnClass} aria-label={`Add one ${line.part_name}`} onClick={() => onBump(line, 1)}>
          <Plus size={18} />
        </button>

        <div className="ml-auto flex items-center gap-2">
          {kind === 'match' && <StatusPill text="Match" tone="good" />}
          {(kind === 'over' || kind === 'short') && variance !== null && (
            <StatusPill text={formatSigned(variance)} tone={kind === 'short' ? 'bad' : 'warn'} />
          )}
          {kind === 'uncounted' && (
            <button
              type="button"
              onClick={() => onSet(line, 0)}
              className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            >
              None on shelf
            </button>
          )}
        </div>
      </div>

      <div className="mt-2">
        {noteOpen ? (
          <input
            autoFocus
            aria-label={`Note for ${line.part_name}`}
            maxLength={500}
            value={noteDraft}
            placeholder="Why does this differ? (damaged, mis-shelved…)"
            onChange={(e) => setNoteDraft(e.target.value)}
            onBlur={() => {
              onNote(line, noteDraft);
              setNoteOpen(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setNoteDraft(line.note ?? '');
              setNoteOpen(true);
            }}
            className="focus-ring rounded-lg px-1 py-0.5 text-left text-xs text-text-secondary hover:text-text-primary"
          >
            {line.note ? `Note: ${line.note}` : 'Add note'}
          </button>
        )}
      </div>
    </li>
  );
}

// ============================================================
// VARIANCE REPORT
// ============================================================

function VarianceReport({
  lines,
  summary,
  showCosts,
  posted,
  selectable,
  selected,
  onToggle,
  onExport,
}: {
  lines: InventoryCountLine[];
  summary: CountSummary;
  showCosts: boolean;
  posted: boolean;
  selectable: boolean;
  selected: Set<string>;
  onToggle: (lineId: string) => void;
  onExport: () => void;
}) {
  const [mode, setMode] = useState<LineFilterMode>('variances');
  const [query, setQuery] = useState('');

  const rows = useMemo(() => sortByVarianceImpact(filterLines(lines, { query, mode })), [lines, query, mode]);

  return (
    <section className="space-y-4" aria-label="Variance report">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard label="Accuracy" value={formatPct(summary.accuracyPct)} tone={summary.accuracyPct !== null && summary.accuracyPct < 90 ? 'bad' : 'good'} />
        <StatCard label="Lines with variance" value={summary.varianceLines} tone={summary.varianceLines ? 'warn' : undefined} />
        <StatCard label="Net units" value={formatSigned(summary.netUnits)} tone={summary.netUnits < 0 ? 'bad' : undefined} />
        {showCosts && summary.netValueCents !== null && (
          <StatCard label="Net value" value={formatSignedCents(summary.netValueCents)} tone={summary.netValueCents < 0 ? 'bad' : undefined} />
        )}
        {showCosts && summary.grossValueCents !== null && <StatCard label="Gross variance" value={formatSignedCents(summary.grossValueCents).replace('+', '')} />}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] flex-1">
          <Input icon={Search} aria-label="Filter report" placeholder="Filter report…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="flex gap-1.5" role="group" aria-label="Report rows">
          <Chip active={mode === 'variances'} onClick={() => setMode('variances')}>
            Variances ({summary.varianceLines})
          </Chip>
          <Chip active={mode === 'all'} onClick={() => setMode('all')}>
            All ({summary.total})
          </Chip>
          <Chip active={mode === 'uncounted'} onClick={() => setMode('uncounted')}>
            Not counted ({summary.uncounted})
          </Chip>
        </div>
        <Button variant="secondary" size="sm" onClick={onExport}>
          <Download size={16} /> CSV
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={mode === 'variances' && !query ? 'Everything matched' : 'Nothing matches'}
          description={mode === 'variances' && !query ? 'Every counted line equals the system quantity.' : 'Try a different search or filter.'}
        />
      ) : (
        <>
          {/* Desktop / tablet table */}
          <div className="hidden overflow-x-auto rounded-2xl border border-border sm:block">
            <table className="w-full text-left text-sm">
              <thead className="bg-bg-tertiary text-xs text-text-secondary">
                <tr>
                  {selectable && <th className="w-10 px-3 py-2 font-medium"><span className="sr-only">Recount</span></th>}
                  <th className="px-3 py-2 font-medium">Part</th>
                  <th className="px-3 py-2 text-right font-medium">Expected</th>
                  <th className="px-3 py-2 text-right font-medium">Counted</th>
                  <th className="px-3 py-2 text-right font-medium">Variance</th>
                  <th className="px-3 py-2 text-right font-medium">%</th>
                  {showCosts && <th className="px-3 py-2 text-right font-medium">Value</th>}
                  {posted && <th className="px-3 py-2 text-right font-medium">Posted</th>}
                  <th className="px-3 py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((l) => {
                  const v = lineVarianceQty(l);
                  const pct = variancePct(l.expected_qty, l.counted_qty);
                  return (
                    <tr key={l.line_id} className={selected.has(l.line_id) ? 'bg-warning/5' : undefined}>
                      {selectable && (
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={selected.has(l.line_id)}
                            onChange={() => onToggle(l.line_id)}
                            aria-label={`Recount ${l.part_name}`}
                          />
                        </td>
                      )}
                      <td className="px-3 py-2 text-text-primary">
                        {l.part_name}
                        {l.part_number && <span className="ml-1.5 text-xs text-text-secondary">#{l.part_number}</span>}
                        {l.added_during_count && <span className="ml-1.5"><StatusPill text="Added" tone="warn" /></span>}
                      </td>
                      <td className="px-3 py-2 text-right text-text-secondary">{l.expected_qty ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-text-primary">{l.counted_qty ?? '—'}</td>
                      <td className={`px-3 py-2 text-right font-semibold ${v === null || v === 0 ? 'text-text-secondary' : v < 0 ? 'text-danger' : 'text-warning'}`}>
                        {v === null ? '—' : formatSigned(v)}
                      </td>
                      <td className="px-3 py-2 text-right text-text-secondary">{pct === null ? '—' : `${pct}%`}</td>
                      {showCosts && (
                        <td className="px-3 py-2 text-right text-text-primary">
                          {l.variance_value_cents === null ? '—' : formatSignedCents(l.variance_value_cents)}
                        </td>
                      )}
                      {posted && <td className="px-3 py-2 text-right text-text-secondary">{l.applied_delta === null ? '—' : formatSigned(l.applied_delta)}</td>}
                      <td className="max-w-[220px] truncate px-3 py-2 text-text-secondary" title={l.note ?? ''}>
                        {l.note ?? ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <ul className="space-y-2 sm:hidden">
            {rows.map((l) => {
              const v = lineVarianceQty(l);
              return (
                <li key={l.line_id} className={`rounded-2xl border p-3 ${selected.has(l.line_id) ? 'border-warning/50 bg-warning/5' : 'border-border bg-bg-secondary'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 text-sm font-semibold text-text-primary">{l.part_name}</p>
                    {v !== null && <StatusPill text={formatSigned(v)} tone={v === 0 ? 'good' : v < 0 ? 'bad' : 'warn'} />}
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">
                    Expected {l.expected_qty ?? '—'} · Counted {l.counted_qty ?? '—'}
                    {showCosts && l.variance_value_cents !== null && ` · ${formatSignedCents(l.variance_value_cents)}`}
                    {posted && l.applied_delta !== null && ` · posted ${formatSigned(l.applied_delta)}`}
                  </p>
                  {l.note && <p className="mt-1 text-xs text-text-secondary">Note: {l.note}</p>}
                  {selectable && (
                    <label className="mt-2 flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-text-primary">
                      <input type="checkbox" className="h-4 w-4" checked={selected.has(l.line_id)} onChange={() => onToggle(l.line_id)} />
                      Send back for recount
                    </label>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {!posted && summary.uncounted > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-text-secondary">
          <RefreshCw size={13} /> {summary.uncounted} line{summary.uncounted === 1 ? ' was' : 's were'} not counted and will not be adjusted.
        </p>
      )}
    </section>
  );
}
