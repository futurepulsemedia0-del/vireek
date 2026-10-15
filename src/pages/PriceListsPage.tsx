/**
 * Price Lists — /dashboard/price-lists
 *
 * Per-customer, per-contract and tier (commercial / membership / contractor)
 * price lists that override the Live Price Book inside an effective date
 * window. Resolution is deterministic and disclosed — see src/lib/priceLists.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  Archive,
  Calculator,
  Check,
  ChevronDown,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { formatCents, formatItemPrice, type PriceBookItem } from '@/lib/priceBook';
import {
  ADJUSTMENT_LABELS,
  PRICE_LIST_ASSUMPTIONS,
  SCOPE_LABELS,
  STATE_LABELS,
  TIER_LABELS,
  adjustmentValueToInput,
  applyAdjustment,
  buildPricingContext,
  deletePriceList,
  deletePriceListItem,
  describeAdjustment,
  emptyPriceListForm,
  fetchCustomerNames,
  fetchPriceBook,
  fetchPriceListData,
  fetchReferenceOptions,
  findConflictingListIds,
  formToListPayload,
  formatDateRange,
  getListState,
  isEndingSoon,
  isIsoDate,
  listToForm,
  parseAdjustmentValue,
  resolvePrice,
  savePriceList,
  searchCustomers,
  setPriceListStatus,
  todayIso,
  upsertPriceListItem,
  type AdjustmentType,
  type PriceList,
  type PriceListFormState,
  type PriceListItem,
  type PriceListScope,
  type PriceListState,
  type PriceListTier,
  type RefOption,
  type ResolvedPrice,
} from '@/lib/priceLists';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:opacity-50';
const labelClass = 'mb-1.5 block text-sm font-medium text-text-primary';
const iconBtn =
  'focus-ring flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-40';

const STATE_STYLES: Record<PriceListState, string> = {
  active: 'bg-success/15 text-success',
  scheduled: 'bg-accent/10 text-accent',
  draft: 'bg-bg-tertiary text-text-secondary',
  expired: 'bg-warning-500/15 text-warning-500',
  archived: 'bg-bg-tertiary text-text-secondary opacity-70',
};
const STATE_ORDER: PriceListState[] = ['active', 'scheduled', 'draft', 'expired', 'archived'];

const errMsg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** Shows a service price the same way the Price Book does, collapsing a flat range. */
function formatResolved(book: PriceBookItem, priceCents: number, priceMaxCents: number | null): string {
  const collapsed = priceMaxCents !== null && priceMaxCents === priceCents && book.pricing_model === 'range';
  return formatItemPrice({
    pricing_model: collapsed ? 'flat' : book.pricing_model,
    price_cents: priceCents,
    price_max_cents: priceMaxCents,
    unit_label: book.unit_label,
  });
}

// ============================================================
// Customer picker (debounced server search — accounts can have thousands)
// ============================================================

