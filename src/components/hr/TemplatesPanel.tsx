import { useState, type FormEvent } from 'react';
import { ChevronDown, ChevronUp, ClipboardList, FileText, Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ChecklistForm, type ChecklistValues } from '@/components/hr/ChecklistForm';
import { FormShell, Pill, type HrCtx } from '@/components/hr/HrUi';
import { useToast } from '@/contexts/ToastContext';
import { CATEGORY_LABELS, DOC_TYPE_LABELS, SHORT_TEXT_LIMIT, validateTemplate, type Template, type TemplateItem } from '@/lib/hrOnboarding';
import {
  archiveTemplate,
  createTemplate,
  createTemplateItem,
  deleteTemplateItem,
  describeHrError,
  seedStarterTemplates,
  updateTemplate,
  updateTemplateItem,
} from '@/lib/hrOnboardingApi';

export function TemplatesPanel({ ctx }: { ctx: HrCtx }) {
  const { data, ownerId, patch, reload } = ctx;
  const { toast } = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<Template | null>(null);
  const [seeding, setSeeding] = useState(false);

  const seed = async () => {
    setSeeding(true);
    try {
      await seedStarterTemplates();
      await reload();
      toast('Starter templates added', 'success');
    } catch (e) {
      toast(describeHrError(e), 'error');
    } finally {
      setSeeding(false);
    }
  };

  const confirmArchive = async () => {
    const t = archiveTarget;
    setArchiveTarget(null);
    if (!t) return;
    try {
      await archiveTemplate(t.id, ownerId);
      patch((d) => ({ ...d, templates: d.templates.filter((x) => x.id !== t.id) }));
      toast('Template archived', 'success');
    } catch (e) {
      toast(describeHrError(e), 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-secondary">
          A template is a reusable checklist. Each line becomes a task due a set number of days after the employee&apos;s start date; lines with a document create a document request.
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus size={16} aria-hidden="true" /> New template
        </Button>
      </div>

      {creating && (
        <TemplateForm
          heading="New template"
          existingNames={data.templates.map((t) => t.name)}
          onCancel={() => setCreating(false)}
          onSubmit={async (draft) => {
            try {
              const created = await createTemplate(ownerId, draft);
              patch((d) => ({ ...d, templates: [...d.templates, created].sort((a, b) => a.name.localeCompare(b.name)) }));
              setCreating(false);
              setExpanded(created.id);
              toast('Template created — add its checklist lines', 'success');
              return true;
            } catch (e) {
              toast(describeHrError(e), 'error');
              return false;
            }
          }}
        />
      )}

      {data.templates.length === 0 && !creating ? (
        <EmptyState
          icon={ClipboardList}
          title="No templates yet"
          description="Start from our ready-made Field technician and Office / dispatcher checklists, or build your own."
          action={{ label: seeding ? 'Adding…' : 'Add starter templates', onClick: () => void seed() }}
          secondaryAction={{ label: 'New template', onClick: () => setCreating(true) }}
        />
      ) : (
        <ul className="space-y-3" aria-label="Onboarding templates">
          {data.templates.map((t) => (
            <TemplateCard key={t.id} ctx={ctx} template={t} open={expanded === t.id} onToggle={() => setExpanded((c) => (c === t.id ? null : t.id))} onArchive={() => setArchiveTarget(t)} />
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={archiveTarget !== null}
        title="Archive this template?"
        description={archiveTarget ? `"${archiveTarget.name}" will no longer be offered for new onboardings. Existing onboardings keep their tasks.` : ''}
        confirmLabel="Archive template"
        onConfirm={() => void confirmArchive()}
        onCancel={() => setArchiveTarget(null)}
      />
    </div>
  );
}

function TemplateForm({
  heading,
  initial,
  existingNames,
  onSubmit,
  onCancel,
}: {
  heading: string;
  initial?: { name: string; description: string };
  existingNames: readonly string[];
  onSubmit: (draft: { name: string; description: string }) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial ?? { name: '', description: '' });
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const errors = validateTemplate(draft, existingNames);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setAttempted(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    try {
      await onSubmit(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormShell title={heading}>
      <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4">
        <Input label="Name" required value={draft.name} maxLength={80} error={attempted ? errors.name : undefined} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
        <Textarea label="Description (optional)" rows={2} value={draft.description} maxLength={SHORT_TEXT_LIMIT} error={attempted ? errors.description : undefined} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? 'Saving…' : 'Save template'}
          </Button>
        </div>
      </form>
    </FormShell>
  );
}

function TemplateCard({ ctx, template, open, onToggle, onArchive }: { ctx: HrCtx; template: Template; open: boolean; onToggle: () => void; onArchive: () => void }) {
  const { data, ownerId, patch } = ctx;
  const { toast } = useToast();
  const [renaming, setRenaming] = useState(false);
  const [itemForm, setItemForm] = useState<{ mode: 'new' } | { mode: 'edit'; item: TemplateItem } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TemplateItem | null>(null);

  const setItems = (fn: (items: TemplateItem[]) => TemplateItem[]) =>
    patch((d) => ({ ...d, templates: d.templates.map((t) => (t.id === template.id ? { ...t, items: fn(t.items) } : t)) }));

  const saveItem = async (v: ChecklistValues): Promise<boolean> => {
    try {
      if (itemForm?.mode === 'edit') {
        const saved = await updateTemplateItem(itemForm.item.id, ownerId, v);
        setItems((items) => items.map((i) => (i.id === saved.id ? saved : i)));
      } else {
        const next = template.items.reduce((m, i) => Math.max(m, i.sort_order), 0) + 10;
        const created = await createTemplateItem(ownerId, template.id, v, next);
        setItems((items) => [...items, created]);
      }
      setItemForm(null);
      toast('Checklist line saved', 'success');
      return true;
    } catch (e) {
      toast(describeHrError(e), 'error');
      return false;
    }
  };

  const confirmDelete = async () => {
    const item = deleteTarget;
    setDeleteTarget(null);
    if (!item) return;
    try {
      await deleteTemplateItem(item.id, ownerId);
      setItems((items) => items.filter((i) => i.id !== item.id));
      toast('Line removed', 'success');
    } catch (e) {
      toast(describeHrError(e), 'error');
    }
  };

  return (
    <li className="rounded-2xl border border-border bg-bg-secondary">
      <button type="button" onClick={onToggle} aria-expanded={open} className="focus-ring flex w-full items-center gap-3 rounded-2xl p-4 text-left">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-text-primary">{template.name}</p>
          <p className="mt-0.5 text-xs text-text-secondary">
            {template.items.length} line{template.items.length === 1 ? '' : 's'} · {template.items.filter((i) => i.document_type).length} documents
            {template.description ? ` · ${template.description}` : ''}
          </p>
        </div>
        {open ? <ChevronUp size={18} aria-hidden="true" className="text-text-secondary" /> : <ChevronDown size={18} aria-hidden="true" className="text-text-secondary" />}
      </button>

      {open && (
        <div className="space-y-4 border-t border-border p-4">
          {renaming && (
            <TemplateForm
              heading="Edit template"
              initial={{ name: template.name, description: template.description ?? '' }}
              existingNames={data.templates.filter((t) => t.id !== template.id).map((t) => t.name)}
              onCancel={() => setRenaming(false)}
              onSubmit={async (draft) => {
                try {
                  await updateTemplate(template.id, ownerId, draft);
                  patch((d) => ({ ...d, templates: d.templates.map((t) => (t.id === template.id ? { ...t, name: draft.name.trim(), description: draft.description.trim() || null } : t)) }));
                  setRenaming(false);
                  return true;
                } catch (e) {
                  toast(describeHrError(e), 'error');
                  return false;
                }
              }}
            />
          )}

          {template.items.length === 0 ? (
            <p className="text-sm text-text-secondary">No lines yet. Add the first checklist line below.</p>
          ) : (
            <ul className="space-y-2">
              {template.items.map((i) => (
                <li key={i.id} className="flex items-start gap-3 rounded-xl border border-border bg-bg-primary p-3">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium text-text-primary">{i.title}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <Pill tone="accent">{CATEGORY_LABELS[i.category]}</Pill>
                      <Pill>{i.due_offset_days === 0 ? 'Day 0' : `Day ${i.due_offset_days}`}</Pill>
                      {!i.required && <Pill>Optional</Pill>}
                      {i.document_type && (
                        <Pill tone="warning">
                          <FileText size={11} aria-hidden="true" className="mr-1" />
                          {DOC_TYPE_LABELS[i.document_type]}
                        </Pill>
                      )}
                    </div>
                    {i.description && <p className="mt-1 break-words text-xs text-text-secondary">{i.description}</p>}
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    <Button variant="ghost" size="sm" className="!min-h-[36px] !px-2 text-xs" onClick={() => setItemForm({ mode: 'edit', item: i })}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" className="!min-h-[36px] !px-2" aria-label={`Remove "${i.title}"`} onClick={() => setDeleteTarget(i)}>
                      <Trash2 size={15} aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {itemForm ? (
            <ChecklistForm
              key={itemForm.mode === 'edit' ? itemForm.item.id : 'new'}
              mode="template"
              heading={itemForm.mode === 'edit' ? 'Edit checklist line' : 'Add checklist line'}
              submitLabel={itemForm.mode === 'edit' ? 'Save line' : 'Add line'}
              initial={
                itemForm.mode === 'edit'
                  ? {
                      title: itemForm.item.title,
                      description: itemForm.item.description ?? '',
                      category: itemForm.item.category,
                      required: itemForm.item.required,
                      document_type: itemForm.item.document_type ?? '',
                      due_offset_days: String(itemForm.item.due_offset_days),
                    }
                  : undefined
              }
              onSubmit={saveItem}
              onCancel={() => setItemForm(null)}
            />
          ) : (
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="secondary" size="sm" onClick={() => setItemForm({ mode: 'new' })}>
                <Plus size={16} aria-hidden="true" /> Add line
              </Button>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setRenaming((r) => !r)}>
                  Rename / describe
                </Button>
                <Button variant="ghost" size="sm" onClick={onArchive}>
                  Archive
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remove this line?"
        description={deleteTarget ? `"${deleteTarget.title}" will be removed from the template. Onboardings already started are not changed.` : ''}
        confirmLabel="Remove line"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </li>
  );
}
