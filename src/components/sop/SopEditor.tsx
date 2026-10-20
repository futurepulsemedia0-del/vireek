import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { FileText, Paperclip, Plus, Trash2, X } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { SopMarkdown } from '@/components/sop/SopUi';
import {
  ASSIGNABLE_ROLES,
  SOP_ALLOWED_MIME,
  SOP_LIMITS,
  AssignmentTargetType,
  SopFormErrors,
  SopFormState,
  describeSopError,
  emptyAssignment,
  emptyQuestion,
  fetchTemplateChecklistLabels,
  hasErrors,
  normalizeItemKey,
  publishSop,
  saveSop,
  uploadSopFile,
  validateForPublish,
  validateSopForm,
} from '@/lib/sop';

export interface EditorLookups {
  members: Array<{ id: string; name: string; role: string }>;
  customRoles: Array<{ id: string; name: string }>;
  templates: Array<{ id: string; name: string }>;
}

const iconButtonClass =
  'focus-ring flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40';
const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary focus-visible:border-accent';

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-bold text-text-primary">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p role="alert" className="text-xs text-danger">{message}</p>;
}

export function SopEditor({
  accountOwnerId,
  sopId,
  initial,
  publishedVersion,
  lookups,
  onClose,
  onSaved,
}: {
  accountOwnerId: string;
  sopId: string | null;
  initial: SopFormState;
  publishedVersion: number;
  lookups: EditorLookups;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { toast } = useToast();
  const dialogRef = useFocusTrap(true);
  useEscapeToClose(true, onClose);

  const [form, setForm] = useState<SopFormState>(initial);
  const [errors, setErrors] = useState<SopFormErrors>({});
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'publish' | 'upload'>(null);
  const [changeNote, setChangeNote] = useState('');
  const [preview, setPreview] = useState(false);
  const [templateLabels, setTemplateLabels] = useState<Record<string, string[]>>({});
  const [labelsFailed, setLabelsFailed] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const currentSopId = useRef<string | null>(sopId);

  // Checklist labels for every template this SOP is linked to (so owners can pick items, not retype them).
  useEffect(() => {
    let cancelled = false;
    const missing = form.template_ids.filter((id) => !(id in templateLabels));
    if (missing.length === 0) return;
    Promise.all(missing.map((id) => fetchTemplateChecklistLabels(id).then((labels) => [id, labels] as const)))
      .then((pairs) => {
        if (cancelled) return;
        setLabelsFailed(false);
        setTemplateLabels((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
      })
      .catch(() => { if (!cancelled) setLabelsFailed(true); });
    return () => { cancelled = true; };
  }, [form.template_ids, templateLabels]);

  const revalidate = (next: SopFormState) => { if (attempted) setErrors(validateSopForm(next)); };
  const update = (p: Partial<SopFormState>) => {
    const next = { ...form, ...p };
    setForm(next);
    revalidate(next);
  };

  const templateName = useMemo(() => new Map(lookups.templates.map((t) => [t.id, t.name])), [lookups.templates]);

  const toggleTemplate = (id: string) => {
    const on = form.template_ids.includes(id);
    update({
      template_ids: on ? form.template_ids.filter((t) => t !== id) : [...form.template_ids, id],
      checklist_links: on ? form.checklist_links.filter((l) => l.template_id !== id) : form.checklist_links,
    });
  };

  const toggleItem = (templateId: string, label: string) => {
    const key = normalizeItemKey(label);
    const exists = form.checklist_links.some((l) => l.template_id === templateId && normalizeItemKey(l.item_label) === key);
    update({
      checklist_links: exists
        ? form.checklist_links.filter((l) => !(l.template_id === templateId && normalizeItemKey(l.item_label) === key))
        : [...form.checklist_links, { template_id: templateId, item_label: label }],
    });
  };

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy('upload');
    try {
      const up = await uploadSopFile(accountOwnerId, currentSopId.current, file);
      update({ file_path: up.path, file_name: up.name, file_mime: up.mime });
    } catch (err) {
      toast(describeSopError(err, 'Could not upload the file.'), 'error');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const persist = async (): Promise<string | null> => {
    setAttempted(true);
    const found = validateSopForm(form);
    setErrors(found);
    if (hasErrors(found)) return null;
    const id = await saveSop(currentSopId.current, form);
    currentSopId.current = id;
    return id;
  };

  const saveDraft = async () => {
    setBusy('save');
    try {
      const id = await persist();
      if (id) onSaved(publishedVersion > 0 ? 'Changes saved. Publish to roll them out.' : 'Draft saved.');
    } catch (err) {
      toast(describeSopError(err, 'Could not save the SOP.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    const problem = validateForPublish(form);
    setAttempted(true);
    if (problem) {
      setErrors({ ...validateSopForm(form), ...(form.assignments.length === 0 ? { assignments: problem } : { content: problem }) });
      toast(problem, 'error');
      return;
    }
    setBusy('publish');
    try {
      const id = await persist();
      if (!id) return;
      const version = await publishSop(id, changeNote);
      onSaved(`Published as version ${version}. Assigned people have been asked to acknowledge it.`);
    } catch (err) {
      toast(describeSopError(err, 'Could not publish the SOP.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const disabled = busy !== null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sop-editor-title"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="relative flex h-[94dvh] w-full max-w-3xl flex-col rounded-t-2xl border border-border bg-bg-secondary shadow-card-hover sm:h-auto sm:max-h-[90vh] sm:rounded-2xl dark:shadow-card-hover-dark"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="sop-editor-title" className="text-lg font-bold text-text-primary">
            {sopId ? 'Edit SOP' : 'New SOP'}
            {publishedVersion > 0 && <span className="ml-2 text-xs font-medium text-text-secondary">Published v{publishedVersion}</span>}
          </h2>
          <button type="button" onClick={onClose} className={iconButtonClass} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-7 overflow-y-auto px-5 py-5">
          <Section title="Details">
            <Input
              label="Title"
              required
              value={form.title}
              maxLength={SOP_LIMITS.title}
              onChange={(e) => update({ title: e.target.value })}
              error={errors.title}
              placeholder="e.g. Refrigerant recovery and handling"
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Category"
                value={form.category}
                maxLength={SOP_LIMITS.category}
                onChange={(e) => update({ category: e.target.value })}
                placeholder="Safety, Install, Customer care…"
              />
              <Input
                label="One-line summary"
                value={form.summary}
                maxLength={SOP_LIMITS.summary}
                onChange={(e) => update({ summary: e.target.value })}
              />
            </div>
          </Section>

          <Section title="Procedure" hint="Write it here, attach a file (PDF, Word, image, MP4), or both. Markdown: # headings, - lists, - [ ] checklists, **bold**.">
            <div className="flex gap-1 rounded-xl border border-border bg-bg-primary p-1 text-xs font-medium" role="tablist" aria-label="Procedure view">
              {(['Write', 'Preview'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={preview === (tab === 'Preview')}
                  onClick={() => setPreview(tab === 'Preview')}
                  className={`focus-ring flex-1 rounded-lg px-3 py-1.5 ${preview === (tab === 'Preview') ? 'bg-accent text-white' : 'text-text-secondary'}`}
                >
                  {tab}
                </button>
              ))}
            </div>
            {preview ? (
              <div className="min-h-[12rem] rounded-xl border border-border bg-bg-primary p-4">
                {form.body_md.trim() ? <SopMarkdown source={form.body_md} /> : <p className="text-sm text-text-secondary">Nothing to preview yet.</p>}
              </div>
            ) : (
              <Textarea
                aria-label="Procedure text"
                value={form.body_md}
                maxLength={SOP_LIMITS.body}
                onChange={(e) => update({ body_md: e.target.value })}
                rows={12}
                error={errors.content}
                placeholder={'# Purpose\n\n# Steps\n1. …\n\n# Safety\n- [ ] PPE on'}
              />
            )}
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={fileRef}
                type="file"
                accept={SOP_ALLOWED_MIME.join(',')}
                className="sr-only"
                id="sop-file-input"
                onChange={(e) => void onPickFile(e.target.files?.[0])}
                disabled={disabled}
              />
              <label
                htmlFor="sop-file-input"
                className={`focus-ring inline-flex cursor-pointer items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary hover:bg-bg-tertiary ${disabled ? 'pointer-events-none opacity-50' : ''}`}
              >
                <Paperclip size={16} /> {busy === 'upload' ? 'Uploading…' : form.file_path ? 'Replace file' : 'Attach file'}
              </label>
              {form.file_path && (
                <span className="inline-flex items-center gap-2 text-sm text-text-secondary">
                  <FileText size={16} /> {form.file_name}
                  <button type="button" className="text-danger underline" onClick={() => update({ file_path: null, file_name: null, file_mime: null })}>
                    Remove
                  </button>
                </span>
              )}
            </div>
          </Section>

          <Section title="Quiz (optional)" hint="Graded on the server — learners never receive the answers. Passing is required before they can acknowledge.">
            {form.quiz.length > 0 && (
              <div className="max-w-xs">
                <Input
                  label="Pass mark (%)"
                  type="number"
                  min={1}
                  max={100}
                  value={String(form.pass_score_pct)}
                  onChange={(e) => update({ pass_score_pct: Number(e.target.value) })}
                  error={errors.pass_score_pct}
                />
              </div>
            )}
            {form.quiz.map((q, qi) => (
              <div key={q.key} className="space-y-3 rounded-xl border border-border bg-bg-primary p-4">
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <Input
                      label={`Question ${qi + 1}`}
                      value={q.prompt}
                      maxLength={SOP_LIMITS.question}
                      onChange={(e) => update({ quiz: form.quiz.map((x) => (x.key === q.key ? { ...x, prompt: e.target.value } : x)) })}
                    />
                  </div>
                  <button type="button" className={`${iconButtonClass} mt-7`} aria-label={`Remove question ${qi + 1}`} onClick={() => update({ quiz: form.quiz.filter((x) => x.key !== q.key) })}>
                    <Trash2 size={16} />
                  </button>
                </div>
                <fieldset className="space-y-2">
                  <legend className="mb-1 text-xs text-text-secondary">Answers — select the correct one</legend>
                  {q.options.map((opt, oi) => (
                    <div key={oi} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name={`correct-${q.key}`}
                        checked={q.correct_index === oi}
                        onChange={() => update({ quiz: form.quiz.map((x) => (x.key === q.key ? { ...x, correct_index: oi } : x)) })}
                        aria-label={`Mark answer ${oi + 1} correct`}
                        className="h-4 w-4 accent-[rgb(var(--accent))]"
                      />
                      <Input
                        aria-label={`Answer ${oi + 1}`}
                        value={opt}
                        maxLength={SOP_LIMITS.option}
                        className="!px-3.5 !py-2 !text-sm"
                        onChange={(e) => update({ quiz: form.quiz.map((x) => (x.key === q.key ? { ...x, options: x.options.map((o, i) => (i === oi ? e.target.value : o)) } : x)) })}
                      />
                      <button
                        type="button"
                        className={iconButtonClass}
                        aria-label={`Remove answer ${oi + 1}`}
                        disabled={q.options.length <= SOP_LIMITS.minOptions}
                        onClick={() =>
                          update({
                            quiz: form.quiz.map((x) => {
                              if (x.key !== q.key) return x;
                              const options = x.options.filter((_, i) => i !== oi);
                              const correct = x.correct_index === oi ? 0 : x.correct_index > oi ? x.correct_index - 1 : x.correct_index;
                              return { ...x, options, correct_index: correct };
                            }),
                          })
                        }
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                  {q.options.length < SOP_LIMITS.maxOptions && (
                    <button type="button" className="text-xs font-semibold text-accent" onClick={() => update({ quiz: form.quiz.map((x) => (x.key === q.key ? { ...x, options: [...x.options, ''] } : x)) })}>
                      + Add answer
                    </button>
                  )}
                </fieldset>
              </div>
            ))}
            <FieldError message={errors.quiz} />
            {form.quiz.length < SOP_LIMITS.maxQuestions && (
              <Button type="button" variant="secondary" size="sm" onClick={() => update({ quiz: [...form.quiz, emptyQuestion()] })}>
                <Plus size={16} /> Add question
              </Button>
            )}
          </Section>

          <Section title="Who must complete it" hint="Assign to everyone, a role, a custom role or a specific person. Each can have its own due date.">
            {form.assignments.map((a) => (
              <div key={a.key} className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-bg-primary p-3">
                <label className="min-w-[9rem] flex-1 text-xs text-text-secondary">
                  Assign to
                  <select
                    className={`${selectClass} mt-1`}
                    value={a.target_type}
                    onChange={(e) => update({ assignments: form.assignments.map((x) => (x.key === a.key ? { ...x, target_type: e.target.value as AssignmentTargetType } : x)) })}
                  >
                    <option value="everyone">Everyone</option>
                    <option value="role">A role</option>
                    {lookups.customRoles.length > 0 && <option value="custom_role">A custom role</option>}
                    <option value="member">A person</option>
                  </select>
                </label>
                {a.target_type === 'role' && (
                  <label className="min-w-[9rem] flex-1 text-xs text-text-secondary">
                    Role
                    <select className={`${selectClass} mt-1`} value={a.target_role} onChange={(e) => update({ assignments: form.assignments.map((x) => (x.key === a.key ? { ...x, target_role: e.target.value as typeof a.target_role } : x)) })}>
                      {ASSIGNABLE_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </select>
                  </label>
                )}
                {a.target_type === 'custom_role' && (
                  <label className="min-w-[9rem] flex-1 text-xs text-text-secondary">
                    Custom role
                    <select className={`${selectClass} mt-1`} value={a.target_custom_role_id} onChange={(e) => update({ assignments: form.assignments.map((x) => (x.key === a.key ? { ...x, target_custom_role_id: e.target.value } : x)) })}>
                      <option value="">Choose…</option>
                      {lookups.customRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </label>
                )}
                {a.target_type === 'member' && (
                  <label className="min-w-[9rem] flex-1 text-xs text-text-secondary">
                    Person
                    <select className={`${selectClass} mt-1`} value={a.target_member_id} onChange={(e) => update({ assignments: form.assignments.map((x) => (x.key === a.key ? { ...x, target_member_id: e.target.value } : x)) })}>
                      <option value="">Choose…</option>
                      {lookups.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </label>
                )}
                <label className="text-xs text-text-secondary">
                  Due
                  <input type="date" className={`${selectClass} mt-1`} value={a.due_date} onChange={(e) => update({ assignments: form.assignments.map((x) => (x.key === a.key ? { ...x, due_date: e.target.value } : x)) })} />
                </label>
                <button type="button" className={iconButtonClass} aria-label="Remove assignment" onClick={() => update({ assignments: form.assignments.filter((x) => x.key !== a.key) })}>
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            <FieldError message={errors.assignments} />
            <Button type="button" variant="secondary" size="sm" onClick={() => update({ assignments: [...form.assignments, emptyAssignment()] })}>
              <Plus size={16} /> Add assignment
            </Button>
          </Section>

          <Section title="Link to job templates & checklists" hint="Crew on a job built from a linked template see this SOP right on the job, and the linked checklist items point to it.">
            {lookups.templates.length === 0 ? (
              <p className="text-sm text-text-secondary">No job templates yet. Create one under Job Templates to link it here.</p>
            ) : (
              <div className="space-y-2">
                {lookups.templates.map((t) => {
                  const linked = form.template_ids.includes(t.id);
                  const labels = templateLabels[t.id] ?? [];
                  return (
                    <div key={t.id} className="rounded-xl border border-border bg-bg-primary p-3">
                      <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-text-primary">
                        <input type="checkbox" checked={linked} onChange={() => toggleTemplate(t.id)} className="h-4 w-4 accent-[rgb(var(--accent))]" />
                        {templateName.get(t.id) ?? t.name}
                      </label>
                      {linked && labels.length > 0 && (
                        <ul className="mt-2 space-y-1 border-t border-border pt-2">
                          {labels.map((label) => {
                            const on = form.checklist_links.some((l) => l.template_id === t.id && normalizeItemKey(l.item_label) === normalizeItemKey(label));
                            return (
                              <li key={label}>
                                <label className="flex cursor-pointer items-center gap-2 text-xs text-text-secondary">
                                  <input type="checkbox" checked={on} onChange={() => toggleItem(t.id, label)} className="h-3.5 w-3.5 accent-[rgb(var(--accent))]" />
                                  Checklist: {label}
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {labelsFailed && <p role="alert" className="text-xs text-danger">Could not load checklist items for a linked template.</p>}
            <FieldError message={errors.checklist_links} />
          </Section>
        </div>

        <div className="space-y-3 border-t border-border px-5 py-4">
          {publishedVersion > 0 && (
            <Input
              aria-label="What changed (shown in version history)"
              placeholder="What changed? (optional — people who already acknowledged will be asked to re-acknowledge)"
              value={changeNote}
              maxLength={SOP_LIMITS.changeNote}
              onChange={(e) => setChangeNote(e.target.value)}
              className="!py-2 !text-sm"
            />
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={disabled}>Cancel</Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => void saveDraft()} disabled={disabled}>
              {busy === 'save' ? 'Saving…' : 'Save draft'}
            </Button>
            <Button type="button" size="sm" onClick={() => void publish()} disabled={disabled}>
              {busy === 'publish' ? 'Publishing…' : publishedVersion > 0 ? 'Publish new version' : 'Publish'}
            </Button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
