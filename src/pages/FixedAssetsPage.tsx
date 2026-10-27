import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle, Archive, CalendarRange, Lock, Package, Pencil, Play, Plus, RefreshCw, Search, Trash2, X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonTable, FadeIn } from '@/components/Skeleton';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { fetchChartOfAccounts, type ChartOfAccount } from '@/lib/accounting';
import { errMsg, money } from '@/lib/chartOfAccounts';
import {
  CATEGORIES, METHODS, STATUS_LABEL, bookValue, canDeleteAsset, categoryMeta, costLockReason, createAsset, deleteAsset,
  describeEvent, disposalPreview, disposeAsset, draftFromAsset, draftToSchedule, emptyDraft, ensureDefaultAccounts,
  fetchAssetEvents, fetchAssets, fetchForecast, fetchRunPreview, fetchSchedule, fetchVehicleOptions, filterAssets,
  formatDay, formatLife, formatMonth, methodLabel, monthStartOf, parseCents, runDepreciation, summarizeAssets,
  summarizeSchedule, termsLockReason, todayIso, updateAsset, validateAssetDraft, validateDisposal,
  type AssetCategory, type AssetDraft, type AssetEvent, type AssetStatus, type DefaultAccounts, type DepreciationMethod,
  type DraftField, type FixedAsset, type ForecastRow, type RunPreviewRow, type ScheduleLine, type VehicleOption,
} from '@/lib/fixedAssets';

type Tab = 'register' | 'depreciation' | 'activity';
const TABS: { id: Tab; label: string }[] = [
  { id: 'register', label: 'Register' },
  { id: 'depreciation', label: 'Depreciation' },
  { id: 'activity', label: 'Activity' },
];

const STATUS_FILTERS: { id: AssetStatus | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: STATUS_LABEL.active },
  { id: 'fully_depreciated', label: STATUS_LABEL.fully_depreciated },
  { id: 'disposed', label: STATUS_LABEL.disposed },
];

const STATUS_BADGE: Record<AssetStatus, string> = {
  active: 'bg-success/10 text-success',
  fully_depreciated: 'bg-blue-500/10 text-blue-600 dark:text-blue-300',
  disposed: 'bg-bg-tertiary text-text-secondary',
};

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-50';

const acctLabel = (a: Pick<ChartOfAccount, 'code' | 'name'>) => `${a.code} · ${a.name}`;