function CustomerPicker({
  ownerId,
  label,
  value,
  onChange,
}: {
  ownerId: string;
  label: string;
  value: RefOption | null;
  onChange: (next: RefOption | null) => void;
}) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<RefOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const rows = await searchCustomers(ownerId, term);
        if (!cancelled) {
          setResults(rows);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, open, ownerId]);

  if (value) {
    return (
      <div>
        <span className={labelClass}>{label}</span>
        <div className="flex min-h-[48px] items-center justify-between gap-2 rounded-xl border border-border bg-bg-primary px-4 py-2">
          <span className="truncate text-sm text-text-primary">{value.label}</span>
          <button type="button" onClick={() => onChange(null)} className={iconBtn} aria-label="Clear customer">
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <Input
        label={label}
        value={term}
        placeholder="Search by name or phone"
        autoComplete="off"
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      />
      {open && (
        <div className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-border bg-bg-secondary shadow-lg" role="listbox">
          {loading && results.length === 0 ? (
            <p className="px-4 py-3 text-sm text-text-secondary">Searching…</p>
          ) : failed ? (
            <p className="px-4 py-3 text-sm text-danger">Couldn’t search customers. Try again.</p>
          ) : results.length === 0 ? (
            <p className="px-4 py-3 text-sm text-text-secondary">No matching customers</p>
          ) : (
            results.map((r) => (
              <button
                key={r.id}
                type="button"
                role="option"
                aria-selected={false}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(r);
                  setTerm('');
                  setOpen(false);
                }}
                className="block min-h-[44px] w-full truncate px-4 py-2.5 text-left text-sm text-text-primary hover:bg-bg-tertiary"
              >
                {r.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Create / edit form
// ============================================================

function PriceListForm({
  ownerId,
  initial,
  initialCustomer,
  contracts,
  plans,
  onCancel,
  onSave,
}: {
  ownerId: string;
  initial: PriceListFormState;
  initialCustomer: RefOption | null;
  contracts: RefOption[];
  plans: RefOption[];
  onCancel: () => void;
  onSave: (payload: ReturnType<typeof formToListPayload>) => Promise<boolean>;
}) {
  const [form, setForm] = useState(initial);
  const [customer, setCustomer] = useState<RefOption | null>(initialCustomer);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof PriceListFormState>(key: K, value: PriceListFormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const handleSave = async () => {
    let payload: ReturnType<typeof formToListPayload>;
    try {
      payload = formToListPayload({ ...form, customer_id: customer?.id ?? '' }, ownerId);
    } catch (e) {
      setError(errMsg(e, 'Check the form and try again.'));
      return;
    }
    setError(null);
    setSaving(true);
    const ok = await onSave(payload);
    setSaving(false);
    if (!ok) setError('Couldn’t save — see the message above and try again.');
  };

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <Input label="Name" required value={form.name} maxLength={120} placeholder="e.g. Acme Property Group — 2027 rates" onChange={(e) => set('name', e.target.value)} />

      <div>
        <span className={labelClass}>Applies to</span>
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(SCOPE_LABELS) as PriceListScope[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => set('scope', s)}
              aria-pressed={form.scope === s}
              className={`focus-ring min-h-[44px] rounded-xl border px-3 text-sm font-medium transition-colors ${
                form.scope === s ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
              }`}
            >
              {SCOPE_LABELS[s]}
            </button>
          ))}
        </div>
      </div>

      {form.scope === 'customer' && <CustomerPicker ownerId={ownerId} label="Customer" value={customer} onChange={setCustomer} />}

      {form.scope === 'contract' && (
        <div>
          <label htmlFor="pl-contract" className={labelClass}>Contract</label>
          <select id="pl-contract" value={form.contract_id} onChange={(e) => set('contract_id', e.target.value)} className={selectClass}>
            <option value="">Choose a contract…</option>
            {contracts.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
          {contracts.length === 0 && <p className="mt-1.5 text-xs text-text-secondary">Create a commercial contract first, then price it here.</p>}
        </div>
      )}

      {form.scope === 'tier' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="pl-tier" className={labelClass}>Tier</label>
            <select id="pl-tier" value={form.tier} onChange={(e) => set('tier', e.target.value as PriceListTier)} className={selectClass}>
              {(Object.keys(TIER_LABELS) as PriceListTier[]).map((t) => (
                <option key={t} value={t}>{TIER_LABELS[t]}</option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-text-secondary">
              {form.tier === 'commercial' && 'Customers marked Commercial.'}
              {form.tier === 'membership' && 'Customers with an active membership.'}
              {form.tier === 'contractor' && `Customers tagged “${PRICE_LIST_ASSUMPTIONS.contractorTag}”.`}
            </p>
          </div>
          {form.tier === 'membership' && (
            <div>
              <label htmlFor="pl-plan" className={labelClass}>Membership plan</label>
              <select id="pl-plan" value={form.membership_plan_id} onChange={(e) => set('membership_plan_id', e.target.value)} className={selectClass}>
                <option value="">Any active membership</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="Effective from" type="date" required value={form.effective_from} onChange={(e) => set('effective_from', e.target.value)} />
        <Input label="Effective to" type="date" value={form.effective_to} helperText="Leave empty for open-ended" onChange={(e) => set('effective_to', e.target.value)} />
        <Input
          label="Priority"
          type="number"
          inputMode="numeric"
          min={0}
          max={PRICE_LIST_ASSUMPTIONS.maxPriority}
          value={form.priority}
          helperText="Higher wins within the same type"
          onChange={(e) => set('priority', e.target.value)}
        />
      </div>

      <Textarea label="Notes (optional)" rows={2} value={form.description} maxLength={1000} placeholder="Terms, who approved it, renewal notes…" onChange={(e) => set('description', e.target.value)} />

      {error && (
        <p role="alert" className="text-sm text-danger">{error}</p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button type="button" size="sm" onClick={handleSave} disabled={saving}>
          <Check size={14} /> {saving ? 'Saving…' : 'Save price list'}
        </Button>
      </div>
    </div>
  );
}

// ============================================================
// Per-list service overrides
// ============================================================

function ListItemsEditor({
  list,
  ownerId,
  book,
  items,
  onChanged,
}: {
  list: PriceList;
  ownerId: string;
  book: PriceBookItem[];
  items: PriceListItem[];
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const bookById = useMemo(() => new Map(book.map((b) => [b.id, b])), [book]);
  const [serviceId, setServiceId] = useState('');
  const [type, setType] = useState<AdjustmentType>('percent_off');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const usedIds = useMemo(() => new Set(items.map((i) => i.price_book_item_id)), [items]);
  const available = useMemo(() => book.filter((b) => editing || !usedIds.has(b.id)), [book, usedIds, editing]);

  const selected = bookById.get(serviceId) ?? null;
  const preview = useMemo(() => {
    if (!selected || !value.trim()) return null;
    try {
      const adj = applyAdjustment(selected, type, parseAdjustmentValue(type, value));
      return { text: formatResolved(selected, adj.price_cents, adj.price_max_cents), belowCost: selected.cost_cents !== null && adj.price_cents < selected.cost_cents };
    } catch {
      return null;
    }
  }, [selected, type, value]);

  const reset = () => {
    setServiceId('');
    setValue('');
    setType('percent_off');
    setEditing(false);
  };

  const handleSave = async () => {
    if (!serviceId) return;
    let parsed: number;
    try {
      parsed = parseAdjustmentValue(type, value);
    } catch (e) {
      toast(errMsg(e, 'Enter a valid amount.'), 'error');
      return;
    }
    setSaving(true);
    try {
      await upsertPriceListItem({ accountOwnerId: ownerId, priceListId: list.id, priceBookItemId: serviceId, adjustmentType: type, value: parsed });
      await onChanged();
      toast(editing ? 'Override updated' : 'Override added', 'success');
      reset();
    } catch (e) {
      toast(errMsg(e, 'Could not save this override'), 'error');
    }
    setSaving(false);
  };

  const handleRemove = async (item: PriceListItem) => {
    setBusyId(item.id);
    try {
      await deletePriceListItem(item.id, ownerId);
      await onChanged();
      toast('Override removed', 'success');
    } catch (e) {
      toast(errMsg(e, 'Could not remove this override'), 'error');
    }
    setBusyId(null);
  };

  const startEdit = (item: PriceListItem) => {
    setServiceId(item.price_book_item_id);
    setType(item.adjustment_type);
    setValue(adjustmentValueToInput(item.adjustment_type, item.value));
    setEditing(true);
  };

  return (
    <div className="mt-4 border-t border-border pt-4">
      <p className="mb-3 text-xs text-text-secondary">
        Services without an override keep their Price Book price. {items.length} override{items.length === 1 ? '' : 's'} in this list.
      </p>

      {items.length > 0 && (
        <ul className="mb-4 space-y-2">
          {items.map((item) => {
            const b = bookById.get(item.price_book_item_id);
            const adj = b ? applyAdjustment(b, item.adjustment_type, item.value) : null;
            const belowCost = b && adj ? b.cost_cents !== null && adj.price_cents < b.cost_cents : false;
            return (
              <li key={item.id} className="flex flex-col gap-2 rounded-xl border border-border bg-bg-primary p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">{b ? b.service_name : 'Service no longer in the price book'}</p>
                  <p className="text-xs text-text-secondary">
                    {b ? `Book ${formatItemPrice(b)}` : 'Inactive or removed'} · {describeAdjustment(item.adjustment_type, item.value)}
                  </p>
                </div>
                <div className="flex items-center justify-between gap-2 sm:justify-end">
                  <div className="text-right">
                    <p className="text-sm font-semibold text-text-primary">{b && adj ? formatResolved(b, adj.price_cents, adj.price_max_cents) : '—'}</p>
                    {belowCost && (
                      <p className="flex items-center justify-end gap-1 text-[11px] font-medium text-danger">
                        <AlertTriangle size={11} /> Below your cost
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0">
                    <button type="button" onClick={() => startEdit(item)} disabled={!b || busyId === item.id} className={iconBtn} aria-label="Edit override">
                      <Pencil size={14} />
                    </button>
                    <button type="button" onClick={() => void handleRemove(item)} disabled={busyId === item.id} className={`${iconBtn} hover:!bg-danger/10 hover:!text-danger`} aria-label="Remove override">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {book.length === 0 ? (
        <p className="text-sm text-text-secondary">Add services to your Price Book first — lists override those prices.</p>
      ) : (
        <div className="space-y-3 rounded-xl border border-dashed border-border p-3">
          <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr_1fr]">
            <div>
              <label htmlFor={`svc-${list.id}`} className={labelClass}>Service</label>
              <select id={`svc-${list.id}`} value={serviceId} disabled={editing} onChange={(e) => setServiceId(e.target.value)} className={selectClass}>
                <option value="">Choose a service…</option>
                {available.map((b) => (
                  <option key={b.id} value={b.id}>{b.service_name} — {formatItemPrice(b)}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`adj-${list.id}`} className={labelClass}>Override</label>
              <select id={`adj-${list.id}`} value={type} onChange={(e) => setType(e.target.value as AdjustmentType)} className={selectClass}>
                {(Object.keys(ADJUSTMENT_LABELS) as AdjustmentType[]).map((t) => (
                  <option key={t} value={t}>{ADJUSTMENT_LABELS[t]}</option>
                ))}
              </select>
            </div>
            <Input
              label={type === 'percent_off' || type === 'percent_up' ? 'Percent' : 'Amount ($)'}
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>

          {preview && (
            <p className="text-sm text-text-secondary">
              Customer price becomes <span className="font-semibold text-text-primary">{preview.text}</span>
              {preview.belowCost && <span className="ml-2 font-medium text-danger">— below your cost</span>}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {(editing || serviceId || value) && (
              <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={saving}>Cancel</Button>
            )}
            <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving || !serviceId || !value.trim()}>
              <Plus size={14} /> {saving ? 'Saving…' : editing ? 'Update override' : 'Add override'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Price check — "what would this customer pay on this date?"
// ============================================================

function PriceCheck({
  ownerId,
  book,
  lists,
  items,
  today,
}: {
  ownerId: string;
  book: PriceBookItem[];
  lists: PriceList[];
  items: PriceListItem[];
  today: string;
}) {
  const [open, setOpen] = useState(false);
  const [customer, setCustomer] = useState<RefOption | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [on, setOn] = useState(today);
  const [result, setResult] = useState<{ item: PriceBookItem; resolved: ResolvedPrice } | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const seq = useRef(0);

  useEffect(() => {
    if (!open) return;
    const item = book.find((b) => b.id === serviceId);
    if (!customer || !item || !isIsoDate(on)) {
      setResult(null);
      setStatus('idle');
      return;
    }
    const mine = ++seq.current;
    setStatus('loading');
    buildPricingContext(ownerId, customer.id, on)
      .then((ctx) => {
        if (mine !== seq.current) return;
        setResult({ item, resolved: resolvePrice(item, lists, items, ctx, on) });
        setStatus('idle');
      })
      .catch(() => {
        if (mine !== seq.current) return;
        setResult(null);
        setStatus('error');
      });
  }, [open, customer, serviceId, on, book, lists, items, ownerId]);

  const r = result?.resolved ?? null;

  return (
    <div className="mb-4 rounded-2xl border border-border bg-bg-secondary">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="focus-ring flex min-h-[52px] w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Calculator size={16} className="text-accent" /> Price check
          <span className="hidden text-xs font-normal text-text-secondary sm:inline">— see exactly what a customer would be quoted</span>
        </span>
        <ChevronDown size={16} className={`shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="space-y-4 border-t border-border p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <CustomerPicker ownerId={ownerId} label="Customer" value={customer} onChange={setCustomer} />
            <div>
              <label htmlFor="pc-service" className={labelClass}>Service</label>
              <select id="pc-service" value={serviceId} onChange={(e) => setServiceId(e.target.value)} className={selectClass}>
                <option value="">Choose a service…</option>
                {book.map((b) => (
                  <option key={b.id} value={b.id}>{b.service_name}</option>
                ))}
              </select>
            </div>
            <Input label="Pricing date" type="date" value={on} onChange={(e) => setOn(e.target.value)} />
          </div>

          {status === 'loading' && <p className="text-sm text-text-secondary">Calculating…</p>}
          {status === 'error' && <p role="alert" className="text-sm text-danger">Couldn’t look up this customer’s pricing. Try again.</p>}
          {!customer || !serviceId ? (
            <p className="text-xs text-text-secondary">Pick a customer and a service. Contract lists apply when the customer has an active contract on that date.</p>
          ) : (
            r && result && status === 'idle' && (
              <div className="rounded-xl border border-border bg-bg-primary p-4">
                <p className="text-2xl font-bold text-text-primary">{formatResolved(result.item, r.price_cents, r.price_max_cents)}</p>
                <p className="mt-1 text-sm text-text-secondary">
                  {r.source === 'price_list' && r.list
                    ? `From “${r.list.name}” (${SCOPE_LABELS[r.list.scope]} list) — Price Book is ${formatItemPrice(result.item)}`
                    : 'Standard Price Book price — no active list applies to this customer on that date.'}
                </p>
                {r.savings_cents !== 0 && (
                  <p className="mt-1 text-xs font-medium text-text-secondary">
                    {r.savings_cents > 0 ? `Saves the customer ${formatCents(r.savings_cents)}` : `${formatCents(-r.savings_cents)} above the Price Book`}
                  </p>
                )}
                {r.below_cost && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-danger">
                    <AlertTriangle size={12} /> This price is below your recorded cost.
                  </p>
                )}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Page
// ============================================================

export function PriceListsPage() {
  const { profile, teamMember, isOwner, permissions, profileLoading } = useAuth();
  const { toast } = useToast();

  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const canManage = isOwner || permissions.can_view_billing;
  const today = useMemo(() => todayIso(), []);

  const [lists, setLists] = useState<PriceList[]>([]);
  const [listItems, setListItems] = useState<PriceListItem[]>([]);
  const [book, setBook] = useState<PriceBookItem[]>([]);
  const [contracts, setContracts] = useState<RefOption[]>([]);
  const [plans, setPlans] = useState<RefOption[]>([]);
  const [customerNames, setCustomerNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<'all' | PriceListState>('all');
  const [scopeFilter, setScopeFilter] = useState<'all' | PriceListScope>('all');
  const loadSeq = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      if (!ownerId) return;
      const mine = ++loadSeq.current;
      if (!silent) setLoading(true);
      try {
        const [data, bookItems, refs] = await Promise.all([fetchPriceListData(ownerId), fetchPriceBook(ownerId), fetchReferenceOptions(ownerId)]);
        const names = await fetchCustomerNames(ownerId, Array.from(new Set(data.lists.map((l) => l.customer_id).filter((id): id is string => Boolean(id)))));
        if (mine !== loadSeq.current) return;
        setLists(data.lists);
        setListItems(data.items);
        setBook(bookItems);
        setContracts(refs.contracts);
        setPlans(refs.plans);
        setCustomerNames(names);
        setLoadError(null);
      } catch (e) {
        if (mine !== loadSeq.current) return;
        setLoadError(errMsg(e, 'Could not load your price lists'));
      }
      if (mine === loadSeq.current) setLoading(false);
    },
    [ownerId],
  );

  useEffect(() => {
    if (ownerId && canManage) void load();
    else if (!profileLoading) setLoading(false);
  }, [ownerId, canManage, profileLoading, load]);

  const contractLabel = useMemo(() => new Map(contracts.map((c) => [c.id, c.label])), [contracts]);
  const planLabel = useMemo(() => new Map(plans.map((p) => [p.id, p.label])), [plans]);
  const itemCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of listItems) m.set(i.price_list_id, (m.get(i.price_list_id) ?? 0) + 1);
    return m;
  }, [listItems]);
  const conflicts = useMemo(() => findConflictingListIds(lists), [lists]);

  const targetLabel = (l: PriceList): string => {
    if (l.scope === 'customer') return (l.customer_id && customerNames[l.customer_id]) || 'Customer';
    if (l.scope === 'contract') return (l.contract_id && contractLabel.get(l.contract_id)) || 'Contract';
    const tier = l.tier ? TIER_LABELS[l.tier] : 'Tier';
    return l.membership_plan_id ? `${tier} · ${planLabel.get(l.membership_plan_id) ?? 'plan'}` : `${tier} tier`;
  };

  const stateOf = useCallback((l: PriceList) => getListState(l, today), [today]);

  const counts = useMemo(() => {
    const c: Record<PriceListState, number> = { active: 0, scheduled: 0, draft: 0, expired: 0, archived: 0 };
    for (const l of lists) c[stateOf(l)]++;
    return c;
  }, [lists, stateOf]);
  const endingSoon = useMemo(() => lists.filter((l) => isEndingSoon(l, today)).length, [lists, today]);

  const visible = useMemo(
    () =>
      lists
        .filter((l) => (stateFilter === 'all' || stateOf(l) === stateFilter) && (scopeFilter === 'all' || l.scope === scopeFilter))
        .sort((a, b) => STATE_ORDER.indexOf(stateOf(a)) - STATE_ORDER.indexOf(stateOf(b)) || b.updated_at.localeCompare(a.updated_at)),
    [lists, stateFilter, scopeFilter, stateOf],
  );

  const handleSave = async (payload: ReturnType<typeof formToListPayload>, id?: string): Promise<boolean> => {
    try {
      const savedId = await savePriceList(payload, id);
      toast(id ? 'Price list saved' : 'Price list created — add overrides, then activate it.', 'success');
      setCreating(false);
      setEditingId(null);
      if (!id) setOpenId(savedId);
      await load(true);
      return true;
    } catch (e) {
      toast(errMsg(e, 'Could not save this price list'), 'error');
      return false;
    }
  };

  const changeStatus = async (l: PriceList, status: PriceList['status']) => {
    if (!ownerId) return;
    setBusyId(l.id);
    try {
      await setPriceListStatus(l.id, ownerId, status);
      setLists((prev) => prev.map((x) => (x.id === l.id ? { ...x, status } : x)));
      toast(status === 'active' ? 'Price list activated' : status === 'archived' ? 'Price list archived' : 'Price list set to draft', 'success');
    } catch (e) {
      toast(errMsg(e, 'Could not update this price list'), 'error');
    }
    setBusyId(null);
  };

  const handleDelete = async () => {
    if (!deletingId || !ownerId) return;
    try {
      await deletePriceList(deletingId, ownerId);
      setLists((prev) => prev.filter((l) => l.id !== deletingId));
      setListItems((prev) => prev.filter((i) => i.price_list_id !== deletingId));
      toast('Price list deleted', 'success');
    } catch (e) {
      toast(errMsg(e, 'Could not delete this price list'), 'error');
    }
    setDeletingId(null);
  };

  const header = (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Tags size={20} />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Price Lists</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Negotiated and tiered pricing that overrides your Price Book for a customer, a contract, or a whole tier — inside an effective date window.
          </p>
        </div>
      </div>
      {canManage && ownerId && !loadError && (
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => void load(true)} aria-label="Refresh price lists">
            <RefreshCw size={14} />
          </Button>
          {!creating && (
            <Button type="button" size="sm" onClick={() => { setCreating(true); setEditingId(null); }}>
              <Plus size={14} /> New price list
            </Button>
          )}
        </div>
      )}
    </div>
  );

  // ---- permission gate ----
  if (!profileLoading && (!canManage || !ownerId)) {
    return (
      <DashboardLayout activeLabel="Price Lists">
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
          {header}
          <EmptyState
            icon={ShieldAlert}
            title="You don’t have access to price lists"
            description="Price lists contain negotiated rates. Ask an account owner to grant you billing access."
          />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Price Lists">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        {header}

        {loading || profileLoading ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} rows={2} />
          </div>
        ) : loadError ? (
          <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/5 p-6 text-center">
            <p className="text-sm font-medium text-text-primary">We couldn’t load your price lists.</p>
            <p className="mt-1 text-xs text-text-secondary">{loadError}</p>
            <Button type="button" size="sm" className="mt-4" onClick={() => void load()}>
              <RefreshCw size={14} /> Try again
            </Button>
          </div>
        ) : (
          ownerId && (
            <>
              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: 'Active now', value: counts.active },
                  { label: 'Scheduled', value: counts.scheduled },
                  { label: `Ending in ${PRICE_LIST_ASSUMPTIONS.endingSoonDays}d`, value: endingSoon },
                  { label: 'Need review', value: conflicts.size },
                ].map((s) => (
                  <div key={s.label} className="rounded-2xl border border-border bg-bg-secondary p-4 text-center">
                    <p className="text-xl font-bold text-text-primary">{s.value}</p>
                    <p className="text-xs text-text-secondary">{s.label}</p>
                  </div>
                ))}
              </div>

              {conflicts.size > 0 && (
                <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-text-primary">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning-500" />
                  <p>
                    {conflicts.size} lists target the same buyer with the same priority and overlapping dates. The newest one wins for now — give them different
                    priorities or non-overlapping dates to make it explicit.
                  </p>
                </div>
              )}

              {creating && (
                <div className="mb-4">
                  <PriceListForm
                    ownerId={ownerId}
                    initial={emptyPriceListForm()}
                    initialCustomer={null}
                    contracts={contracts}
                    plans={plans}
                    onCancel={() => setCreating(false)}
                    onSave={(payload) => handleSave(payload)}
                  />
                </div>
              )}

              {lists.length > 0 && <PriceCheck ownerId={ownerId} book={book} lists={lists} items={listItems} today={today} />}

              {lists.length > 0 && (
                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
                    {(['all', ...STATE_ORDER] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setStateFilter(s)}
                        aria-pressed={stateFilter === s}
                        className={`focus-ring min-h-[36px] shrink-0 rounded-full px-3 text-xs font-medium transition-colors ${
                          stateFilter === s ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                        }`}
                      >
                        {s === 'all' ? `All (${lists.length})` : `${STATE_LABELS[s]} (${counts[s]})`}
                      </button>
                    ))}
                  </div>
                  <select
                    value={scopeFilter}
                    onChange={(e) => setScopeFilter(e.target.value as 'all' | PriceListScope)}
                    aria-label="Filter by type"
                    className={`${selectClass} !w-auto !py-2 !text-sm`}
                  >
                    <option value="all">All types</option>
                    {(Object.keys(SCOPE_LABELS) as PriceListScope[]).map((s) => (
                      <option key={s} value={s}>{SCOPE_LABELS[s]} lists</option>
                    ))}
                  </select>
                </div>
              )}

              {lists.length === 0 && !creating ? (
                <EmptyState
                  icon={Tags}
                  title="Create your first price list"
                  description="Give a key customer, a contract, or a whole tier their own prices. Anything you don’t override keeps its Price Book price."
                  action={{ label: 'New price list', onClick: () => setCreating(true) }}
                />
              ) : visible.length === 0 && lists.length > 0 ? (
                <EmptyState
                  icon={Tags}
                  title="Nothing matches these filters"
                  description="Try a different status or type."
                  action={{ label: 'Clear filters', onClick: () => { setStateFilter('all'); setScopeFilter('all'); } }}
                />
              ) : (
                <div className="space-y-3">
                  {visible.map((l) => {
                    const state = stateOf(l);
                    const isOpen = openId === l.id;
                    const count = itemCounts.get(l.id) ?? 0;

                    if (editingId === l.id) {
                      return (
                        <PriceListForm
                          key={l.id}
                          ownerId={ownerId}
                          initial={listToForm(l)}
                          initialCustomer={l.customer_id ? { id: l.customer_id, label: customerNames[l.customer_id] ?? 'Customer' } : null}
                          contracts={contracts}
                          plans={plans}
                          onCancel={() => setEditingId(null)}
                          onSave={(payload) => handleSave(payload, l.id)}
                        />
                      );
                    }

                    return (
                      <motion.div
                        key={l.id}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`rounded-2xl border bg-bg-secondary p-4 ${state === 'archived' ? 'border-border/50 opacity-70' : 'border-border'}`}
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="truncate text-sm font-semibold text-text-primary">{l.name}</p>
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATE_STYLES[state]}`}>{STATE_LABELS[state]}</span>
                              <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium text-text-secondary">{SCOPE_LABELS[l.scope]}</span>
                              {conflicts.has(l.id) && (
                                <span className="flex items-center gap-1 rounded-full bg-warning-500/15 px-2 py-0.5 text-[10px] font-semibold text-warning-500">
                                  <AlertTriangle size={10} /> Overlaps
                                </span>
                              )}
                              {isEndingSoon(l, today) && (
                                <span className="rounded-full bg-warning-500/15 px-2 py-0.5 text-[10px] font-semibold text-warning-500">Ending soon</span>
                              )}
                            </div>
                            <p className="mt-1 truncate text-xs text-text-secondary">{targetLabel(l)}</p>
                            <p className="mt-0.5 text-xs text-text-secondary">
                              {formatDateRange(l.effective_from, l.effective_to)} · priority {l.priority} · {count} override{count === 1 ? '' : 's'}
                            </p>
                            {l.status === 'active' && count === 0 && (
                              <p className="mt-1 text-xs text-warning-500">Active, but has no overrides — it isn’t changing any prices yet.</p>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-1 sm:shrink-0 sm:justify-end">
                            {l.status === 'draft' && (
                              <Button type="button" size="sm" onClick={() => void changeStatus(l, 'active')} disabled={busyId === l.id}>Activate</Button>
                            )}
                            {l.status === 'active' && (
                              <Button type="button" variant="secondary" size="sm" onClick={() => void changeStatus(l, 'draft')} disabled={busyId === l.id}>Pause</Button>
                            )}
                            {l.status === 'archived' && (
                              <Button type="button" variant="secondary" size="sm" onClick={() => void changeStatus(l, 'draft')} disabled={busyId === l.id}>Restore</Button>
                            )}
                            <button type="button" onClick={() => setOpenId(isOpen ? null : l.id)} aria-expanded={isOpen} className={iconBtn} aria-label={isOpen ? 'Hide overrides' : 'Show overrides'}>
                              <ChevronDown size={16} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                            </button>
                            <button type="button" onClick={() => { setEditingId(l.id); setCreating(false); }} className={iconBtn} aria-label="Edit price list">
                              <Pencil size={14} />
                            </button>
                            {l.status !== 'archived' && (
                              <button type="button" onClick={() => void changeStatus(l, 'archived')} disabled={busyId === l.id} className={iconBtn} aria-label="Archive price list">
                                <Archive size={14} />
                              </button>
                            )}
                            <button type="button" onClick={() => setDeletingId(l.id)} className={`${iconBtn} hover:!bg-danger/10 hover:!text-danger`} aria-label="Delete price list">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>

                        {isOpen && (
                          <ListItemsEditor
                            list={l}
                            ownerId={ownerId}
                            book={book}
                            items={listItems.filter((i) => i.price_list_id === l.id)}
                            onChanged={() => load(true)}
                          />
                        )}
                      </motion.div>
                    );
                  })}
                </div>
              )}

              <p className="mt-6 text-xs text-text-secondary">
                How prices are chosen: only active lists inside their dates are used. Contract lists beat customer lists, which beat tier lists. Within the same type,
                higher priority wins, then the most recent start date. Anything not overridden uses the Price Book.
              </p>
            </>
          )
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deletingId)}
        title="Delete this price list?"
        description="Its overrides will be removed and affected customers go back to Price Book prices. Archive it instead if you may need it again."
        confirmLabel="Yes, delete this"
        onConfirm={handleDelete}
        onCancel={() => setDeletingId(null)}
      />
    </DashboardLayout>
  );
}
