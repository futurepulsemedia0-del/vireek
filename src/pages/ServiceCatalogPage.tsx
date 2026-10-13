import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ClipboardList,
  Clock,
  Layers,
  LockKeyhole,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert as AlertTriangle,
  Wrench,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useEscapeToClose, useFocusTrap } from '@/lib/a11y/focusTrap';
import {
  AI_QUOTE_MODE_BADGES,
  AI_QUOTE_MODE_LABELS,
  CATALOG_LIMITS,
  EMPTY_CATALOG_FORM,
  EMPTY_FILTERS,
  PRICING_MODEL_LABELS,
  TAX_CLASS_LABELS,
  UNCATEGORIZED_FILTER,
  appendTag,
  catalogStats,
  collectKnownSkills,
  describeCatalogError,
  estimateTotalCents,
  filterCatalog,
  formatCatalogPrice,
  formatDuration,
  groupCatalog,
  hasActiveFilters,
  itemToForm,
  parseTags,
  resolveAiQuote,
  validateCatalogForm,
  type AiQuoteMode,
  type CatalogCategory,
  type CatalogFilters,
  type CatalogFormState,
  type CatalogItem,
  type CatalogItemPayload,
  type CatalogPricingModel,
  type CatalogTaxClass,
} from '@/lib/serviceCatalog';
import {
  createCategory,
  createItem,
  deleteCategory,
  deleteItem,
  fetchCatalog,
  renameCategory,
  setItemBookable,
  updateItem,
} from '@/lib/serviceCatalogApi';
import { formatCents } from '@/lib/priceBook';

