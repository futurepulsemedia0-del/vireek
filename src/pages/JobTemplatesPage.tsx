import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Clock,
  Copy,
  LayoutTemplate,
  ListChecks,
  Lock,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { SkeletonCardList } from '@/components/Skeleton';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { supabase } from '@/lib/supabase';
import { formatCents } from '@/lib/priceBook';
import {
  JobTemplateFormState,
  JobTemplateSummary,
  TEMPLATE_LIMITS,
  TemplateStatusFilter,
  centsToInput,
  deleteJobTemplate,
  describeTemplateError,
  duplicateJobTemplate,
  emptyTemplateForm,
  fetchJobTemplateDetail,
  fetchJobTemplates,
  filterTemplates,
  formServicesTotalCents,
  formatDuration,
  formatTemplatePrice,
  hasErrors,
  newLineKey,
  saveJobTemplate,
  setJobTemplateActive,
  templateToForm,
  validateTemplateForm,
} from '@/lib/jobTemplates';

const iconButtonClass =
  'focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40';

interface PartOption {
  id: string;
  name: string;
  part_number: string | null;
}

interface PriceBookOption {
  id: string;
  service_name: string;
  price_cents: number;
}

function move<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function LineInput(props: React.ComponentProps<typeof Input>) {
  return <Input {...props} className="!px-3.5 !py-2.5 !text-sm" />;
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1.5 text-xs text-danger">
      {message}
    </p>
  );
}

// ============================================================
// EDITOR (modal on desktop, full-height sheet on mobile)
// ============================================================

