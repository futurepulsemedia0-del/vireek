import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Check, PenLine, RotateCcw, X } from 'lucide-react';
import { Input, Textarea } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { SignaturePad } from '@/components/signatures/SignaturePad';
import type { SignaturePadValue } from '@/components/signatures/SignaturePad';
import { compressImage } from '@/lib/offline/capture';
import { noteKey, photoBounds } from '@/lib/offline/formLogic';
import type { FormField, FormTemplate } from '@/lib/offline/formSchema';
import type { FormSession } from './useFormSession';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

function choiceClass(active: boolean, tone: 'accent' | 'success' | 'danger' | 'muted' = 'accent') {
  const activeTone = {
    accent: 'border-accent bg-accent/10 text-accent',
    success: 'border-success bg-success/10 text-success',
    danger: 'border-danger bg-danger/10 text-danger',
    muted: 'border-text-secondary bg-bg-tertiary text-text-primary',
  }[tone];
  return `focus-ring min-h-[48px] flex-1 rounded-xl border px-3 text-sm font-semibold transition-colors ${
    active ? activeTone : 'border-border bg-bg-primary text-text-primary hover:border-accent/40'
  }`;
}

function PhotoThumb({ blob, label, onRemove }: { blob: Blob; label: string; onRemove: () => void }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="relative h-20 w-20 overflow-hidden rounded-xl border border-border bg-bg-tertiary">
      <img src={url} alt={label} className="h-full w-full object-cover" />
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="focus-ring absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white"
      >
        <X size={13} />
      </button>
    </div>
  );
}