const selectClass =
  'focus-ring w-full rounded-xl border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function SelectField({
  label,
  value,
  onChange,
  children,
  helperText,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  helperText?: string;
  error?: string;
}) {
  const id = useId();
  const describedBy = error || helperText ? `${id}-description` : undefined;
  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={describedBy}
        className={`${selectClass} ${error ? 'border-danger' : 'border-border'}`}
      >
        {children}
      </select>
      {(error || helperText) && (
        <p
          id={`${id}-description`}
          role={error ? 'alert' : undefined}
          className={`mt-1.5 text-xs ${error ? 'text-danger' : 'text-text-secondary'}`}
        >
          {error || helperText}
        </p>
      )}
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="focus-ring inline-flex h-10 min-w-[48px] shrink-0 items-center justify-center rounded-full disabled:opacity-50"
    >
      <span
        className={`relative h-6 w-11 rounded-full border transition-colors ${
          checked ? 'border-accent bg-accent' : 'border-border bg-bg-tertiary'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-[22px]' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex rounded-xl border border-border bg-bg-primary p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`focus-ring min-h-[40px] rounded-lg px-4 text-sm font-medium transition-colors ${
            value === o.value ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-2xl font-bold text-text-primary">{value}</p>
      <p className="mt-0.5 text-xs text-text-secondary">{label}</p>
    </div>
  );
}

function Modal({
  title,
  onClose,
  closeOnEscape = true,
  children,
}: {
  title: string;
  onClose: () => void;
  /** Turn off while a nested dialog is open so Escape only closes the top one. */
  closeOnEscape?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  const trapRef = useFocusTrap(true);
  useEscapeToClose(closeOnEscape, onClose);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-bg-secondary shadow-card-hover sm:max-w-2xl sm:rounded-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold text-text-primary">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="focus-ring flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary hover:text-text-primary"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">{children}</h3>;
}

// ---------------------------------------------------------------------------
// Service editor
// ---------------------------------------------------------------------------

function ItemEditor({
  item,
  categories,
  knownSkills,
  onSubmit,
  onClose,
}: {
  item: CatalogItem | null;
  categories: CatalogCategory[];
  knownSkills: string[];
  onSubmit: (payload: CatalogItemPayload) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<CatalogFormState>(() => (item ? itemToForm(item) : EMPTY_CATALOG_FORM));
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // The focus trap lands on the close button first; move to the first field instead.
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>('input')?.focus();
  }, []);

  const validation = useMemo(() => validateCatalogForm(form), [form]);
  const preview = useMemo(() => (validation.payload ? resolveAiQuote(validation.payload) : null), [validation.payload]);
  const estimate = validation.payload ? estimateTotalCents(validation.payload) : null;

  const set = <K extends keyof CatalogFormState>(key: K, value: CatalogFormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setFormError(null);
  };
  const err = (key: keyof CatalogFormState) => (showErrors ? validation.errors[key] : undefined);

  const currentSkills = useMemo(() => parseTags(form.required_skills).map((s) => s.toLowerCase()), [form.required_skills]);
  const suggestions = knownSkills.filter((s) => !currentSkills.includes(s.toLowerCase())).slice(0, 8);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setShowErrors(true);
    if (!validation.payload) {
      setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await onSubmit(validation.payload);
    } catch (error) {
      setFormError(describeCatalogError(error));
      setSaving(false);
    }
  };

  const hourly = form.pricing_model === 'hourly';

  return (
    <Modal title={item ? 'Edit service' : 'New service'} onClose={onClose}>
      <form ref={formRef} onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 space-y-7 overflow-y-auto px-5 py-5">
          <section>
            <SectionTitle>Basics</SectionTitle>
            <div className="space-y-4">
              <Input
                label="Service name"
                required
                value={form.name}
                maxLength={CATALOG_LIMITS.nameMax}
                onChange={(e) => set('name', e.target.value)}
                error={err('name')}
                placeholder="Drain cleaning"
              />
              <SelectField label="Category" value={form.category_id} onChange={(v) => set('category_id', v)}>
                <option value="">Uncategorized</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </SelectField>
              <Textarea
                label="Description"
                rows={2}
                value={form.description}
                maxLength={CATALOG_LIMITS.descriptionMax}
                onChange={(e) => set('description', e.target.value)}
                error={err('description')}
                helperText="Shown to your team and used by the assistant when explaining the service."
              />
            </div>
          </section>

          <section>
            <SectionTitle>Pricing</SectionTitle>
            <div className="space-y-4">
              <Segmented<CatalogPricingModel>
                ariaLabel="Pricing model"
                value={form.pricing_model}
                onChange={(v) => set('pricing_model', v)}
                options={[
                  { value: 'flat', label: PRICING_MODEL_LABELS.flat },
                  { value: 'hourly', label: PRICING_MODEL_LABELS.hourly },
                ]}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Input
                  label={hourly ? 'Hourly rate ($/hr)' : 'Flat price ($)'}
                  required
                  inputMode="decimal"
                  value={form.price}
                  onChange={(e) => set('price', e.target.value)}
                  error={err('price')}
                  placeholder={hourly ? '95' : '149'}
                />
                {hourly && (
                  <Input
                    label="Minimum charge ($)"
                    inputMode="decimal"
                    value={form.min_charge}
                    onChange={(e) => set('min_charge', e.target.value)}
                    error={err('min_charge')}
                    helperText="Optional. Covers trip fee or minimum time."
                  />
                )}
              </div>
              <SelectField
                label="Tax class"
                value={form.tax_class}
                onChange={(v) => set('tax_class', v as CatalogTaxClass)}
                error={err('tax_class')}
                helperText="Tax rules vary by state — confirm the right class with your accountant."
              >
                {(Object.keys(TAX_CLASS_LABELS) as CatalogTaxClass[]).map((k) => (
                  <option key={k} value={k}>
                    {TAX_CLASS_LABELS[k]}
                  </option>
                ))}
              </SelectField>
            </div>
          </section>

          <section>
            <SectionTitle>Scheduling</SectionTitle>
            <div className="space-y-4">
              <Input
                label="Default duration (minutes)"
                required
                inputMode="numeric"
                value={form.duration}
                onChange={(e) => set('duration', e.target.value)}
                error={err('duration')}
                helperText={estimate !== null ? `Typical invoice for one visit: ${formatCents(estimate)}` : undefined}
              />
              <div>
                <Input
                  label="Required skills"
                  value={form.required_skills}
                  onChange={(e) => set('required_skills', e.target.value)}
                  error={err('required_skills')}
                  placeholder="HVAC, refrigerant handling"
                  helperText="Comma-separated. Only technicians with these skills should be dispatched."
                />
                {suggestions.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2" aria-label="Skills used elsewhere in your catalog">
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => set('required_skills', appendTag(form.required_skills, s))}
                        className="focus-ring inline-flex min-h-[36px] items-center gap-1 rounded-full border border-border px-3 text-xs text-text-secondary hover:border-accent/40 hover:text-text-primary"
                      >
                        <Plus size={12} aria-hidden="true" />
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-bg-primary px-4 py-2">
                <div>
                  <p className="text-sm font-medium text-text-primary">Bookable</p>
                  <p className="text-xs text-text-secondary">
                    When off, this service cannot be scheduled but can still be quoted.
                  </p>
                </div>
                <Switch checked={form.bookable} onChange={(v) => set('bookable', v)} label="Bookable" />
              </div>
            </div>
          </section>

          <section>
            <SectionTitle>AI quoting rules</SectionTitle>
            <div className="space-y-4">
              <SelectField
                label="When a caller asks for a price"
                value={form.ai_quote_mode}
                onChange={(v) => set('ai_quote_mode', v as AiQuoteMode)}
                error={err('ai_quote_mode')}
              >
                {(Object.keys(AI_QUOTE_MODE_LABELS) as AiQuoteMode[]).map((k) => (
                  <option key={k} value={k}>
                    {AI_QUOTE_MODE_LABELS[k]}
                  </option>
                ))}
              </SelectField>

              {form.ai_quote_mode === 'range' && (
                <Input
                  label="Range width (± %)"
                  inputMode="numeric"
                  value={form.ai_range_pct}
                  onChange={(e) => set('ai_range_pct', e.target.value)}
                  error={err('ai_range_pct')}
                  helperText="A 15% range around $200 is quoted as $170–$230."
                />
              )}

              {(form.ai_quote_mode === 'quote' || form.ai_quote_mode === 'range') && (
                <div className="grid gap-4 sm:grid-cols-3">
                  <Input
                    label="Max discount (%)"
                    inputMode="numeric"
                    value={form.ai_max_discount_pct}
                    onChange={(e) => set('ai_max_discount_pct', e.target.value)}
                    error={err('ai_max_discount_pct')}
                    helperText={`0–${CATALOG_LIMITS.maxDiscountPct}`}
                  />
                  <Input
                    label="Price floor ($)"
                    inputMode="decimal"
                    value={form.ai_price_floor}
                    onChange={(e) => set('ai_price_floor', e.target.value)}
                    error={err('ai_price_floor')}
                    helperText="Never quote below this."
                  />
                  <Input
                    label="Needs approval above ($)"
                    inputMode="decimal"
                    value={form.ai_approval_above}
                    onChange={(e) => set('ai_approval_above', e.target.value)}
                    error={err('ai_approval_above')}
                    helperText="A person confirms first."
                  />
                </div>
              )}

              <Input
                label="Phrases callers use"
                value={form.ai_keywords}
                onChange={(e) => set('ai_keywords', e.target.value)}
                error={err('ai_keywords')}
                placeholder="clogged drain, slow drain"
                helperText="Comma-separated. Helps the assistant match this service."
              />
              <Textarea
                label="Notes for the assistant"
                rows={2}
                value={form.ai_notes}
                maxLength={CATALOG_LIMITS.notesMax}
                onChange={(e) => set('ai_notes', e.target.value)}
                error={err('ai_notes')}
                helperText="e.g. “Mention that parts are billed separately.”"
              />

              <div className="rounded-xl border border-accent/30 bg-accent/5 p-4" aria-live="polite">
                <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <Sparkles size={16} className="text-accent" aria-hidden="true" />
                  What the assistant will say
                </p>
                {preview ? (
                  <>
                    <p className="mt-2 text-sm text-text-primary">{preview.message}</p>
                    {preview.requiresApproval && (
                      <p className="mt-1 text-xs text-warning-500">
                        This amount is above your approval threshold, so a person confirms before it is promised.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="mt-2 text-xs text-text-secondary">Complete the required fields to see a preview.</p>
                )}
              </div>
            </div>
          </section>
        </div>

        <div className="border-t border-border px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
          {formError && (
            <p role="alert" className="mb-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? 'Saving…' : item ? 'Save changes' : 'Add service'}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Category manager
// ---------------------------------------------------------------------------

function CategoryManager({
  ownerId,
  categories,
  counts,
  onCreated,
  onRenamed,
  onDeleted,
  onClose,
}: {
  ownerId: string;
  categories: CatalogCategory[];
  counts: Map<string, number>;
  onCreated: (c: CatalogCategory) => void;
  onRenamed: (c: CatalogCategory) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<CatalogCategory | null>(null);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      toast(describeCatalogError(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void run(async () => {
      onCreated(await createCategory(trimmed));
      setName('');
    });
  };

  const saveRename = (c: CatalogCategory) => {
    const trimmed = editName.trim();
    if (!trimmed || trimmed === c.name) {
      setEditingId(null);
      return;
    }
    void run(async () => {
      onRenamed(await renameCategory(ownerId, c.id, trimmed));
      setEditingId(null);
    });
  };

  return (
    <>
      <Modal title="Categories" onClose={onClose} closeOnEscape={deleting === null}>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <form onSubmit={add} className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                label="New category"
                value={name}
                maxLength={CATALOG_LIMITS.categoryNameMax}
                onChange={(e) => setName(e.target.value)}
                placeholder="Plumbing"
              />
            </div>
            <Button type="submit" size="md" disabled={busy || !name.trim()}>
              Add
            </Button>
          </form>

          <div className="mt-6 space-y-2">
            {categories.length === 0 ? (
              <p className="text-sm text-text-secondary">Categories you add will appear here.</p>
            ) : (
              categories.map((c) => (
                <div key={c.id} className="flex items-center gap-2 rounded-xl border border-border bg-bg-primary px-3 py-2">
                  {editingId === c.id ? (
                    <input
                      autoFocus
                      aria-label={`Rename ${c.name}`}
                      value={editName}
                      maxLength={CATALOG_LIMITS.categoryNameMax}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveRename(c);
                        if (e.key === 'Escape') {
                          e.stopPropagation();
                          setEditingId(null);
                        }
                      }}
                      onBlur={() => saveRename(c)}
                      className="focus-ring min-h-[40px] flex-1 rounded-lg border border-border bg-bg-secondary px-3 text-sm text-text-primary"
                    />
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{c.name}</span>
                      <span className="shrink-0 text-xs text-text-secondary">{counts.get(c.id) ?? 0} services</span>
                      <button
                        type="button"
                        aria-label={`Rename ${c.name}`}
                        onClick={() => {
                          setEditingId(c.id);
                          setEditName(c.name);
                        }}
                        className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:text-text-primary"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${c.name}`}
                        onClick={() => setDeleting(c)}
                        className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:text-danger"
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description="The services in this category are kept and move to Uncategorized."
        confirmLabel="Delete category"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          const target = deleting;
          if (!target) return;
          try {
            await deleteCategory(ownerId, target.id);
            onDeleted(target.id);
            toast('Category deleted', 'success');
          } catch (error) {
            toast(describeCatalogError(error), 'error');
          } finally {
            setDeleting(null);
          }
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Service row
// ---------------------------------------------------------------------------

function ItemRow({
  item,
  busy,
  onToggleBookable,
  onEdit,
  onDelete,
}: {
  item: CatalogItem;
  busy: boolean;
  onToggleBookable: (item: CatalogItem, next: boolean) => void;
  onEdit: (item: CatalogItem) => void;
  onDelete: (item: CatalogItem) => void;
}) {
  const skills = item.required_skills;
  return (
    <li className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="truncate text-sm font-semibold text-text-primary">{item.name}</h3>
            <span className="text-sm font-semibold text-accent">{formatCatalogPrice(item)}</span>
          </div>
          {item.description && <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{item.description}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <span className="inline-flex items-center gap-1">
              <Clock size={12} aria-hidden="true" />
              {formatDuration(item.duration_minutes)}
            </span>
            <span className="rounded-full bg-bg-tertiary px-2 py-0.5">{TAX_CLASS_LABELS[item.tax_class]}</span>
            {item.ai_quote_mode !== 'quote' && (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning-500/10 px-2 py-0.5 text-warning-500">
                <Sparkles size={11} aria-hidden="true" />
                {AI_QUOTE_MODE_BADGES[item.ai_quote_mode]}
              </span>
            )}
            {skills.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <Wrench size={12} aria-hidden="true" />
                {skills.slice(0, 3).join(', ')}
                {skills.length > 3 ? ` +${skills.length - 3}` : ''}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-1 border-t border-border pt-2 sm:justify-end sm:border-0 sm:pt-0">
          <span className="flex items-center gap-1 text-xs text-text-secondary">
            Bookable
            <Switch
              checked={item.bookable}
              disabled={busy}
              onChange={(next) => onToggleBookable(item, next)}
              label={`Bookable: ${item.name}`}
            />
          </span>
          <div className="flex items-center">
            <button
              type="button"
              aria-label={`Edit ${item.name}`}
              onClick={() => onEdit(item)}
              className="focus-ring flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary hover:text-text-primary"
            >
              <Pencil size={16} />
            </button>
            <button
              type="button"
              aria-label={`Delete ${item.name}`}
              onClick={() => onDelete(item)}
              className="focus-ring flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary hover:text-danger"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type LoadState = 'loading' | 'ready' | 'error';
type EditorState = { open: false } | { open: true; item: CatalogItem | null };

export function ServiceCatalogPage() {
  const { profile, teamMember, isOwner, permissions, profileLoading } = useAuth();
  const { toast } = useToast();

  // Catalog rows are keyed by the ACCOUNT OWNER's id — for a team member that is
  // not their own user id (same resolution NotificationsContext uses).
  const ownerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const allowed = isOwner || permissions.can_view_billing;

  const [state, setState] = useState<LoadState>('loading');
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [filters, setFilters] = useState<CatalogFilters>(EMPTY_FILTERS);
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [deleting, setDeleting] = useState<CatalogItem | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!ownerId) return;
    const requestId = ++requestRef.current;
    setState('loading');
    try {
      const data = await fetchCatalog(ownerId);
      if (requestId !== requestRef.current) return;
      setCategories(data.categories);
      setItems(data.items);
      setState('ready');
    } catch {
      if (requestId !== requestRef.current) return;
      setState('error');
    }
  }, [ownerId]);

  useEffect(() => {
    if (allowed && ownerId) void load();
    return () => {
      requestRef.current += 1;
    };
  }, [allowed, ownerId, load]);

  const stats = useMemo(() => catalogStats(items, categories), [items, categories]);
  const visible = useMemo(() => filterCatalog(items, filters), [items, filters]);
  const sections = useMemo(() => groupCatalog(visible, categories), [visible, categories]);
  const knownSkills = useMemo(() => collectKnownSkills(items), [items]);
  const categoryCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const i of items) if (i.category_id) map.set(i.category_id, (map.get(i.category_id) ?? 0) + 1);
    return map;
  }, [items]);

  const setBusy = (id: string, on: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const handleSubmit = async (payload: CatalogItemPayload) => {
    if (!ownerId) throw new Error('No account');
    const editing = editor.open ? editor.item : null;
    const saved = editing ? await updateItem(ownerId, editing.id, payload) : await createItem(payload);
    setItems((prev) => (editing ? prev.map((i) => (i.id === saved.id ? saved : i)) : [...prev, saved]));
    setEditor({ open: false });
    toast(editing ? 'Service updated' : 'Service added', 'success');
  };

  const handleToggleBookable = async (item: CatalogItem, next: boolean) => {
    if (!ownerId || busyIds.has(item.id)) return;
    setBusy(item.id, true);
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, bookable: next } : i)));
    try {
      await setItemBookable(ownerId, item.id, next);
    } catch (error) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, bookable: item.bookable } : i)));
      toast(describeCatalogError(error), 'error');
    } finally {
      setBusy(item.id, false);
    }
  };

  const handleDelete = async () => {
    const target = deleting;
    if (!target || !ownerId) return;
    try {
      await deleteItem(ownerId, target.id);
      setItems((prev) => prev.filter((i) => i.id !== target.id));
      toast('Service deleted', 'success');
    } catch (error) {
      toast(describeCatalogError(error), 'error');
    } finally {
      setDeleting(null);
    }
  };

  const openNew = () => setEditor({ open: true, item: null });
  const showSkeleton = allowed && (profileLoading || (state === 'loading' && ownerId !== null));
  const missingAccount = allowed && !profileLoading && ownerId === null;

  return (
    <DashboardLayout activeLabel="Service Catalog">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <ClipboardList size={20} aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Service Catalog</h1>
              <p className="mt-1 text-sm text-text-secondary">
                Every service you sell — pricing, skills, tax and how the AI assistant quotes it.
              </p>
            </div>
          </div>
          {allowed && state === 'ready' && (
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setCategoriesOpen(true)}>
                <Layers size={16} aria-hidden="true" />
                Categories
              </Button>
              <Button size="sm" onClick={openNew}>
                <Plus size={16} aria-hidden="true" />
                New service
              </Button>
            </div>
          )}
        </div>

        {!allowed ? (
          <EmptyState
            icon={LockKeyhole}
            title="Billing permission required"
            description="The service catalog controls your pricing. Ask an account owner to grant you billing access."
          />
        ) : missingAccount ? (
          <EmptyStateError
            icon={AlertTriangle}
            title="Account not found"
            description="We couldn't determine which account this catalog belongs to. Try signing out and back in."
          />
        ) : showSkeleton ? (
          <div className="space-y-4" aria-busy="true">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={4} />
          </div>
        ) : state === 'error' ? (
          <EmptyStateError
            icon={AlertTriangle}
            title="Couldn't load your catalog"
            description="Check your connection and try again."
            onRetry={() => void load()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="Build your service catalog"
            description="Add the services you sell with their price, duration and the skills they need. The AI assistant follows the quoting rules you set."
            action={{ label: 'Add your first service', onClick: openNew }}
            secondaryAction={{ label: 'Create categories', onClick: () => setCategoriesOpen(true) }}
          />
        ) : (
          <>
            <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile label="Services" value={stats.services} />
              <StatTile label="Bookable" value={stats.bookable} />
              <StatTile label="With AI limits" value={stats.restrictedByAi} />
              <StatTile label="Categories" value={stats.categories} />
            </div>

            <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end">
              <div className="flex-1">
                <Input
                  icon={Search}
                  aria-label="Search services"
                  placeholder="Search by name, skill or phrase"
                  value={filters.query}
                  onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
                />
              </div>
              <div className="lg:w-56">
                <SelectField
                  label="Category"
                  value={filters.categoryId}
                  onChange={(v) => setFilters((f) => ({ ...f, categoryId: v }))}
                >
                  <option value="">All categories</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  <option value={UNCATEGORIZED_FILTER}>Uncategorized</option>
                </SelectField>
              </div>
              <Segmented<CatalogFilters['bookable']>
                ariaLabel="Filter by bookable"
                value={filters.bookable}
                onChange={(v) => setFilters((f) => ({ ...f, bookable: v }))}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'yes', label: 'Bookable' },
                  { value: 'no', label: 'Not bookable' },
                ]}
              />
            </div>

            {visible.length === 0 ? (
              <EmptyState
                icon={Search}
                title="No services match your filters"
                description="Try a different search or clear the filters."
                action={hasActiveFilters(filters) ? { label: 'Clear filters', onClick: () => setFilters(EMPTY_FILTERS) } : undefined}
              />
            ) : (
              <div className="space-y-8">
                {sections.map((section) => (
                  <section key={section.id ?? 'uncategorized'} aria-label={section.name}>
                    <h2 className="mb-3 text-sm font-semibold text-text-primary">
                      {section.name}
                      <span className="ml-2 text-xs font-normal text-text-secondary">{section.items.length}</span>
                    </h2>
                    <ul className="space-y-3">
                      {section.items.map((item) => (
                        <ItemRow
                          key={item.id}
                          item={item}
                          busy={busyIds.has(item.id)}
                          onToggleBookable={(i, next) => void handleToggleBookable(i, next)}
                          onEdit={(i) => setEditor({ open: true, item: i })}
                          onDelete={setDeleting}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {editor.open && (
        <ItemEditor
          item={editor.item}
          categories={categories}
          knownSkills={knownSkills}
          onSubmit={handleSubmit}
          onClose={() => setEditor({ open: false })}
        />
      )}

      {categoriesOpen && ownerId && (
        <CategoryManager
          ownerId={ownerId}
          categories={categories}
          counts={categoryCounts}
          onCreated={(c) => setCategories((prev) => [...prev, c])}
          onRenamed={(c) => setCategories((prev) => prev.map((p) => (p.id === c.id ? c : p)))}
          onDeleted={(id) => {
            setCategories((prev) => prev.filter((c) => c.id !== id));
            setItems((prev) => prev.map((i) => (i.category_id === id ? { ...i, category_id: null } : i)));
            setFilters((f) => (f.categoryId === id ? { ...f, categoryId: '' } : f));
          }}
          onClose={() => setCategoriesOpen(false)}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete “${deleting?.name ?? ''}”?`}
        description="This removes the service from your catalog. It cannot be undone."
        confirmLabel="Delete service"
        onCancel={() => setDeleting(null)}
        onConfirm={handleDelete}
      />
    </DashboardLayout>
  );
}