function Pill({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${className}`}>{children}</span>;
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Card className="!p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </Card>
  );
}

function Field({ id, label, error, help, children }: { id: string; label: string; error?: string; help?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">{label}</label>
      {children}
      {error ? (
        <p role="alert" className="mt-1.5 text-xs text-danger">{error}</p>
      ) : help ? (
        <p className="mt-1.5 text-xs text-text-secondary">{help}</p>
      ) : null}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-text-primary">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
      <span>{message}</span>
    </div>
  );
}

function ModalShell({
  titleId, title, subtitle, size = 'lg', onClose, children,
}: {
  titleId: string; title: string; subtitle?: string; size?: 'md' | 'lg' | 'xl'; onClose: () => void; children: ReactNode;
}) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  const width = size === 'xl' ? 'sm:max-w-3xl' : size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md';
  return (
    <>
      <div className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`fixed inset-x-0 bottom-0 z-[120] max-h-[92vh] overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[92vw] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:p-6 ${width}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-text-primary">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-text-secondary">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        <div className="mt-5">{children}</div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Asset editor
// ---------------------------------------------------------------------------

function AssetEditor({
  editing, defaults, assets, accounts, vehicles, today, onClose, onSaved,
}: {
  editing: FixedAsset | null;
  defaults?: DefaultAccounts;
  assets: FixedAsset[];
  accounts: ChartOfAccount[];
  vehicles: VehicleOption[];
  today: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<AssetDraft>(() => (editing ? draftFromAsset(editing) : emptyDraft(today, defaults)));
  const [termsTouched, setTermsTouched] = useState(false);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');

  const frozen = editing ? termsLockReason(editing) : '';
  const costLocked = editing ? costLockReason(editing) : '';
  const termsDisabled = !!frozen;
  const costDisabled = !!frozen || !!costLocked;

  const errors = useMemo(
    () => validateAssetDraft(draft, { assets, editingId: editing?.id ?? null, accounts }),
    [draft, assets, editing, accounts],
  );
  const hasErrors = Object.keys(errors).length > 0;
  const shown = (k: DraftField) => (touched ? errors[k] : undefined);

  const planned = useMemo(() => draftToSchedule(draft), [draft]);
  const summary = useMemo(
    () => summarizeSchedule(planned, parseCents(draft.cost) ?? 0, parseCents(draft.salvage) ?? 0),
    [planned, draft.cost, draft.salvage],
  );

  const assetAccounts = useMemo(() => accounts.filter((a) => a.type === 'asset'), [accounts]);
  const expenseAccounts = useMemo(() => accounts.filter((a) => a.type === 'expense'), [accounts]);
  const offsetAccounts = useMemo(() => accounts.filter((a) => a.id !== draft.assetAccountId), [accounts, draft.assetAccountId]);

  const set = <K extends keyof AssetDraft>(k: K, v: AssetDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const changeCategory = (category: AssetCategory) =>
    setDraft((d) => {
      const next: AssetDraft = { ...d, category, vehicleId: category === 'vehicle' ? d.vehicleId : '' };
      if (frozen) return next;
      if (category === 'land') return { ...next, method: 'none', lifeMonths: '' };
      if (!editing && !termsTouched) {
        const meta = categoryMeta(category);
        return { ...next, method: meta.method, lifeMonths: meta.lifeMonths ? String(meta.lifeMonths) : '' };
      }
      return next;
    });

  const changeMethod = (method: DepreciationMethod) => {
    setTermsTouched(true);
    setDraft((d) => ({
      ...d,
      method,
      lifeMonths: method === 'none' ? '' : d.lifeMonths || String(categoryMeta(d.category).lifeMonths || 60),
    }));
  };

  const submit = async () => {
    setTouched(true);
    if (hasErrors || saving) return;
    setSaving(true);
    setServerError('');
    try {
      if (editing) await updateAsset(editing.id, draft);
      else await createAsset(draft);
      toast(editing ? 'Asset updated.' : 'Asset added.', 'success');
      onSaved();
    } catch (e) {
      const msg = errMsg(e);
      setServerError(msg);
      toast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  const lifeNum = Number(draft.lifeMonths);
  const noAccounts = accounts.length === 0;

  return (
    <ModalShell
      titleId="fa-editor-title"
      title={editing ? 'Edit asset' : 'New fixed asset'}
      subtitle={editing ? `${editing.asset_tag} · ${editing.name}` : 'Depreciation posts to your ledger automatically once you run it.'}
      size="xl"
      onClose={onClose}
    >
      {noAccounts && <div className="mb-4"><ErrorBanner message="Your chart of accounts could not be loaded. Close this window and try again." /></div>}

      <div className="space-y-5">
        <section aria-labelledby="fa-sec-basics" className="space-y-4">
          <h3 id="fa-sec-basics" className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Details</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Input label="Asset name" required value={draft.name} maxLength={120} onChange={(e) => set('name', e.target.value)} error={shown('name')} />
            </div>
            <Input
              label="Asset tag" value={draft.assetTag} maxLength={40} placeholder="Auto (FA-0001)"
              onChange={(e) => set('assetTag', e.target.value)} error={shown('assetTag')}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="fa-category" label="Category">
              <select id="fa-category" value={draft.category} onChange={(e) => changeCategory(e.target.value as AssetCategory)} className={selectClass}>
                {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </Field>
            {draft.category === 'vehicle' && vehicles.length > 0 ? (
              <Field id="fa-vehicle" label="Fleet vehicle (optional)">
                <select id="fa-vehicle" value={draft.vehicleId} onChange={(e) => set('vehicleId', e.target.value)} className={selectClass}>
                  <option value="">Not linked</option>
                  {vehicles.map((v) => <option key={v.id} value={v.id}>{v.label}{v.license_plate ? ` · ${v.license_plate}` : ''}</option>)}
                </select>
              </Field>
            ) : (
              <Input label="Serial / VIN (optional)" value={draft.serialNumber} maxLength={80} onChange={(e) => set('serialNumber', e.target.value)} error={shown('serialNumber')} />
            )}
          </div>
          {draft.category === 'vehicle' && vehicles.length > 0 && (
            <Input label="Serial / VIN (optional)" value={draft.serialNumber} maxLength={80} onChange={(e) => set('serialNumber', e.target.value)} error={shown('serialNumber')} />
          )}
          <Input label="Location (optional)" value={draft.location} maxLength={120} onChange={(e) => set('location', e.target.value)} error={shown('location')} />
          <Textarea label="Description (optional)" rows={2} maxLength={500} value={draft.description} onChange={(e) => set('description', e.target.value)} error={shown('description')} />
        </section>

        <section aria-labelledby="fa-sec-cost" className="space-y-4">
          <h3 id="fa-sec-cost" className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Cost & depreciation</h3>
          {(frozen || costLocked) && (
            <p className="flex items-start gap-2 rounded-xl border border-border bg-bg-tertiary p-3 text-xs text-text-secondary">
              <Lock size={14} className="mt-0.5 shrink-0" />
              <span>{frozen || costLocked}</span>
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Acquisition date" required type="date" value={draft.acquisitionDate} disabled={costDisabled} onChange={(e) => set('acquisitionDate', e.target.value)} error={shown('acquisitionDate')} />
            <Input label="In-service date" required type="date" value={draft.inServiceDate} disabled={termsDisabled} onChange={(e) => { setTermsTouched(true); set('inServiceDate', e.target.value); }} error={shown('inServiceDate')} helperText="Depreciation starts in this month." />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Cost ($)" required inputMode="decimal" placeholder="0.00" value={draft.cost} disabled={costDisabled} onChange={(e) => set('cost', e.target.value)} error={shown('cost')} />
            <Input label="Salvage value ($)" inputMode="decimal" placeholder="0.00" value={draft.salvage} disabled={termsDisabled || draft.method === 'none'} onChange={(e) => { setTermsTouched(true); set('salvage', e.target.value); }} error={shown('salvage')} helperText="What it should be worth at the end of its life." />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="fa-method" label="Method" help={METHODS.find((m) => m.id === draft.method)?.hint}>
              <select id="fa-method" value={draft.method} disabled={termsDisabled} onChange={(e) => changeMethod(e.target.value as DepreciationMethod)} className={selectClass}>
                {METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </Field>
            <Input
              label="Useful life (months)" inputMode="numeric" value={draft.lifeMonths} disabled={termsDisabled || draft.method === 'none'}
              onChange={(e) => { setTermsTouched(true); set('lifeMonths', e.target.value.replace(/[^\d]/g, '')); }}
              error={shown('lifeMonths')}
              helperText={Number.isInteger(lifeNum) && lifeNum > 0 ? `= ${formatLife(lifeNum)}` : undefined}
            />
          </div>

          <div aria-live="polite" className="rounded-xl border border-border bg-bg-primary p-4">
            {draft.method === 'none' ? (
              <p className="text-sm text-text-secondary">This asset is not depreciated. It stays on the balance sheet at cost until it is disposed of.</p>
            ) : planned.length === 0 ? (
              <p className="text-sm text-text-secondary">Enter the cost, life and in-service date to preview the schedule.</p>
            ) : (
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div><dt className="text-xs text-text-secondary">First month</dt><dd className="font-semibold tabular-nums text-text-primary">{money(summary.firstAmount)}</dd></div>
                <div><dt className="text-xs text-text-secondary">First 12 months</dt><dd className="font-semibold tabular-nums text-text-primary">{money(summary.firstYearTotal)}</dd></div>
                <div><dt className="text-xs text-text-secondary">Months</dt><dd className="font-semibold tabular-nums text-text-primary">{summary.months}</dd></div>
                <div><dt className="text-xs text-text-secondary">Fully depreciated</dt><dd className="font-semibold text-text-primary">{summary.endsOn ? formatMonth(summary.endsOn) : '—'}</dd></div>
              </dl>
            )}
          </div>
        </section>

        <section aria-labelledby="fa-sec-accounts" className="space-y-4">
          <h3 id="fa-sec-accounts" className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Ledger accounts</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="fa-acct-asset" label="Asset account" error={shown('assetAccountId')}>
              <select id="fa-acct-asset" value={draft.assetAccountId} disabled={costDisabled} onChange={(e) => set('assetAccountId', e.target.value)} className={selectClass} aria-invalid={!!shown('assetAccountId')}>
                <option value="">Choose…</option>
                {assetAccounts.map((a) => <option key={a.id} value={a.id}>{acctLabel(a)}</option>)}
              </select>
            </Field>
            <Field id="fa-acct-accum" label="Accumulated depreciation" error={shown('accumulatedAccountId')}>
              <select id="fa-acct-accum" value={draft.accumulatedAccountId} disabled={termsDisabled} onChange={(e) => set('accumulatedAccountId', e.target.value)} className={selectClass} aria-invalid={!!shown('accumulatedAccountId')}>
                <option value="">Choose…</option>
                {assetAccounts.map((a) => <option key={a.id} value={a.id}>{acctLabel(a)}</option>)}
              </select>
            </Field>
            <Field id="fa-acct-exp" label="Depreciation expense" error={shown('expenseAccountId')}>
              <select id="fa-acct-exp" value={draft.expenseAccountId} disabled={termsDisabled} onChange={(e) => set('expenseAccountId', e.target.value)} className={selectClass} aria-invalid={!!shown('expenseAccountId')}>
                <option value="">Choose…</option>
                {expenseAccounts.map((a) => <option key={a.id} value={a.id}>{acctLabel(a)}</option>)}
              </select>
            </Field>
          </div>

          {!editing && (
            <div className="rounded-xl border border-border p-3">
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={draft.recordAcquisition} onChange={(e) => set('recordAcquisition', e.target.checked)} />
                <span>
                  <span className="font-medium text-text-primary">Also record the purchase in the ledger</span>
                  <span className="block text-xs text-text-secondary">
                    Posts the cost to the asset account on the acquisition date. Leave this off if the purchase is already in your books (for example from a bill).
                  </span>
                </span>
              </label>
              {draft.recordAcquisition && (
                <div className="mt-3">
                  <Field id="fa-acct-offset" label="Paid from / owed to" error={shown('offsetAccountId')}>
                    <select id="fa-acct-offset" value={draft.offsetAccountId} onChange={(e) => set('offsetAccountId', e.target.value)} className={selectClass} aria-invalid={!!shown('offsetAccountId')}>
                      <option value="">Choose…</option>
                      {offsetAccounts.map((a) => <option key={a.id} value={a.id}>{acctLabel(a)}</option>)}
                    </select>
                  </Field>
                </div>
              )}
            </div>
          )}
        </section>

        <Textarea label="Notes (optional)" rows={2} maxLength={1000} value={draft.notes} onChange={(e) => set('notes', e.target.value)} error={shown('notes')} />

        {serverError && <ErrorBanner message={serverError} />}
      </div>

      <div className="mt-6 flex gap-3">
        <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={onClose}>Cancel</Button>
        <Button type="button" size="sm" className="flex-1" onClick={() => void submit()} disabled={saving || noAccounts || (touched && hasErrors)}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Add asset'}
        </Button>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Disposal dialog
// ---------------------------------------------------------------------------

function DisposeDialog({
  asset, accounts, today, onClose, onDone,
}: { asset: FixedAsset; accounts: ChartOfAccount[]; today: string; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ date: today, proceeds: '', depositAccountId: '', reason: '' });
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');

  const errors = useMemo(() => validateDisposal(form, asset, today), [form, asset, today]);
  const hasErrors = Object.keys(errors).length > 0;
  const proceedsCents = form.proceeds.trim() === '' ? 0 : parseCents(form.proceeds) ?? 0;
  const preview = disposalPreview(asset, proceedsCents);

  const submit = async () => {
    setTouched(true);
    if (hasErrors || saving) return;
    setSaving(true);
    setServerError('');
    try {
      const r = await disposeAsset(asset.id, form);
      toast(r.gain_loss_cents >= 0 ? `Disposal recorded — gain of ${money(r.gain_loss_cents)}.` : `Disposal recorded — loss of ${money(-r.gain_loss_cents)}.`, 'success');
      onDone();
    } catch (e) {
      const msg = errMsg(e);
      setServerError(msg);
      toast(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell titleId="fa-dispose-title" title="Dispose of asset" subtitle={`${asset.asset_tag} · ${asset.name}`} size="md" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          This depreciates the asset through the disposal month, removes it from the books and records any gain or loss. It cannot be undone from here.
        </p>
        <Input label="Disposal date" required type="date" value={form.date} max={today} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} error={touched ? errors.date : undefined} />
        <Input label="Sale proceeds ($)" inputMode="decimal" placeholder="0.00 if scrapped" value={form.proceeds} onChange={(e) => setForm((f) => ({ ...f, proceeds: e.target.value }))} error={touched ? errors.proceeds : undefined} />
        {proceedsCents > 0 && (
          <Field id="fa-dispose-deposit" label="Deposited to" error={touched ? errors.depositAccountId : undefined}>
            <select id="fa-dispose-deposit" value={form.depositAccountId} onChange={(e) => setForm((f) => ({ ...f, depositAccountId: e.target.value }))} className={selectClass}>
              <option value="">Choose…</option>
              {accounts.filter((a) => a.type === 'asset' && a.id !== asset.asset_account_id).map((a) => <option key={a.id} value={a.id}>{acctLabel(a)}</option>)}
            </select>
          </Field>
        )}
        <Input label="Reason (optional)" value={form.reason} maxLength={120} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />

        <dl aria-live="polite" className="grid grid-cols-3 gap-3 rounded-xl border border-border bg-bg-primary p-3 text-sm">
          <div><dt className="text-xs text-text-secondary">Book value</dt><dd className="font-semibold tabular-nums text-text-primary">{money(preview.bookValueCents)}</dd></div>
          <div><dt className="text-xs text-text-secondary">Proceeds</dt><dd className="font-semibold tabular-nums text-text-primary">{money(proceedsCents)}</dd></div>
          <div>
            <dt className="text-xs text-text-secondary">{preview.gainLossCents >= 0 ? 'Est. gain' : 'Est. loss'}</dt>
            <dd className={`font-semibold tabular-nums ${preview.gainLossCents >= 0 ? 'text-success' : 'text-danger'}`}>{money(Math.abs(preview.gainLossCents))}</dd>
          </div>
        </dl>
        <p className="text-xs text-text-secondary">Estimate based on depreciation posted so far; the final figure includes the disposal month.</p>

        {serverError && <ErrorBanner message={serverError} />}
      </div>
      <div className="mt-6 flex gap-3">
        <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={onClose}>Cancel</Button>
        <Button type="button" size="sm" className="flex-1" onClick={() => void submit()} disabled={saving || (touched && hasErrors)}>
          {saving ? 'Recording…' : 'Record disposal'}
        </Button>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Schedule dialog
// ---------------------------------------------------------------------------

function ScheduleDialog({ asset, onClose }: { asset: FixedAsset; onClose: () => void }) {
  const [lines, setLines] = useState<ScheduleLine[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    setLines(null);
    try {
      setLines(await fetchSchedule(asset.id));
    } catch {
      setFailed(true);
    }
  }, [asset.id]);

  useEffect(() => { void load(); }, [load]);

  return (
    <ModalShell titleId="fa-schedule-title" title="Depreciation schedule" subtitle={`${asset.asset_tag} · ${asset.name} · ${methodLabel(asset.method)}`} size="xl" onClose={onClose}>
      {failed ? (
        <EmptyStateError icon={AlertTriangle} title="Couldn't load the schedule" description="Check your connection and try again." onRetry={() => void load()} />
      ) : lines === null ? (
        <SkeletonTable rows={6} columns={4} />
      ) : lines.length === 0 ? (
        <EmptyState icon={CalendarRange} title="No schedule" description={asset.method === 'none' ? 'This asset is not depreciated.' : 'There is nothing left to depreciate on this asset.'} />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="bg-bg-tertiary text-left text-xs uppercase tracking-wide text-text-secondary">
              <tr>
                <th scope="col" className="px-4 py-3">Month</th>
                <th scope="col" className="px-4 py-3 text-right">Depreciation</th>
                <th scope="col" className="px-4 py-3 text-right">Accumulated</th>
                <th scope="col" className="px-4 py-3 text-right">Book value</th>
                <th scope="col" className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-bg-secondary">
              {lines.map((l) => (
                <tr key={l.line_id} className={l.status === 'cancelled' ? 'opacity-50' : ''}>
                  <td className="px-4 py-2.5 text-text-primary">{formatMonth(l.period_start)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-text-primary">{money(l.amount_cents)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-text-secondary">{money(l.accumulated_cents)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-text-secondary">{money(l.book_value_cents)}</td>
                  <td className="px-4 py-2.5">
                    {l.status === 'posted' ? (
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <Pill className="bg-success/10 text-success">Posted</Pill>
                        {l.entry_number && <span className="font-mono text-xs text-text-secondary">{l.entry_number}</span>}
                        {l.entry_status === 'void' && <Pill className="bg-danger/10 text-danger">Entry voided</Pill>}
                      </span>
                    ) : l.status === 'scheduled' ? (
                      <Pill className="bg-bg-tertiary text-text-secondary">Scheduled</Pill>
                    ) : (
                      <Pill className="bg-bg-tertiary text-text-secondary">Cancelled</Pill>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-6 flex justify-end">
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>Close</Button>
      </div>
    </ModalShell>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function FixedAssetsPage() {
  const { user, profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canAccess = isOwner || permissions.can_view_billing;
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const today = useMemo(() => todayIso(), []);

  const [tab, setTab] = useState<Tab>('register');
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [runPreview, setRunPreview] = useState<RunPreviewRow[]>([]);
  const [forecast, setForecast] = useState<ForecastRow[]>([]);
  const [accounts, setAccounts] = useState<ChartOfAccount[]>([]);
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [events, setEvents] = useState<AssetEvent[] | null>(null);
  const [eventsFailed, setEventsFailed] = useState(false);

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<AssetStatus | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<AssetCategory | 'all'>('all');

  const [editor, setEditor] = useState<{ editing: FixedAsset | null; defaults?: DefaultAccounts } | null>(null);
  const [disposing, setDisposing] = useState<FixedAsset | null>(null);
  const [scheduleFor, setScheduleFor] = useState<FixedAsset | null>(null);
  const [deleting, setDeleting] = useState<FixedAsset | null>(null);
  const [confirmRun, setConfirmRun] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const loadCore = useCallback(async () => {
    if (!user || !canAccess) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const [a, r, f] = await Promise.all([fetchAssets(), fetchRunPreview(today), fetchForecast(monthStartOf(today), 12)]);
      setAssets(a);
      setRunPreview(r);
      setForecast(f);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [user, canAccess, today]);

  const loadRefs = useCallback(async () => {
    if (!user || !canAccess) return;
    try {
      const [a, v] = await Promise.all([fetchChartOfAccounts(), fetchVehicleOptions()]);
      setAccounts(a);
      setVehicles(v);
    } catch {
      /* the editor explains what to do when accounts are missing */
    }
  }, [user, canAccess]);

  const loadEvents = useCallback(async () => {
    if (!accountOwnerId || !canAccess) return;
    setEventsFailed(false);
    try {
      setEvents(await fetchAssetEvents(accountOwnerId));
    } catch {
      setEventsFailed(true);
    }
  }, [accountOwnerId, canAccess]);

  useEffect(() => { void loadCore(); }, [loadCore]);
  useEffect(() => { void loadRefs(); }, [loadRefs]);
  useEffect(() => { if (tab === 'activity') void loadEvents(); }, [tab, loadEvents]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadCore(), loadRefs(), tab === 'activity' ? loadEvents() : Promise.resolve()]);
  }, [loadCore, loadRefs, loadEvents, tab]);

  const summary = useMemo(() => summarizeAssets(assets), [assets]);
  const visible = useMemo(() => filterAssets(assets, { query, status: statusFilter, category: categoryFilter }), [assets, query, statusFilter, categoryFilter]);
  const readyRows = useMemo(() => runPreview.filter((r) => !r.is_closed), [runPreview]);
  const blockedRows = useMemo(() => runPreview.filter((r) => r.is_closed), [runPreview]);
  const readyCents = readyRows.reduce((s, r) => s + r.total_cents, 0);
  const maxForecast = Math.max(1, ...forecast.map((f) => f.scheduled_cents + f.posted_cents));

  const afterChange = async () => {
    setEditor(null);
    setDisposing(null);
    await Promise.all([loadCore(), loadRefs(), events ? loadEvents() : Promise.resolve()]);
  };

  const openNew = async () => {
    if (busy) return;
    setBusy('prep');
    try {
      const defaults = await ensureDefaultAccounts();
      setAccounts(await fetchChartOfAccounts());
      setEditor({ editing: null, defaults });
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const openEdit = (a: FixedAsset) => {
    if (accounts.length === 0) {
      toast('Accounts are still loading — try again in a moment.', 'info');
      void loadRefs();
      return;
    }
    setEditor({ editing: a });
  };

  const openDispose = (a: FixedAsset) => {
    if (accounts.length === 0) {
      toast('Accounts are still loading — try again in a moment.', 'info');
      void loadRefs();
      return;
    }
    setDisposing(a);
  };

  const postRun = async () => {
    if (busy) return;
    setBusy('run');
    try {
      const r = await runDepreciation(today);
      setConfirmRun(false);
      await Promise.all([loadCore(), events ? loadEvents() : Promise.resolve()]);
      if (r.posted_lines > 0) {
        toast(`Posted ${r.posted_lines} depreciation line${r.posted_lines === 1 ? '' : 's'} (${money(r.posted_cents)}) in ${r.entries} journal entr${r.entries === 1 ? 'y' : 'ies'}.`, 'success');
      } else {
        toast('Nothing was ready to post.', 'info');
      }
      if (r.skipped_closed_periods > 0) {
        toast(`${r.skipped_closed_periods} month${r.skipped_closed_periods === 1 ? ' was' : 's were'} skipped because the accounting period is closed.`, 'info');
      }
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const target = deleting;
    setBusy('delete');
    try {
      await deleteAsset(target.id);
      toast('Asset deleted.', 'success');
      setDeleting(null);
      await Promise.all([loadCore(), events ? loadEvents() : Promise.resolve()]);
    } catch (e) {
      toast(errMsg(e), 'error');
      setDeleting(null);
    } finally {
      setBusy(null);
    }
  };

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Fixed Assets">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">Ask your account owner for the "View Billing" permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  const rowActions = (a: FixedAsset) => (
    <div className="flex justify-end gap-1">
      <Button type="button" variant="ghost" size="sm" aria-label={`View depreciation schedule for ${a.name}`} onClick={() => setScheduleFor(a)}><CalendarRange size={14} /></Button>
      {a.status !== 'disposed' && (
        <>
          <Button type="button" variant="ghost" size="sm" aria-label={`Edit ${a.name}`} onClick={() => openEdit(a)}><Pencil size={14} /></Button>
          <Button type="button" variant="ghost" size="sm" aria-label={`Dispose of ${a.name}`} onClick={() => openDispose(a)}><Archive size={14} /></Button>
        </>
      )}
      {canDeleteAsset(a) && (
        <Button type="button" variant="ghost" size="sm" aria-label={`Delete ${a.name}`} onClick={() => setDeleting(a)}><Trash2 size={14} /></Button>
      )}
    </div>
  );

  const nextCell = (a: FixedAsset) =>
    a.status === 'disposed'
      ? `Disposed ${formatDay(a.disposed_on)}`
      : a.next_period_start && a.next_amount_cents !== null
        ? `${formatMonth(a.next_period_start)} · ${money(a.next_amount_cents)}`
        : a.method === 'none' ? 'Not depreciated' : '—';

  return (
    <DashboardLayout activeLabel="Fixed Assets">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Package size={22} /></span>
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Fixed Assets</h1>
            <p className="text-sm text-text-secondary">Track vehicles, tools and equipment, and post monthly depreciation straight to your ledger.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void refreshAll()} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </Button>
          {!loadFailed && (
            <Button type="button" size="sm" onClick={() => void openNew()} disabled={busy === 'prep'}>
              <Plus size={14} /> {busy === 'prep' ? 'Preparing…' : 'New asset'}
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <SkeletonCardList count={3} rows={3} />
      ) : loadFailed ? (
        <EmptyStateError icon={AlertTriangle} title="Couldn't load fixed assets" description="Check your connection and try again." onRetry={() => void loadCore()} />
      ) : (
        <FadeIn>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Total cost" value={money(summary.costCents)} sub={`${summary.count} asset${summary.count === 1 ? '' : 's'}${summary.disposed ? ` · ${summary.disposed} disposed` : ''}`} />
            <Stat label="Accumulated depreciation" value={money(summary.accumulatedCents)} sub={summary.fullyDepreciated ? `${summary.fullyDepreciated} fully depreciated` : undefined} />
            <Stat label="Net book value" value={money(summary.netBookValueCents)} />
            <Stat label="Ready to post" value={money(readyCents)} sub={readyRows.length ? `${readyRows.length} month${readyRows.length === 1 ? '' : 's'} due` : 'Up to date'} />
          </div>

          <div role="tablist" aria-label="Fixed asset sections" className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
            {TABS.map((t) => (
              <button
                key={t.id} type="button" role="tab" aria-selected={tab === t.id} id={`fa-tab-${t.id}`} aria-controls={`fa-panel-${t.id}`}
                onClick={() => setTab(t.id)}
                className={`focus-ring shrink-0 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors ${tab === t.id ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'}`}
              >
                {t.label}
                {t.id === 'depreciation' && readyRows.length > 0 && <span className="ml-1.5 rounded-full bg-warning-500/20 px-1.5 text-[11px] font-semibold text-warning-500">{readyRows.length}</span>}
              </button>
            ))}
          </div>

          {/* ------------------------------ REGISTER ------------------------------ */}
          {tab === 'register' && (
            <section role="tabpanel" id="fa-panel-register" aria-labelledby="fa-tab-register">
              {assets.length === 0 ? (
                <EmptyState
                  icon={Package}
                  title="No fixed assets yet"
                  description="Add the vehicles, tools and equipment you own. Vireek builds the depreciation schedule and posts it to your books each month."
                  action={{ label: busy === 'prep' ? 'Preparing…' : 'Add your first asset', onClick: () => void openNew() }}
                />
              ) : (
                <>
                  <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
                    <div className="lg:w-72">
                      <Input icon={Search} placeholder="Search name, tag, serial or location" aria-label="Search assets" value={query} onChange={(e) => setQuery(e.target.value)} />
                    </div>
                    <div className="flex flex-1 flex-wrap items-center gap-2">
                      {STATUS_FILTERS.map((s) => (
                        <button
                          key={s.id} type="button" aria-pressed={statusFilter === s.id} onClick={() => setStatusFilter(s.id)}
                          className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${statusFilter === s.id ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
                        >
                          {s.label}
                        </button>
                      ))}
                      <select
                        aria-label="Filter by category" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value as AssetCategory | 'all')}
                        className="focus-ring ml-auto rounded-xl border border-border bg-bg-primary px-3 py-1.5 text-xs text-text-primary"
                      >
                        <option value="all">All categories</option>
                        {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                    </div>
                  </div>

                  {visible.length === 0 ? (
                    <EmptyState icon={Search} title="No assets match" description="Try a different search or filter." action={{ label: 'Clear filters', onClick: () => { setQuery(''); setStatusFilter('all'); setCategoryFilter('all'); } }} />
                  ) : (
                    <>
                      <div className="hidden overflow-x-auto rounded-2xl border border-border md:block">
                        <table className="w-full text-sm">
                          <thead className="bg-bg-tertiary text-left text-xs uppercase tracking-wide text-text-secondary">
                            <tr>
                              <th scope="col" className="px-4 py-3">Asset</th>
                              <th scope="col" className="px-4 py-3 text-right">Cost</th>
                              <th scope="col" className="px-4 py-3 text-right">Accumulated</th>
                              <th scope="col" className="px-4 py-3 text-right">Book value</th>
                              <th scope="col" className="px-4 py-3">Next depreciation</th>
                              <th scope="col" className="px-4 py-3">Status</th>
                              <th scope="col" className="px-4 py-3 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border bg-bg-secondary">
                            {visible.map((a) => (
                              <tr key={a.id} className={a.status === 'disposed' ? 'opacity-70' : ''}>
                                <td className="px-4 py-3">
                                  <p className="font-medium text-text-primary">{a.name}</p>
                                  <p className="text-xs text-text-secondary">
                                    <span className="font-mono">{a.asset_tag}</span> · {categoryMeta(a.category).label}{a.location ? ` · ${a.location}` : ''}
                                  </p>
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums text-text-primary">{money(a.cost_cents)}</td>
                                <td className="px-4 py-3 text-right tabular-nums text-text-secondary">{money(a.accumulated_cents)}</td>
                                <td className="px-4 py-3 text-right tabular-nums text-text-primary">{money(bookValue(a))}</td>
                                <td className="px-4 py-3 text-xs text-text-secondary">{nextCell(a)}</td>
                                <td className="px-4 py-3"><Pill className={STATUS_BADGE[a.status]}>{STATUS_LABEL[a.status]}</Pill></td>
                                <td className="px-4 py-3">{rowActions(a)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <ul className="space-y-3 md:hidden">
                        {visible.map((a) => (
                          <li key={a.id} className={a.status === 'disposed' ? 'opacity-70' : ''}>
                            <Card className="!p-4">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="truncate font-medium text-text-primary">{a.name}</p>
                                  <p className="text-xs text-text-secondary"><span className="font-mono">{a.asset_tag}</span> · {categoryMeta(a.category).label}</p>
                                </div>
                                <Pill className={STATUS_BADGE[a.status]}>{STATUS_LABEL[a.status]}</Pill>
                              </div>
                              <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                                <div><dt className="text-xs text-text-secondary">Cost</dt><dd className="tabular-nums text-text-primary">{money(a.cost_cents)}</dd></div>
                                <div><dt className="text-xs text-text-secondary">Accumulated</dt><dd className="tabular-nums text-text-secondary">{money(a.accumulated_cents)}</dd></div>
                                <div><dt className="text-xs text-text-secondary">Book value</dt><dd className="tabular-nums text-text-primary">{money(bookValue(a))}</dd></div>
                              </dl>
                              <p className="mt-2 text-xs text-text-secondary">{nextCell(a)}</p>
                              <div className="mt-2 border-t border-border pt-2">{rowActions(a)}</div>
                            </Card>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </section>
          )}

          {/* ---------------------------- DEPRECIATION ---------------------------- */}
          {tab === 'depreciation' && (
            <section role="tabpanel" id="fa-panel-depreciation" aria-labelledby="fa-tab-depreciation" className="space-y-6">
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-text-primary">Ready to post</h2>
                    <p className="text-sm text-text-secondary">Months that have ended and are not yet in your ledger. One journal entry is created per month.</p>
                  </div>
                  <Button type="button" size="sm" onClick={() => setConfirmRun(true)} disabled={readyRows.length === 0 || !!busy}>
                    <Play size={14} /> Post depreciation
                  </Button>
                </div>
                {runPreview.length === 0 ? (
                  <p className="mt-4 rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary">You're up to date. Nothing is waiting to be posted.</p>
                ) : (
                  <div className="mt-4 overflow-x-auto rounded-xl border border-border">
                    <table className="w-full min-w-[420px] text-sm">
                      <thead className="bg-bg-tertiary text-left text-xs uppercase tracking-wide text-text-secondary">
                        <tr>
                          <th scope="col" className="px-4 py-2.5">Month</th>
                          <th scope="col" className="px-4 py-2.5 text-right">Assets</th>
                          <th scope="col" className="px-4 py-2.5 text-right">Amount</th>
                          <th scope="col" className="px-4 py-2.5">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border bg-bg-secondary">
                        {runPreview.map((r) => (
                          <tr key={r.period_start}>
                            <td className="px-4 py-2.5 text-text-primary">{formatMonth(r.period_start)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-text-secondary">{r.asset_count}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-text-primary">{money(r.total_cents)}</td>
                            <td className="px-4 py-2.5">{r.is_closed ? <Pill className="bg-warning-500/10 text-warning-500">Period closed</Pill> : <Pill className="bg-success/10 text-success">Ready</Pill>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {blockedRows.length > 0 && (
                  <p className="mt-3 flex items-start gap-2 text-xs text-text-secondary">
                    <Lock size={14} className="mt-0.5 shrink-0" />
                    <span>{blockedRows.length} month{blockedRows.length === 1 ? ' is' : 's are'} in a closed accounting period and will be skipped. Reopen the period in Chart of Accounts to post {blockedRows.length === 1 ? 'it' : 'them'}.</span>
                  </p>
                )}
              </Card>

              <Card>
                <h2 className="text-base font-semibold text-text-primary">Next 12 months</h2>
                <p className="text-sm text-text-secondary">Depreciation expense by month, from posted entries and the remaining schedule.</p>
                <div className="mt-2 flex gap-4 text-xs text-text-secondary">
                  <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-success" />Posted</span>
                  <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent" />Scheduled</span>
                </div>
                {forecast.every((f) => f.scheduled_cents + f.posted_cents === 0) ? (
                  <p className="mt-4 rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary">No depreciation is scheduled for the next 12 months.</p>
                ) : (
                  <ul className="mt-4 space-y-2">
                    {forecast.map((f) => {
                      const total = f.scheduled_cents + f.posted_cents;
                      return (
                        <li key={f.period_start} className="flex items-center gap-3 text-sm">
                          <span className="w-20 shrink-0 text-xs text-text-secondary">{formatMonth(f.period_start)}</span>
                          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-bg-tertiary" role="img" aria-label={`${formatMonth(f.period_start)}: ${money(total)}`}>
                            <div className="flex h-full" style={{ width: `${(total / maxForecast) * 100}%` }}>
                              <div className="h-full bg-success" style={{ width: total ? `${(f.posted_cents / total) * 100}%` : '0%' }} />
                              <div className="h-full flex-1 bg-accent" />
                            </div>
                          </div>
                          <span className="w-24 shrink-0 text-right tabular-nums text-text-primary">{money(total)}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            </section>
          )}

          {/* ------------------------------ ACTIVITY ------------------------------ */}
          {tab === 'activity' && (
            <section role="tabpanel" id="fa-panel-activity" aria-labelledby="fa-tab-activity">
              {eventsFailed ? (
                <EmptyStateError icon={AlertTriangle} title="Couldn't load activity" description="Check your connection and try again." onRetry={() => void loadEvents()} />
              ) : events === null ? (
                <SkeletonTable rows={5} columns={2} />
              ) : events.length === 0 ? (
                <EmptyState icon={CalendarRange} title="No activity yet" description="Adding, editing, disposing of assets and depreciation runs are recorded here." />
              ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-bg-secondary">
                  {events.map((e) => (
                    <li key={e.id} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-sm text-text-primary">{describeEvent(e)}</span>
                      <time dateTime={e.created_at} className="text-xs text-text-secondary">{new Date(e.created_at).toLocaleString()}</time>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </FadeIn>
      )}

      {editor && (
        <AssetEditor
          editing={editor.editing} defaults={editor.defaults} assets={assets} accounts={accounts} vehicles={vehicles} today={today}
          onClose={() => setEditor(null)} onSaved={() => void afterChange()}
        />
      )}
      {disposing && <DisposeDialog asset={disposing} accounts={accounts} today={today} onClose={() => setDisposing(null)} onDone={() => void afterChange()} />}
      {scheduleFor && <ScheduleDialog asset={scheduleFor} onClose={() => setScheduleFor(null)} />}

      {confirmRun && (
        <ModalShell titleId="fa-run-title" title="Post depreciation" subtitle="This creates journal entries in your general ledger." size="md" onClose={() => setConfirmRun(false)}>
          <p className="text-sm text-text-secondary">
            {readyRows.length} month{readyRows.length === 1 ? '' : 's'} totalling <strong className="text-text-primary">{money(readyCents)}</strong> will be posted:
            Dr Depreciation Expense, Cr Accumulated Depreciation. Months in closed periods are skipped.
          </p>
          <div className="mt-6 flex gap-3">
            <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={() => setConfirmRun(false)} disabled={busy === 'run'}>Cancel</Button>
            <Button type="button" size="sm" className="flex-1" onClick={() => void postRun()} disabled={busy === 'run'}>{busy === 'run' ? 'Posting…' : 'Post now'}</Button>
          </div>
        </ModalShell>
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Delete this asset?"
        description={deleting ? `${deleting.asset_tag} · ${deleting.name} and its unposted schedule will be removed. Assets with ledger entries can't be deleted.` : ''}
        confirmLabel="Delete asset"
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </DashboardLayout>
  );
}
