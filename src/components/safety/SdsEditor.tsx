import { useRef, useState } from 'react';
import { FileText, Loader2, Paperclip, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  HAZARD_CLASSES,
  SIGNAL_LABEL,
  SDS_LIMITS,
  describeSdsError,
  hasSdsErrors,
  removeSdsFile,
  saveSds,
  uploadSdsFile,
  validateSdsFile,
  validateSdsForm,
  type SdsDocument,
  type SdsForm,
  type SdsFormErrors,
  type SdsHazardClass,
  type SdsSignal,
} from '@/lib/sds';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-3 text-base text-text-primary focus-visible:border-accent';

interface SdsEditorProps {
  accountOwnerId: string;
  sdsId: string | null;
  initial: SdsForm;
  onClose: () => void;
  onSaved: (doc: SdsDocument, message: string) => void;
}

export function SdsEditor({ accountOwnerId, sdsId, initial, onClose, onSaved }: SdsEditorProps) {
  const [form, setForm] = useState<SdsForm>(initial);
  const [errors, setErrors] = useState<SdsFormErrors>({});
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Files uploaded during THIS editing session; anything not kept is cleaned up.
  const sessionUploads = useRef<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = saving || uploading;

  const dialogRef = useFocusTrap(true);
  const close = () => {
    if (busy) return;
    sessionUploads.current.forEach((p) => void removeSdsFile(p));
    onClose();
  };
  useEscapeToClose(true, close);

  const update = (patch: Partial<SdsForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    const keys = Object.keys(patch) as Array<keyof SdsForm>;
    setErrors((e) => {
      if (!keys.some((k) => e[k])) return e;
      const next = { ...e };
      keys.forEach((k) => delete next[k]);
      return next;
    });
  };

  const toggleHazard = (key: SdsHazardClass) =>
    update({
      hazard_classes: form.hazard_classes.includes(key) ? form.hazard_classes.filter((h) => h !== key) : [...form.hazard_classes, key],
    });

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setMessage(null);
    const problem = validateSdsFile(file);
    if (problem) {
      setMessage(problem);
      return;
    }
    setUploading(true);
    try {
      const up = await uploadSdsFile(accountOwnerId, file);
      sessionUploads.current.push(up.file_path);
      update(up);
    } catch (err) {
      setMessage(describeSdsError(err, 'The upload failed. Check your connection and try again.'));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const save = async () => {
    const found = validateSdsForm(form);
    setErrors(found);
    if (hasSdsErrors(found)) {
      setMessage('Fix the highlighted fields and try again.');
      return;
    }
    setMessage(null);
    setSaving(true);
    try {
      const doc = await saveSds(accountOwnerId, sdsId, form);
      sessionUploads.current.filter((p) => p !== doc.file_path).forEach((p) => void removeSdsFile(p));
      onSaved(doc, sdsId ? 'Safety data sheet updated.' : 'Safety data sheet added.');
    } catch (err) {
      setMessage(describeSdsError(err, 'Could not save the sheet.'));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={close} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sds-editor-title"
        className="relative flex h-[94dvh] w-full max-w-3xl flex-col rounded-t-2xl border border-border bg-bg-secondary shadow-card-hover sm:h-auto sm:max-h-[90vh] sm:rounded-2xl dark:shadow-card-hover-dark"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 id="sds-editor-title" className="text-lg font-bold text-text-primary">
            {sdsId ? 'Edit safety data sheet' : 'Add safety data sheet'}
          </h2>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label="Close"
            className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-40"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Input
                label="Product name"
                required
                value={form.product_name}
                onChange={(e) => update({ product_name: e.target.value })}
                error={errors.product_name}
                maxLength={SDS_LIMITS.productName + 20}
                placeholder="e.g. R-410A refrigerant"
              />
            </div>
            <Input label="Manufacturer" value={form.manufacturer} onChange={(e) => update({ manufacturer: e.target.value })} error={errors.manufacturer} />
            <Input label="Product code / SKU" value={form.product_code} onChange={(e) => update({ product_code: e.target.value })} error={errors.product_code} />
            <div className="sm:col-span-2">
              <Input
                label="CAS numbers"
                value={form.cas_text}
                onChange={(e) => update({ cas_text: e.target.value })}
                error={errors.cas_text}
                helperText="Separate several with commas. Example: 75-10-5, 354-33-6"
                inputMode="text"
                autoCapitalize="none"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="sds-signal" className="mb-1.5 block text-sm font-medium text-text-primary">Signal word</label>
              <select id="sds-signal" className={selectClass} value={form.signal_word} onChange={(e) => update({ signal_word: e.target.value as SdsSignal })}>
                {(Object.keys(SIGNAL_LABEL) as SdsSignal[]).map((s) => (
                  <option key={s} value={s}>{SIGNAL_LABEL[s]}</option>
                ))}
              </select>
            </div>
            <Input label="Where it is kept" value={form.location} onChange={(e) => update({ location: e.target.value })} error={errors.location} placeholder="e.g. Van 3, shop shelf B" />
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-text-primary">Hazard classes</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {HAZARD_CLASSES.map((h) => {
                const checked = form.hazard_classes.includes(h.key);
                return (
                  <label
                    key={h.key}
                    className={`focus-within:ring-2 focus-within:ring-accent/40 flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors ${checked ? 'border-accent bg-accent/10 text-text-primary' : 'border-border text-text-secondary hover:bg-bg-tertiary'}`}
                  >
                    <input type="checkbox" className="h-4 w-4 accent-accent" checked={checked} onChange={() => toggleHazard(h.key)} />
                    {h.label}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <Textarea label="Hazard statements" rows={3} value={form.hazard_statements} onChange={(e) => update({ hazard_statements: e.target.value })} error={errors.hazard_statements} helperText="Section 2 of the sheet, e.g. “Contains gas under pressure; may explode if heated.”" />
          <Textarea label="First aid" rows={3} value={form.first_aid} onChange={(e) => update({ first_aid: e.target.value })} error={errors.first_aid} helperText="Section 4. This shows up on the job so a technician can read it fast." />
          <div className="grid gap-4 sm:grid-cols-2">
            <Textarea label="Required PPE" rows={3} value={form.ppe} onChange={(e) => update({ ppe: e.target.value })} error={errors.ppe} />
            <Textarea label="Storage and handling" rows={3} value={form.storage_notes} onChange={(e) => update({ storage_notes: e.target.value })} error={errors.storage_notes} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input type="date" label="Sheet revision date" value={form.revision_date} onChange={(e) => update({ revision_date: e.target.value })} error={errors.revision_date} />
            <Input type="date" label="Review by" value={form.review_due_date} onChange={(e) => update({ review_due_date: e.target.value })} error={errors.review_due_date} helperText="Reminds you to confirm this is still the current sheet." />
          </div>

          <div>
            <p className="mb-1.5 text-sm font-medium text-text-primary">Manufacturer sheet (PDF or photo)</p>
            <input
              ref={fileInput}
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              className="sr-only"
              aria-label="Choose SDS file"
              onChange={(e) => void onPickFile(e.target.files?.[0])}
            />
            {form.file_path ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary px-3 py-2.5">
                <span className="flex min-w-0 items-center gap-2 text-sm text-text-primary">
                  <FileText size={16} className="shrink-0 text-accent" aria-hidden="true" />
                  <span className="truncate">{form.file_name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>Replace</Button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label="Remove file"
                    onClick={() => update({ file_path: null, file_name: null, file_mime: null })}
                    className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={16} />
                  </button>
                </span>
              </div>
            ) : (
              <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>
                {uploading ? <Loader2 size={16} className="animate-spin" /> : <Paperclip size={16} />} {uploading ? 'Uploading…' : 'Attach file'}
              </Button>
            )}
            <p className="mt-1.5 text-xs text-text-secondary">PDF, JPG, PNG or WebP, up to 25 MB. Stored privately for your team only.</p>
          </div>

          {message && <p role="alert" className="text-sm text-danger">{message}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
          <Button type="button" variant="ghost" size="sm" onClick={close} disabled={busy}>Cancel</Button>
          <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>
            {saving ? <Loader2 size={16} className="animate-spin" /> : null} {saving ? 'Saving…' : 'Save sheet'}
          </Button>
        </div>
      </div>
    </div>
  );
}