function PhotoField({ field, session, disabled }: { field: FormField; session: FormSession; disabled: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const list = session.attachments.photos[field.id] ?? [];
  const { max } = photoBounds(field);
  const full = list.length >= max;

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      const room = Math.max(0, max - list.length);
      const picked = Array.from(files).slice(0, room);
      const compressed = await Promise.all(picked.map((f) => compressImage(f)));
      session.addPhotos(field.id, compressed);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="space-y-2.5">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple={max > 1}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => void onFiles(e.target.files)}
      />
      {list.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {list.map((p, i) => (
            <PhotoThumb key={p.id} blob={p.blob} label={`${field.label} photo ${i + 1}`} onRemove={() => session.removePhoto(field.id, p.id)} />
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button type="button" variant="secondary" size="sm" disabled={disabled || busy || full} onClick={() => inputRef.current?.click()}>
          <Camera size={16} /> {busy ? 'Saving…' : list.length === 0 ? 'Take photo' : 'Add another'}
        </Button>
        <span className="text-xs text-text-secondary">
          {list.length} of {max}
        </span>
      </div>
    </div>
  );
}

function SignatureField({ field, session, disabled }: { field: FormField; session: FormSession; disabled: boolean }) {
  const saved = session.attachments.signatures[field.id];
  const [signerName, setSignerName] = useState('');
  const [pending, setPending] = useState<SignaturePadValue | null>(null);
  const [padKey, setPadKey] = useState(0);

  if (saved) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-success/40 bg-success/10 px-4 py-3">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-text-primary">
          <Check size={16} className="shrink-0 text-success" />
          <span className="truncate">Signed by {saved.signerName}</span>
        </span>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => session.setSignature(field.id, undefined)}>
          <RotateCcw size={14} /> Redo
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-bg-primary p-3">
      <Input
        label="Signer's name"
        type="text"
        value={signerName}
        onChange={(e) => setSignerName(e.target.value)}
        placeholder="Full name"
        autoComplete="name"
        disabled={disabled}
      />
      <SignaturePad key={padKey} defaultName={signerName} onChange={setPending} />
      <Button
        type="button"
        size="sm"
        disabled={disabled || !pending || !signerName.trim()}
        onClick={() => {
          if (!pending) return;
          session.setSignature(field.id, {
            method: pending.type === 'drawn' ? 'drawn' : 'typed',
            data: pending.data,
            typedFont: pending.typedFont,
            signerName: signerName.trim(),
          });
          setPending(null);
          setPadKey((k) => k + 1);
        }}
      >
        <PenLine size={15} /> Accept signature
      </Button>
    </div>
  );
}

function FieldBlock({ field, session, disabled, idPrefix }: { field: FormField; session: FormSession; disabled: boolean; idPrefix: string }) {
  const id = `${idPrefix}-${field.id}`;
  const value = session.values[field.id];
  const error = session.errors[field.id];
  const warning = session.warnings[field.id];
  const set = (v: string | boolean) => session.setValue(field.id, v);

  let control: React.ReactNode;
  switch (field.type) {
    case 'textarea':
      control = <Textarea id={id} rows={3} value={String(value ?? '')} onChange={(e) => set(e.target.value)} disabled={disabled} />;
      break;
    case 'number':
      control = (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            step="any"
            value={String(value ?? '')}
            onChange={(e) => set(e.target.value)}
            disabled={disabled}
          />
          {field.unit && <span className="shrink-0 text-sm font-medium text-text-secondary">{field.unit}</span>}
        </div>
      );
      break;
    case 'select':
      control = (
        <select id={id} value={String(value ?? '')} onChange={(e) => set(e.target.value)} disabled={disabled} className={selectClass}>
          <option value="">Select…</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
      break;
    case 'yes_no':
      control = (
        <div className="flex gap-2" role="radiogroup" aria-labelledby={`${id}-label`}>
          {(['yes', 'no'] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={value === choice}
              disabled={disabled}
              onClick={() => set(choice)}
              className={choiceClass(value === choice)}
            >
              {choice === 'yes' ? 'Yes' : 'No'}
            </button>
          ))}
        </div>
      );
      break;
    case 'pass_fail': {
      const options: Array<{ v: 'pass' | 'fail' | 'na'; label: string; tone: 'success' | 'danger' | 'muted' }> = [
        { v: 'pass', label: 'Pass', tone: 'success' },
        { v: 'fail', label: 'Fail', tone: 'danger' },
        ...(field.allow_na ? [{ v: 'na' as const, label: 'N/A', tone: 'muted' as const }] : []),
      ];
      control = (
        <div className="space-y-2.5">
          <div className="flex gap-2" role="radiogroup" aria-labelledby={`${id}-label`}>
            {options.map((o) => (
              <button
                key={o.v}
                type="button"
                role="radio"
                aria-checked={value === o.v}
                disabled={disabled}
                onClick={() => set(o.v)}
                className={choiceClass(value === o.v, o.tone)}
              >
                {o.label}
              </button>
            ))}
          </div>
          {value === 'fail' && field.note_on_fail && (
            <Textarea
              rows={2}
              aria-label={`${field.label} — failure note`}
              placeholder="What failed and what did you do about it?"
              value={String(session.values[noteKey(field.id)] ?? '')}
              onChange={(e) => session.setValue(noteKey(field.id), e.target.value)}
              disabled={disabled}
            />
          )}
        </div>
      );
      break;
    }
    case 'checkbox':
      return (
        <div>
          <label className="flex min-h-[48px] items-center gap-3 text-sm text-text-primary">
            <input
              id={id}
              type="checkbox"
              className="h-5 w-5 rounded border-border accent-accent"
              checked={value === true}
              disabled={disabled}
              onChange={(e) => set(e.target.checked)}
            />
            <span>
              {field.label}
              {field.required ? <span className="ml-0.5 text-danger">*</span> : null}
            </span>
          </label>
          {field.help && <p className="text-xs text-text-secondary">{field.help}</p>}
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </div>
      );
    case 'photo':
      control = <PhotoField field={field} session={session} disabled={disabled} />;
      break;
    case 'signature':
      control = <SignatureField field={field} session={session} disabled={disabled} />;
      break;
    default:
      control = <Input id={id} type="text" value={String(value ?? '')} onChange={(e) => set(e.target.value)} disabled={disabled} />;
  }

  const rangeHint =
    field.type === 'number' && (field.min !== undefined || field.max !== undefined)
      ? `Expected ${field.min ?? '…'} to ${field.max ?? '…'}${field.unit ? ` ${field.unit}` : ''}`
      : null;

  return (
    <div className="space-y-1.5" id={`${id}-block`} data-field-id={field.id}>
      <label id={`${id}-label`} htmlFor={id} className="block text-sm font-medium text-text-primary">
        {field.label}
        {field.required ? <span className="ml-0.5 text-danger">*</span> : null}
      </label>
      {field.help && <p className="text-xs text-text-secondary">{field.help}</p>}
      {rangeHint && <p className="text-xs text-text-secondary">{rangeHint}</p>}
      {control}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {!error && warning && <p className="text-xs text-warning-500">{warning}</p>}
    </div>
  );
}

/** Renders every currently-visible field of a template. Pure UI: the parent owns submission. */
export function FormRunner({
  template,
  session,
  disabled = false,
  idPrefix = 'ff',
}: {
  template: FormTemplate;
  session: FormSession;
  disabled?: boolean;
  idPrefix?: string;
}) {
  return (
    <div className="space-y-5">
      {session.visible.map((field) => (
        <FieldBlock key={`${template.id}:${field.id}`} field={field} session={session} disabled={disabled} idPrefix={`${idPrefix}-${template.slug}`} />
      ))}
    </div>
  );
}