function TemplateEditor({
  accountOwnerId,
  initial,
  templateId,
  onClose,
  onSaved,
}: {
  accountOwnerId: string;
  initial: JobTemplateFormState;
  templateId: string | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { toast } = useToast();
  const dialogRef = useFocusTrap(true);
  useEscapeToClose(true, onClose);

  const [form, setForm] = useState<JobTemplateFormState>(initial);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [parts, setParts] = useState<PartOption[]>([]);
  const [priceBook, setPriceBook] = useState<PriceBookOption[]>([]);
  const [lookupsFailed, setLookupsFailed] = useState(false);

  const errors = useMemo(() => (attempted ? validateTemplateForm(form) : {}), [attempted, form]);
  const servicesTotal = useMemo(() => formServicesTotalCents(form.services), [form.services]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [partsRes, pbRes] = await Promise.all([
        supabase
          .from('inventory_parts')
          .select('id, name, part_number')
          .eq('user_id', accountOwnerId)
          .eq('active', true)
          .order('name'),
        supabase
          .from('price_book_items')
          .select('id, service_name, price_cents')
          .eq('user_id', accountOwnerId)
          .eq('active', true)
          .order('service_name'),
      ]);
      if (cancelled) return;
      if (partsRes.error || pbRes.error) setLookupsFailed(true);
      setParts((partsRes.data as PartOption[]) ?? []);
      setPriceBook((pbRes.data as PriceBookOption[]) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountOwnerId]);

  const patch = (p: Partial<JobTemplateFormState>) => setForm((f) => ({ ...f, ...p }));

  const addService = (fromPriceBookId?: string) => {
    const item = priceBook.find((p) => p.id === fromPriceBookId);
    patch({
      services: [
        ...form.services,
        {
          key: newLineKey(),
          service_name: item?.service_name ?? '',
          price_book_item_id: item?.id ?? '',
          quantity: '1',
          unit_price: item ? centsToInput(item.price_cents) : '',
        },
      ],
    });
  };

  const addPart = (partId: string) => {
    const part = parts.find((p) => p.id === partId);
    if (!part) return;
    const existing = form.parts.find((p) => p.part_id === partId);
    if (existing) {
      patch({
        parts: form.parts.map((p) =>
          p.key === existing.key ? { ...p, quantity: String((Number(p.quantity) || 0) + 1) } : p
        ),
      });
      return;
    }
    patch({
      parts: [
        ...form.parts,
        { key: newLineKey(), part_id: part.id, part_name: part.name, part_number: part.part_number ?? '', quantity: '1' },
      ],
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setAttempted(true);
    if (hasErrors(validateTemplateForm(form))) return;
    setSaving(true);
    try {
      await saveJobTemplate(templateId, form);
      onSaved(templateId ? 'Template updated.' : 'Template created.');
    } catch (err) {
      toast(describeTemplateError(err, 'Could not save the template.'), 'error');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="job-template-editor-title"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="relative flex h-[94dvh] w-full max-w-2xl flex-col rounded-t-2xl border border-border bg-bg-secondary shadow-card-hover sm:h-auto sm:max-h-[90vh] sm:rounded-2xl dark:shadow-card-hover-dark"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="job-template-editor-title" className="text-lg font-bold text-text-primary">
            {templateId ? 'Edit template' : 'New job template'}
          </h2>
          <button type="button" onClick={onClose} className={iconButtonClass} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
            {lookupsFailed && (
              <p className="flex items-start gap-2 rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-xs text-text-secondary">
                <AlertCircle size={14} className="mt-0.5 shrink-0 text-warning-500" />
                Your Price Book or parts list could not be loaded. You can still type services by hand.
              </p>
            )}

            {/* Basics */}
            <section className="space-y-4">
              <Input
                label="Template name"
                type="text"
                value={form.name}
                maxLength={TEMPLATE_LIMITS.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="e.g. AC tune-up"
                error={errors.name}
                className="!py-2.5 !text-sm"
                autoFocus
              />
              <Textarea
                label="Description (optional)"
                rows={2}
                value={form.description}
                maxLength={TEMPLATE_LIMITS.description}
                onChange={(e) => patch({ description: e.target.value })}
                placeholder="When to use this template"
                error={errors.description}
                className="!py-2.5 !text-sm"
              />
              <div className="grid gap-4 sm:grid-cols-3">
                <Input
                  label="Service type"
                  type="text"
                  value={form.service_type}
                  maxLength={TEMPLATE_LIMITS.serviceType}
                  onChange={(e) => patch({ service_type: e.target.value })}
                  placeholder="e.g. HVAC"
                  error={errors.service_type}
                  className="!py-2.5 !text-sm"
                />
                <Input
                  label="Duration (min)"
                  type="number"
                  inputMode="numeric"
                  min={TEMPLATE_LIMITS.minDurationMinutes}
                  max={TEMPLATE_LIMITS.maxDurationMinutes}
                  value={form.duration_minutes}
                  onChange={(e) => patch({ duration_minutes: e.target.value })}
                  placeholder="e.g. 90"
                  error={errors.duration_minutes}
                  className="!py-2.5 !text-sm"
                />
                <Input
                  label="Quoted price ($)"
                  type="text"
                  inputMode="decimal"
                  value={form.price}
                  onChange={(e) => patch({ price: e.target.value })}
                  placeholder="e.g. 149.50"
                  error={errors.price}
                  className="!py-2.5 !text-sm"
                />
              </div>
            </section>

            {/* Services */}
            <section>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <Wrench size={15} className="text-accent" /> Services
                </h3>
                {servicesTotal > 0 && (
                  <button
                    type="button"
                    onClick={() => patch({ price: centsToInput(servicesTotal) })}
                    className="focus-ring rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10"
                  >
                    Use line total ({formatCents(servicesTotal)}) as price
                  </button>
                )}
              </div>
              <div className="space-y-2.5">
                {form.services.map((s, i) => (
                  <div key={s.key} className="rounded-xl border border-border bg-bg-primary p-3">
                    <div className="grid gap-2 sm:grid-cols-[1fr_5rem_7rem_auto]">
                      <LineInput
                        type="text"
                        aria-label={`Service ${i + 1} name`}
                        value={s.service_name}
                        maxLength={TEMPLATE_LIMITS.serviceName}
                        onChange={(e) =>
                          patch({ services: form.services.map((x) => (x.key === s.key ? { ...x, service_name: e.target.value } : x)) })
                        }
                        placeholder="Service name"
                      />
                      <LineInput
                        type="text"
                        inputMode="decimal"
                        aria-label={`Service ${i + 1} quantity`}
                        value={s.quantity}
                        onChange={(e) =>
                          patch({ services: form.services.map((x) => (x.key === s.key ? { ...x, quantity: e.target.value } : x)) })
                        }
                        placeholder="Qty"
                      />
                      <LineInput
                        type="text"
                        inputMode="decimal"
                        aria-label={`Service ${i + 1} unit price`}
                        value={s.unit_price}
                        onChange={(e) =>
                          patch({ services: form.services.map((x) => (x.key === s.key ? { ...x, unit_price: e.target.value } : x)) })
                        }
                        placeholder="$ each"
                      />
                      <button
                        type="button"
                        onClick={() => patch({ services: form.services.filter((x) => x.key !== s.key) })}
                        className={`${iconButtonClass} hover:text-danger`}
                        aria-label={`Remove service ${i + 1}`}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <FieldError message={errors.services} />
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => addService()}
                  disabled={form.services.length >= TEMPLATE_LIMITS.maxServices}
                  className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                >
                  <Plus size={14} /> Add service
                </button>
                {priceBook.length > 0 && (
                  <select
                    aria-label="Add a service from your Price Book"
                    value=""
                    onChange={(e) => e.target.value && addService(e.target.value)}
                    className="focus-ring rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary"
                  >
                    <option value="">Add from Price Book…</option>
                    {priceBook.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.service_name} — {formatCents(p.price_cents)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </section>

            {/* Parts */}
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
                <Package size={15} className="text-accent" /> Required parts
              </h3>
              <div className="space-y-2.5">
                {form.parts.map((p, i) => (
                  <div key={p.key} className="flex items-center gap-2 rounded-xl border border-border bg-bg-primary p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text-primary">{p.part_name}</p>
                      {p.part_number && <p className="truncate text-xs text-text-secondary">{p.part_number}</p>}
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label={`${p.part_name} quantity`}
                      value={p.quantity}
                      onChange={(e) =>
                        patch({ parts: form.parts.map((x) => (x.key === p.key ? { ...x, quantity: e.target.value } : x)) })
                      }
                      className="focus-ring w-16 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-center text-sm text-text-primary"
                    />
                    <button
                      type="button"
                      onClick={() => patch({ parts: form.parts.filter((x) => x.key !== p.key) })}
                      className={`${iconButtonClass} hover:text-danger`}
                      aria-label={`Remove ${p.part_name} (part ${i + 1})`}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
              <FieldError message={errors.parts} />
              <div className="mt-2.5">
                {parts.length > 0 ? (
                  <select
                    aria-label="Add a part from inventory"
                    value=""
                    onChange={(e) => e.target.value && addPart(e.target.value)}
                    disabled={form.parts.length >= TEMPLATE_LIMITS.maxParts}
                    className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs text-text-secondary sm:w-auto"
                  >
                    <option value="">Add a part from inventory…</option>
                    {parts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.part_number ? ` (${p.part_number})` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-xs text-text-secondary">
                    No parts in your inventory yet. Add parts on the Inventory page to attach them to templates.
                  </p>
                )}
              </div>
            </section>

            {/* Checklist */}
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
                <ListChecks size={15} className="text-accent" /> Checklist
              </h3>
              <div className="space-y-2">
                {form.checklist.map((c, i) => (
                  <div key={c.key} className="flex items-center gap-1.5">
                    <span className="w-6 shrink-0 text-center text-xs text-text-secondary">{i + 1}</span>
                    <LineInput
                      type="text"
                      aria-label={`Checklist item ${i + 1}`}
                      value={c.label}
                      maxLength={TEMPLATE_LIMITS.checklistLabel}
                      onChange={(e) =>
                        patch({ checklist: form.checklist.map((x) => (x.key === c.key ? { ...x, label: e.target.value } : x)) })
                      }
                      placeholder="e.g. Photograph the data plate"
                    />
                    <button
                      type="button"
                      onClick={() => patch({ checklist: move(form.checklist, i, -1) })}
                      disabled={i === 0}
                      className={iconButtonClass}
                      aria-label={`Move item ${i + 1} up`}
                    >
                      <ArrowUp size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => patch({ checklist: move(form.checklist, i, 1) })}
                      disabled={i === form.checklist.length - 1}
                      className={iconButtonClass}
                      aria-label={`Move item ${i + 1} down`}
                    >
                      <ArrowDown size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => patch({ checklist: form.checklist.filter((x) => x.key !== c.key) })}
                      className={`${iconButtonClass} hover:text-danger`}
                      aria-label={`Remove checklist item ${i + 1}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
              <FieldError message={errors.checklist} />
              <button
                type="button"
                onClick={() => patch({ checklist: [...form.checklist, { key: newLineKey(), label: '' }] })}
                disabled={form.checklist.length >= TEMPLATE_LIMITS.maxChecklist}
                className="focus-ring mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
              >
                <Plus size={14} /> Add checklist item
              </button>
            </section>
          </div>

          <div className="flex items-center gap-3 border-t border-border px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <Button type="submit" size="sm" disabled={saving} className="flex-1">
              {saving ? 'Saving…' : templateId ? 'Save changes' : 'Create template'}
            </Button>
            <button
              type="button"
              onClick={onClose}
              className="focus-ring rounded-xl border border-border px-4 py-3 text-sm font-medium text-text-secondary hover:text-text-primary"
            >
              Cancel
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}

// ============================================================
// CARD
// ============================================================

function TemplateCard({
  template,
  busy,
  onEdit,
  onDuplicate,
  onToggleActive,
  onDelete,
}: {
  template: JobTemplateSummary;
  busy: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex flex-col rounded-2xl border border-border bg-bg-secondary p-4 ${template.active ? '' : 'opacity-70'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-text-primary">{template.name}</h3>
          <p className="mt-0.5 truncate text-xs text-text-secondary">
            {template.service_type ?? 'No service type'}
            {!template.active && ' · Archived'}
          </p>
        </div>
        <span className="shrink-0 rounded-lg bg-accent/10 px-2.5 py-1 text-sm font-semibold text-accent">
          {formatTemplatePrice(template.price_cents)}
        </span>
      </div>

      {template.description && <p className="mt-2 line-clamp-2 text-sm text-text-secondary">{template.description}</p>}

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs text-text-secondary">
        <div className="flex items-center gap-1.5">
          <Clock size={13} /> <dt className="sr-only">Duration</dt>
          <dd>{formatDuration(template.expected_duration_minutes)}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <Wrench size={13} /> <dt className="sr-only">Services</dt>
          <dd>{template.service_count} services</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <Package size={13} /> <dt className="sr-only">Parts</dt>
          <dd>{template.part_count} parts</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <ListChecks size={13} /> <dt className="sr-only">Checklist</dt>
          <dd>{template.checklist_count} checklist items</dd>
        </div>
      </dl>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
        <p className="text-xs text-text-secondary">
          {template.times_used === 0 ? 'Never used' : `Used ${template.times_used}×`}
        </p>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onEdit} disabled={busy} className={iconButtonClass} aria-label={`Edit ${template.name}`}>
            <Pencil size={16} />
          </button>
          <button type="button" onClick={onDuplicate} disabled={busy} className={iconButtonClass} aria-label={`Duplicate ${template.name}`}>
            <Copy size={16} />
          </button>
          <button
            type="button"
            onClick={onToggleActive}
            disabled={busy}
            className={iconButtonClass}
            aria-label={template.active ? `Archive ${template.name}` : `Restore ${template.name}`}
          >
            {template.active ? <Archive size={16} /> : <ArchiveRestore size={16} />}
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className={`${iconButtonClass} hover:text-danger`}
            aria-label={`Delete ${template.name}`}
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>
    </motion.article>
  );
}

// ============================================================
// PAGE
// ============================================================

export function JobTemplatesPage() {
  const { user, profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();

  const canManage = isOwner || permissions.can_view_billing;
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const [templates, setTemplates] = useState<JobTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<TemplateStatusFilter>('active');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ templateId: string | null; initial: JobTemplateFormState } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<JobTemplateSummary | null>(null);

  // Only the most recently started load may write state (guards against a
  // slow earlier response overwriting a fresher one after save/refresh).
  const loadIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!accountOwnerId) return;
    const id = ++loadIdRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await fetchJobTemplates(accountOwnerId);
      if (id !== loadIdRef.current) return;
      setTemplates(rows);
    } catch (err) {
      if (id !== loadIdRef.current) return;
      setLoadError(describeTemplateError(err, 'Could not load your templates.'));
    } finally {
      if (id === loadIdRef.current) setLoading(false);
    }
  }, [accountOwnerId]);

  useEffect(() => {
    if (user && canManage) void load();
  }, [user, canManage, load]);

  const visible = useMemo(() => filterTemplates(templates, search, status), [templates, search, status]);
  const counts = useMemo(
    () => ({
      active: templates.filter((t) => t.active).length,
      archived: templates.filter((t) => !t.active).length,
      all: templates.length,
    }),
    [templates]
  );

  const openCreate = () => setEditor({ templateId: null, initial: emptyTemplateForm() });

  const openEdit = async (t: JobTemplateSummary) => {
    if (!accountOwnerId || busyId) return;
    setBusyId(t.id);
    try {
      const detail = await fetchJobTemplateDetail(accountOwnerId, t.id);
      setEditor({ templateId: t.id, initial: templateToForm(detail) });
    } catch (err) {
      toast(describeTemplateError(err, 'Could not open the template.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleDuplicate = async (t: JobTemplateSummary) => {
    if (busyId) return;
    setBusyId(t.id);
    try {
      await duplicateJobTemplate(t.id);
      toast('Template duplicated.', 'success');
      await load();
    } catch (err) {
      toast(describeTemplateError(err, 'Could not duplicate the template.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleActive = async (t: JobTemplateSummary) => {
    if (!accountOwnerId || busyId) return;
    setBusyId(t.id);
    try {
      await setJobTemplateActive(accountOwnerId, t.id, !t.active);
      toast(t.active ? 'Template archived. It no longer appears in New Job.' : 'Template restored.', 'success');
      await load();
    } catch (err) {
      toast(describeTemplateError(err, 'Could not update the template.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!accountOwnerId || !pendingDelete) return;
    const target = pendingDelete;
    setBusyId(target.id);
    try {
      await deleteJobTemplate(accountOwnerId, target.id);
      toast('Template deleted.', 'success');
      setPendingDelete(null);
      await load();
    } catch (err) {
      toast(describeTemplateError(err, 'Could not delete the template.'), 'error');
      setPendingDelete(null);
    } finally {
      setBusyId(null);
    }
  };

  if (!canManage) {
    return (
      <DashboardLayout activeLabel="Job Templates">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Job template management is restricted because templates carry pricing. Ask your account owner to grant you the
            "View Billing" permission. You can still apply templates when you create a job.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const statusTabs: Array<{ key: TemplateStatusFilter; label: string }> = [
    { key: 'active', label: `Active (${counts.active})` },
    { key: 'archived', label: `Archived (${counts.archived})` },
    { key: 'all', label: `All (${counts.all})` },
  ];

  return (
    <DashboardLayout activeLabel="Job Templates">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <LayoutTemplate size={22} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-text-primary">Job Templates</h1>
            <p className="text-sm text-text-secondary">
              Save a common job once — services, parts, checklist, duration and price — and apply it when you create a job.
            </p>
          </div>
        </div>
        <Button type="button" size="sm" onClick={openCreate} disabled={!accountOwnerId}>
          <Plus size={16} /> New template
        </Button>
      </div>

      {!loading && !loadError && templates.length > 0 && (
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="sm:w-80">
            <Input
              type="search"
              icon={Search}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates"
              aria-label="Search templates"
              className="!py-2.5 !text-sm"
            />
          </div>
          <div role="tablist" aria-label="Template status" className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
            {statusTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={status === tab.key}
                onClick={() => setStatus(tab.key)}
                className={`focus-ring whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  status === tab.key ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <SkeletonCardList count={6} rows={3} />
      ) : loadError ? (
        <div role="alert" className="flex flex-col items-center rounded-2xl border border-border bg-bg-secondary px-6 py-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/10 text-danger">
            <AlertCircle size={24} />
          </span>
          <h3 className="mt-3 text-base font-semibold text-text-primary">Couldn't load templates</h3>
          <p className="mt-1 max-w-sm text-sm text-text-secondary">{loadError}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="focus-ring mt-4 inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-text-primary hover:border-accent/40"
          >
            <RefreshCw size={15} /> Try again
          </button>
        </div>
      ) : templates.length === 0 ? (
        <EmptyState
          icon={LayoutTemplate}
          title="No job templates yet"
          description="Create a template for the jobs you book most — like an AC tune-up — and apply it in one click from New Job."
          action={{ label: 'Create your first template', onClick: openCreate }}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No templates match"
          description={search.trim() ? 'Try a different search term or status filter.' : `You have no ${status} templates.`}
          secondaryAction={{
            label: 'Clear filters',
            onClick: () => {
              setSearch('');
              setStatus('all');
            },
          }}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              busy={busyId === t.id}
              onEdit={() => void openEdit(t)}
              onDuplicate={() => void handleDuplicate(t)}
              onToggleActive={() => void handleToggleActive(t)}
              onDelete={() => setPendingDelete(t)}
            />
          ))}
        </div>
      )}

      {editor && accountOwnerId && (
        <TemplateEditor
          accountOwnerId={accountOwnerId}
          initial={editor.initial}
          templateId={editor.templateId}
          onClose={() => setEditor(null)}
          onSaved={(message) => {
            setEditor(null);
            toast(message, 'success');
            void load();
          }}
        />
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete this template?"
        description={`"${pendingDelete?.name ?? ''}" will be removed. Jobs already created from it keep their services, checklist and price.`}
        confirmLabel="Yes, delete template"
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </DashboardLayout>
  );
}
