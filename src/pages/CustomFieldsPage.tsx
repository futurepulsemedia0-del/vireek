import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArchiveRestore,
  Archive,
  ArrowDown,
  ArrowUp,
  Loader2,
  Lock,
  Pencil,
  Plus,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  CUSTOM_ENTITIES,
  CUSTOM_ENTITY_META,
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPE_META,
  MAX_FIELDS_PER_ENTITY,
  isActiveDef,
  normalizeOptions,
  slugifyKey,
  sortDefs,
  validateDefinitionInput,
  type CustomEntity,
  type CustomFieldDef,
  type CustomFieldType,
} from '@/lib/customFields';
import {
  createCustomField,
  deleteCustomField,
  friendlyFieldError,
  setFieldOrder,
  updateCustomField,
  useCanManageCustomFields,
  useCustomFieldDefs,
} from '@/lib/customFieldsApi';

const INPUT =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 disabled:opacity-60';

function NoAccess() {
  return (
    <DashboardLayout activeLabel="Custom Fields">
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
          <Lock size={26} />
        </span>
        <h3 className="mt-4 text-lg font-semibold text-text-primary">Permission required</h3>
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
          Custom fields change the forms and tables for your whole team, so they're limited to people who can edit the
          business profile. Ask your account owner for access.
        </p>
      </div>
    </DashboardLayout>
  );
}

// ============================================================
// CREATE / EDIT MODAL
// ============================================================

