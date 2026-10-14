import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, SlidersHorizontal, X } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import {
  countActiveFilters,
  filterFields,
  formatValue,
  isActiveDef,
  isSameCustomData,
  sanitizeCustomData,
  sortDefs,
  tableFields,
  validateCustomData,
  type CustomData,
  type CustomEntity,
  type CustomFieldDef,
  type CustomFilterEntry,
  type CustomFilters,
} from '@/lib/customFields';
import { friendlyFieldError, saveCustomData, useCustomFieldDefs } from '@/lib/customFieldsApi';

const INPUT =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 disabled:opacity-60';

// ============================================================
// EDITOR — inputs for every active field (use inside create/edit forms)
// ============================================================

interface EditorProps {
  defs: CustomFieldDef[];
  value: CustomData;
  onChange: (next: CustomData) => void;
  disabled?: boolean;
  className?: string;
}

export function CustomFieldsEditor({ defs, value, onChange, disabled, className = '' }: EditorProps) {
  const uid = useId();
  const active = useMemo(() => sortDefs(defs).filter(isActiveDef), [defs]);
  if (active.length === 0) return null;

  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });

  return (
    <div className={`grid gap-4 sm:grid-cols-2 ${className}`}>
      {active.map((d) => {
        const id = `${uid}-${d.key}`;
        const v = value[d.key];
        const label = (
          <label htmlFor={id} className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            {d.label}
            {d.required && <span className="ml-0.5 text-danger" aria-hidden="true">*</span>}
          </label>
        );

        if (d.field_type === 'boolean') {
          return (
            <div key={d.id} className="flex items-center gap-3 sm:col-span-1">
              <input
                id={id}
                type="checkbox"
                disabled={disabled}
                checked={v === true}
                onChange={(e) => set(d.key, e.target.checked)}
                className="focus-ring h-4 w-4 rounded border-border accent-accent"
              />
              <label htmlFor={id} className="text-sm font-medium text-text-primary">
                {d.label}
              </label>
            </div>
          );
        }

        return (
          <div key={d.id} className={d.field_type === 'text' ? 'sm:col-span-2' : ''}>
            {label}
            <div className="mt-1.5">
              {d.field_type === 'select' ? (
                <select
                  id={id}
                  disabled={disabled}
                  required={d.required}
                  value={typeof v === 'string' ? v : ''}
                  onChange={(e) => set(d.key, e.target.value)}
                  className={INPUT}
                >
                  <option value="">—</option>
                  {d.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                  {typeof v === 'string' && v !== '' && !d.options.includes(v) && <option value={v}>{v} (removed)</option>}
                </select>
              ) : d.field_type === 'date' ? (
                <input id={id} type="date" disabled={disabled} required={d.required} value={typeof v === 'string' ? v : ''} onChange={(e) => set(d.key, e.target.value)} className={INPUT} />
              ) : d.field_type === 'number' ? (
                <input
                  id={id}
                  type="number"
                  step="any"
                  inputMode="decimal"
                  disabled={disabled}
                  required={d.required}
                  value={v === null || v === undefined ? '' : String(v)}
                  onChange={(e) => set(d.key, e.target.value)}
                  className={INPUT}
                />
              ) : (
                <input id={id} type="text" maxLength={500} disabled={disabled} required={d.required} value={typeof v === 'string' ? v : ''} onChange={(e) => set(d.key, e.target.value)} className={INPUT} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// PANEL — self-contained "Custom fields" card for detail views
// ============================================================

interface PanelProps {
  entity: CustomEntity;
  recordId: string;
  /** The record's current custom_data (may be undefined for older rows). */
  value?: CustomData | null;
  className?: string;
}

export function CustomFieldsPanel({ entity, recordId, value, className = '' }: PanelProps) {
  const { toast } = useToast();
  const { defs, loading, error, reload, ownerId } = useCustomFieldDefs(entity);
  const [draft, setDraft] = useState<CustomData>(value ?? {});
  const [baseline, setBaseline] = useState<CustomData>(value ?? {});
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // Reset only when switching records, never while the user is typing.
  const lastId = useRef(recordId);
  useEffect(() => {
    if (lastId.current !== recordId) {
      lastId.current = recordId;
      setDraft(value ?? {});
      setBaseline(value ?? {});
      setErrors([]);
    }
  }, [recordId, value]);

  const hasActive = defs.some(isActiveDef);
  const dirty = !isSameCustomData(draft, baseline);

  if (loading) {
    return (
      <div className={`rounded-2xl border border-border bg-bg-secondary p-4 ${className}`} aria-busy="true" aria-label="Loading custom fields">
        <div className="h-3 w-28 animate-pulse rounded bg-bg-tertiary" />
        <div className="mt-3 h-9 w-full animate-pulse rounded-xl bg-bg-tertiary" />
      </div>
    );
  }
  if (error) {
    return (
      <div className={`flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary ${className}`}>
        <span className="flex items-center gap-2">
          <AlertTriangle size={14} /> Couldn't load custom fields.
        </span>
        <button type="button" onClick={() => void reload()} className="focus-ring rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:text-text-primary">
          Retry
        </button>
      </div>
    );
  }
  if (!hasActive) return null;

  const handleSave = async () => {
    if (!ownerId || saving) return;
    const errs = validateCustomData(defs, draft);
    setErrors(errs);
    if (errs.length) return;
    setSaving(true);
    try {
      const clean = sanitizeCustomData(defs, draft);
      await saveCustomData(entity, recordId, ownerId, clean);
      setDraft(clean);
      setBaseline(clean);
      toast('Custom fields saved.', 'success');
    } catch (err) {
      toast(friendlyFieldError(err, 'Could not save custom fields.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`rounded-2xl border border-border bg-bg-secondary p-4 ${className}`} aria-label="Custom fields">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Custom fields</h3>
      <CustomFieldsEditor defs={defs} value={draft} onChange={setDraft} disabled={saving} className="mt-3" />
      {errors.length > 0 && (
        <ul role="alert" className="mt-3 space-y-0.5 text-xs font-medium text-danger">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={handleSave}
          className="focus-ring flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {saving ? 'Saving…' : 'Save fields'}
        </button>
      </div>
    </section>
  );
}

// ============================================================
// BADGES — compact values for table rows / cards
// ============================================================

export function CustomFieldBadges({
  defs,
  data,
  max = 3,
  className = '',
}: {
  defs: CustomFieldDef[];
  data?: CustomData | null;
  max?: number;
  className?: string;
}) {
  const items = tableFields(defs)
    .map((d) => ({ d, text: formatValue(d, data?.[d.key]) }))
    .filter((x) => x.text !== '');
  if (items.length === 0) return null;
  const shown = items.slice(0, max);
  const extra = items.length - shown.length;
  return (
    <div className={`mt-1 flex flex-wrap gap-1 ${className}`}>
      {shown.map(({ d, text }) => (
        <span
          key={d.id}
          title={`${d.label}: ${text}`}
          className="max-w-[12rem] truncate rounded-full border border-border bg-bg-primary px-2 py-0.5 text-[11px] text-text-secondary"
        >
          <span className="font-medium text-text-primary">{d.label}:</span> {text}
        </span>
      ))}
      {extra > 0 && <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary">+{extra}</span>}
    </div>
  );
}

/**
 * Drop-in badges for list rows / cards: loads the (shared, cached) field
 * definitions itself, so a card needs no extra props or state.
 */
export function CustomFieldBadgesAuto({
  entity,
  data,
  max,
  className,
}: {
  entity: CustomEntity;
  data?: CustomData | null;
  max?: number;
  className?: string;
}) {
  const { defs } = useCustomFieldDefs(entity);
  if (!data || Object.keys(data).length === 0) return null;
  return <CustomFieldBadges defs={defs} data={data} max={max} className={className} />;
}

// ============================================================
// FILTER BAR — popover with one control per filterable field
// ============================================================

export function CustomFilterBar({
  defs,
  value,
  onChange,
  className = '',
}: {
  defs: CustomFieldDef[];
  value: CustomFilters;
  onChange: (next: CustomFilters) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const fields = filterFields(defs);
  const count = countActiveFilters(defs, value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (fields.length === 0) return null;

  const patch = (key: string, p: Partial<CustomFilterEntry>) => onChange({ ...value, [key]: { ...value[key], ...p } });

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className="focus-ring flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary"
      >
        <SlidersHorizontal size={15} /> Custom filters
        {count > 0 && <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold text-white">{count}</span>}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Custom field filters"
          className="absolute left-0 z-40 mt-2 max-h-[70vh] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-border bg-bg-secondary p-4 shadow-card-hover dark:shadow-card-hover-dark"
        >
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold text-text-primary">Filter by custom fields</p>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close filters" className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary">
              <X size={16} />
            </button>
          </div>
          <div className="space-y-3">
            {fields.map((d) => {
              const f = value[d.key] ?? {};
              const lbl = <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{d.label}</span>;
              return (
                <label key={d.id} className="block">
                  {lbl}
                  <div className="mt-1.5">
                    {d.field_type === 'select' ? (
                      <select value={f.value ?? ''} onChange={(e) => patch(d.key, { value: e.target.value })} className={INPUT}>
                        <option value="">Any</option>
                        {d.options.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : d.field_type === 'boolean' ? (
                      <select value={f.value ?? ''} onChange={(e) => patch(d.key, { value: e.target.value })} className={INPUT}>
                        <option value="">Any</option>
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    ) : d.field_type === 'number' ? (
                      <div className="flex items-center gap-2">
                        <input type="number" step="any" placeholder="Min" aria-label={`${d.label} minimum`} value={f.min ?? ''} onChange={(e) => patch(d.key, { min: e.target.value })} className={INPUT} />
                        <input type="number" step="any" placeholder="Max" aria-label={`${d.label} maximum`} value={f.max ?? ''} onChange={(e) => patch(d.key, { max: e.target.value })} className={INPUT} />
                      </div>
                    ) : d.field_type === 'date' ? (
                      <div className="flex items-center gap-2">
                        <input type="date" aria-label={`${d.label} from`} value={f.min ?? ''} max={f.max || undefined} onChange={(e) => patch(d.key, { min: e.target.value })} className={INPUT} />
                        <input type="date" aria-label={`${d.label} to`} value={f.max ?? ''} min={f.min || undefined} onChange={(e) => patch(d.key, { max: e.target.value })} className={INPUT} />
                      </div>
                    ) : (
                      <input type="search" placeholder="Contains…" value={f.value ?? ''} onChange={(e) => patch(d.key, { value: e.target.value })} className={INPUT} />
                    )}
                  </div>
                </label>
              );
            })}
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              disabled={count === 0}
              onClick={() => onChange({})}
              className="focus-ring rounded-xl border border-border px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
            >
              Clear all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