function FieldModal({
  entity,
  editing,
  defs,
  onClose,
  onSaved,
  ownerId,
}: {
  entity: CustomEntity;
  editing: CustomFieldDef | null;
  defs: CustomFieldDef[];
  onClose: () => void;
  onSaved: () => void;
  ownerId: string;
}) {
  const { toast } = useToast();
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);

  const [label, setLabel] = useState(editing?.label ?? '');
  const [type, setType] = useState<CustomFieldType>(editing?.field_type ?? 'text');
  const [optionsText, setOptionsText] = useState((editing?.options ?? []).join('\n'));
  const [required, setRequired] = useState(editing?.required ?? false);
  const [showInTable, setShowInTable] = useState(editing?.show_in_table ?? true);
  const [showInFilters, setShowInFilters] = useState(editing?.show_in_filters ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keyPreview = useMemo(
    () => editing?.key ?? slugifyKey(label || 'field', defs.map((d) => d.key)),
    [editing, label, defs],
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const options = normalizeOptions(optionsText);
    const otherLabels = defs.filter((d) => isActiveDef(d) && d.id !== editing?.id).map((d) => d.label);
    const err = validateDefinitionInput({ label, field_type: type, options }, otherLabels);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      if (editing) {
        await updateCustomField(editing.id, ownerId, {
          label: label.trim(),
          options: type === 'select' ? options : [],
          required: type === 'boolean' ? false : required,
          show_in_table: showInTable,
          show_in_filters: showInFilters,
        });
        toast('Field updated.', 'success');
      } else {
        await createCustomField(
          { entity, label, field_type: type, options, required, show_in_table: showInTable, show_in_filters: showInFilters },
          defs,
        );
        toast('Field created.', 'success');
      }
      onSaved();
    } catch (err2) {
      setError(friendlyFieldError(err2, 'Could not save this field.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cf-modal-title"
        className="relative max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover dark:shadow-card-hover-dark sm:max-w-lg sm:rounded-2xl sm:p-6"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="cf-modal-title" className="text-lg font-bold text-text-primary">
            {editing ? 'Edit field' : `New ${CUSTOM_ENTITY_META[entity].singular.toLowerCase()} field`}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4" noValidate>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Field name</span>
            <input autoFocus value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Gate code" className={`${INPUT} mt-1.5`} />
            <span className="mt-1 block text-[11px] text-text-secondary">
              Internal key: <code className="rounded bg-bg-tertiary px-1">{keyPreview}</code>
              {editing ? ' (can’t be changed)' : ''}
            </span>
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Type</span>
            <select value={type} disabled={!!editing} onChange={(e) => setType(e.target.value as CustomFieldType)} className={`${INPUT} mt-1.5`}>
              {CUSTOM_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CUSTOM_FIELD_TYPE_META[t].label} — {CUSTOM_FIELD_TYPE_META[t].hint}
                </option>
              ))}
            </select>
            {editing && <span className="mt-1 block text-[11px] text-text-secondary">The type is locked so existing values stay valid.</span>}
          </label>

          {type === 'select' && (
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Options (one per line)</span>
              <textarea rows={5} value={optionsText} onChange={(e) => setOptionsText(e.target.value)} placeholder={'Gold\nSilver\nBronze'} className={`${INPUT} mt-1.5 resize-y`} />
              {editing && <span className="mt-1 block text-[11px] text-text-secondary">Removing an option keeps values already saved on records.</span>}
            </label>
          )}

          <fieldset className="space-y-2.5 rounded-xl border border-border p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">Where it appears</legend>
            {type !== 'boolean' && (
              <label className="flex items-center gap-2.5 text-sm text-text-primary">
                <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="h-4 w-4 accent-accent" />
                Required when creating or editing
              </label>
            )}
            <label className="flex items-center gap-2.5 text-sm text-text-primary">
              <input type="checkbox" checked={showInTable} onChange={(e) => setShowInTable(e.target.checked)} className="h-4 w-4 accent-accent" />
              Show in lists and tables
            </label>
            <label className="flex items-center gap-2.5 text-sm text-text-primary">
              <input type="checkbox" checked={showInFilters} onChange={(e) => setShowInFilters(e.target.checked)} className="h-4 w-4 accent-accent" />
              Allow filtering by this field
            </label>
          </fieldset>

          {error && (
            <p role="alert" className="flex items-start gap-2 text-sm font-medium text-danger">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={onClose} className="focus-ring rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="focus-ring flex items-center justify-center gap-2 rounded-xl bg-cta px-5 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60">
              {saving && <Loader2 size={15} className="animate-spin" />}
              {editing ? 'Save changes' : 'Create field'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// PAGE
// ============================================================

export function CustomFieldsPage() {
  const canManage = useCanManageCustomFields();
  const { toast } = useToast();
  const [entity, setEntity] = useState<CustomEntity>('customer');
  const { defs, loading, error, reload, ownerId } = useCustomFieldDefs(entity);

  const [modal, setModal] = useState<{ editing: CustomFieldDef | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CustomFieldDef | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    setShowArchived(false);
  }, [entity]);

  const sorted = useMemo(() => sortDefs(defs), [defs]);
  const active = sorted.filter(isActiveDef);
  const archived = sorted.filter((d) => !isActiveDef(d));
  const atLimit = active.length >= MAX_FIELDS_PER_ENTITY;

  if (!canManage) return <NoAccess />;

  const run = async (id: string, fn: () => Promise<void>, ok: string) => {
    setBusyId(id);
    try {
      await fn();
      toast(ok, 'success');
      await reload();
    } catch (err) {
      toast(friendlyFieldError(err), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const move = (index: number, dir: -1 | 1) => {
    const next = [...active];
    const target = index + dir;
    if (!ownerId || target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void run(next[index].id, () => setFieldOrder(ownerId, next), 'Order updated.');
  };

  const renderRow = (d: CustomFieldDef, index?: number) => {
    const busy = busyId === d.id;
    const isArchived = !isActiveDef(d);
    return (
      <li key={d.id} className={`rounded-2xl border border-border bg-bg-secondary p-4 ${isArchived ? 'opacity-70' : ''}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-primary">
              {d.label}
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">{CUSTOM_FIELD_TYPE_META[d.field_type].label}</span>
              {d.required && <span className="rounded-full bg-warning-500/10 px-2 py-0.5 text-[11px] font-medium text-warning-500">Required</span>}
            </p>
            <p className="mt-1 text-xs text-text-secondary">
              <code className="rounded bg-bg-tertiary px-1">{d.key}</code>
              {d.show_in_table ? ' · In lists' : ''}
              {d.show_in_filters ? ' · Filterable' : ''}
              {d.field_type === 'select' ? ` · ${d.options.length} option${d.options.length === 1 ? '' : 's'}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {busy && <Loader2 size={14} className="animate-spin text-text-secondary" />}
            {!isArchived && index !== undefined && (
              <>
                <button type="button" disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label={`Move ${d.label} up`} className="focus-ring rounded-lg border border-border p-1.5 text-text-secondary hover:text-text-primary disabled:opacity-40">
                  <ArrowUp size={14} />
                </button>
                <button type="button" disabled={busy || index === active.length - 1} onClick={() => move(index, 1)} aria-label={`Move ${d.label} down`} className="focus-ring rounded-lg border border-border p-1.5 text-text-secondary hover:text-text-primary disabled:opacity-40">
                  <ArrowDown size={14} />
                </button>
                <button type="button" disabled={busy} onClick={() => setModal({ editing: d })} aria-label={`Edit ${d.label}`} className="focus-ring rounded-lg border border-border p-1.5 text-text-secondary hover:text-text-primary disabled:opacity-40">
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  disabled={busy || !ownerId}
                  onClick={() => ownerId && run(d.id, () => updateCustomField(d.id, ownerId, { archived_at: new Date().toISOString() }), 'Field archived. Saved values are kept.')}
                  aria-label={`Archive ${d.label}`}
                  className="focus-ring rounded-lg border border-border p-1.5 text-text-secondary hover:text-text-primary disabled:opacity-40"
                >
                  <Archive size={14} />
                </button>
              </>
            )}
            {isArchived && (
              <button
                type="button"
                disabled={busy || !ownerId}
                onClick={() => ownerId && run(d.id, () => updateCustomField(d.id, ownerId, { archived_at: null }), 'Field restored.')}
                className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary disabled:opacity-40"
              >
                <ArchiveRestore size={13} /> Restore
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => setConfirmDelete(d)} aria-label={`Delete ${d.label}`} className="focus-ring rounded-lg border border-border p-1.5 text-text-secondary hover:text-danger disabled:opacity-40">
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </li>
    );
  };

  return (
    <DashboardLayout activeLabel="Custom Fields">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <SlidersHorizontal size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold text-text-primary sm:text-2xl">Custom fields</h1>
            <p className="text-sm text-text-secondary">Track what's unique to your business on customers, leads and jobs.</p>
          </div>
          <button
            type="button"
            disabled={atLimit || loading || !!error}
            onClick={() => setModal({ editing: null })}
            className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-cta px-4 py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50 sm:w-auto"
          >
            <Plus size={16} /> New field
          </button>
        </div>

        <div role="tablist" aria-label="Record type" className="inline-flex rounded-xl border border-border bg-bg-secondary p-1">
          {CUSTOM_ENTITIES.map((e) => (
            <button
              key={e}
              role="tab"
              type="button"
              aria-selected={entity === e}
              onClick={() => setEntity(e)}
              className={`focus-ring rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${entity === e ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
            >
              {CUSTOM_ENTITY_META[e].plural}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading custom fields">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-2xl border border-border bg-bg-secondary p-4">
                <div className="h-4 w-1/3 animate-pulse rounded bg-bg-tertiary" />
                <div className="mt-3 h-3 w-1/2 animate-pulse rounded bg-bg-tertiary" />
              </div>
            ))}
          </div>
        ) : error ? (
          <EmptyState icon={AlertTriangle} title="Couldn't load custom fields" description="Check your connection and try again." action={{ label: 'Try again', onClick: () => void reload() }} />
        ) : (
          <>
            <p className="text-xs text-text-secondary">
              {active.length} of {MAX_FIELDS_PER_ENTITY} fields used
              {atLimit && ' — archive or delete a field to add another.'}
            </p>

            {active.length === 0 ? (
              <EmptyState
                icon={SlidersHorizontal}
                title={`No ${CUSTOM_ENTITY_META[entity].singular.toLowerCase()} fields yet`}
                description="Add fields like “Gate code”, “Property size” or “Preferred technician”. They show up in forms, lists and filters automatically."
                action={{ label: 'Create your first field', onClick: () => setModal({ editing: null }) }}
              />
            ) : (
              <ul className="space-y-3">
                {active.map((d, i) => renderRow(d, i))}
              </ul>
            )}

            {archived.length > 0 && (
              <div>
                <button type="button" onClick={() => setShowArchived((v) => !v)} aria-expanded={showArchived} className="focus-ring rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary">
                  {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
                </button>
                {showArchived && (
                  <ul className="mt-3 space-y-3">
                    {archived.map((d) => renderRow(d))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {modal && ownerId && (
        <FieldModal
          entity={entity}
          editing={modal.editing}
          defs={sorted}
          ownerId={ownerId}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void reload();
          }}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={`Delete “${confirmDelete?.label ?? ''}”?`}
        description="This permanently removes the field AND its saved values from every record. To keep the data, archive the field instead."
        confirmPhrase="delete field"
        confirmLabel="Delete field"
        onConfirm={async () => {
          const d = confirmDelete;
          setConfirmDelete(null);
          if (d) await run(d.id, () => deleteCustomField(d.id), 'Field deleted.');
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </DashboardLayout>
  );
}
