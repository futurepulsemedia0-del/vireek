import { useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Camera, CheckCircle2, Loader2, QrCode, ScanLine } from 'lucide-react';
import { formatPassportCode } from '@/lib/equipmentPassport';
import {
  NAMEPLATE_KIND_OPTIONS, createFromNameplate, draftFromScan, manufactureLabel, reviewReasonMessage, scanNameplate, warrantyBadge,
  type BadgeTone, type NameplateCreated, type NameplateDraft, type NameplateResult, type NameplateScan,
} from '@/lib/equipmentNameplate';

interface Props {
  jobId: string;
  customerId?: string | null;
  /** Called after equipment was created, so the page can refresh "Equipment on site". */
  onCreated?: (created: NameplateCreated) => void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; label: string }
  | { kind: 'review'; scan: NameplateScan; draft: NameplateDraft }
  | { kind: 'done'; scan: NameplateScan; created: NameplateCreated };

const TONE: Record<BadgeTone, string> = {
  success: 'bg-success-500/10 text-success-500',
  warning: 'bg-warning-500/10 text-warning-500',
  danger: 'bg-danger-500/10 text-danger-500',
  neutral: 'bg-bg-tertiary text-text-secondary',
};

const inputCls = 'w-full rounded-md border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary';

/** Technician flow: photograph the data plate -> OCR -> equipment passport + warranty status. */
export function NameplateScanCard({ jobId, customerId = null, onCreated }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uid = useId();

  const finish = (r: NameplateResult) => {
    if (r.created) {
      setPhase({ kind: 'done', scan: r.scan, created: r.created });
      onCreated?.(r.created);
    } else {
      setPhase({ kind: 'review', scan: r.scan, draft: draftFromScan(r.scan) });
    }
  };

  const onFile = async (file: File | undefined) => {
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('Please choose a photo of the data plate.'); return; }
    setError(null);
    setPhase({ kind: 'busy', label: 'Reading the data plate…' });
    try {
      finish(await scanNameplate({ file, jobId, customerId }));
    } catch (e) {
      setPhase({ kind: 'idle' });
      setError(e instanceof Error ? e.message : 'Could not read the data plate.');
    }
  };

  const submitReview = async (scan: NameplateScan, draft: NameplateDraft) => {
    setError(null);
    setPhase({ kind: 'busy', label: 'Creating the passport…' });
    try {
      finish(await createFromNameplate(scan.id, draft));
    } catch (e) {
      setPhase({ kind: 'review', scan, draft });
      setError(e instanceof Error ? e.message : 'Could not create the passport.');
    }
  };

  const reset = () => { setPhase({ kind: 'idle' }); setError(null); };

  return (
    <section className="rounded-lg border border-border bg-bg-secondary p-3" aria-labelledby={`${uid}-h`}>
      <h2 id={`${uid}-h`} className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-text-primary">
        <ScanLine className="h-4 w-4 text-accent" aria-hidden="true" /> Scan data plate
      </h2>

      <input
        ref={inputRef} id={`${uid}-file`} type="file" accept="image/*" capture="environment" className="sr-only"
        onChange={(e) => void onFile(e.target.files?.[0])} disabled={phase.kind === 'busy'}
      />

      <div aria-live="polite">
        {phase.kind === 'idle' && (
          <>
            <p className="mb-3 text-xs text-text-secondary">
              Photograph the unit&apos;s label. Vireek reads the brand, model, serial and manufacture date, then creates its passport and checks the warranty.
            </p>
            <button
              type="button" onClick={() => inputRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-3 text-sm font-semibold text-white"
            >
              <Camera className="h-4 w-4" aria-hidden="true" /> Scan data plate
            </button>
          </>
        )}

        {phase.kind === 'busy' && (
          <p className="flex items-center gap-2 py-3 text-sm text-text-secondary" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {phase.label}
          </p>
        )}

        {phase.kind === 'review' && (
          <ReviewForm
            scan={phase.scan} draft={phase.draft}
            onChange={(draft) => setPhase({ kind: 'review', scan: phase.scan, draft })}
            onSubmit={() => void submitReview(phase.scan, phase.draft)}
            onRetake={() => { reset(); inputRef.current?.click(); }}
            onCancel={reset}
            idPrefix={uid}
          />
        )}

        {phase.kind === 'done' && <DoneCard scan={phase.scan} created={phase.created} onAnother={reset} />}
      </div>

      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}

function ReviewForm({ scan, draft, onChange, onSubmit, onRetake, onCancel, idPrefix }: {
  scan: NameplateScan; draft: NameplateDraft; onChange: (d: NameplateDraft) => void; onSubmit: () => void;
  onRetake: () => void; onCancel: () => void; idPrefix: string;
}) {
  const set = <K extends keyof NameplateDraft>(k: K, v: NameplateDraft[K]) => onChange({ ...draft, [k]: v });
  const canSubmit = draft.make.trim().length > 0;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (canSubmit) onSubmit(); }} className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-warning-500/30 bg-warning-500/10 p-2.5 text-xs text-warning-500">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold">Check this read before the passport is created.</p>
          {scan.review_reasons.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {scan.review_reasons.map((r) => <li key={r}>{reviewReasonMessage(r)}</li>)}
            </ul>
          )}
        </div>
      </div>

      <Field id={`${idPrefix}-kind`} label="Equipment type">
        <select id={`${idPrefix}-kind`} className={inputCls} value={draft.kind} onChange={(e) => set('kind', e.target.value as NameplateDraft['kind'])}>
          {NAMEPLATE_KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      <Field id={`${idPrefix}-make`} label="Brand">
        <input id={`${idPrefix}-make`} className={inputCls} value={draft.make} maxLength={80} autoComplete="off" onChange={(e) => set('make', e.target.value)} required />
      </Field>
      <Field id={`${idPrefix}-model`} label="Model">
        <input id={`${idPrefix}-model`} className={inputCls} value={draft.model} maxLength={60} autoComplete="off" autoCapitalize="characters" onChange={(e) => set('model', e.target.value)} />
      </Field>
      <Field id={`${idPrefix}-serial`} label="Serial number">
        <input id={`${idPrefix}-serial`} className={inputCls} value={draft.serial} maxLength={40} autoComplete="off" autoCapitalize="characters" onChange={(e) => set('serial', e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field id={`${idPrefix}-mfg`} label="Manufactured" hint="YYYY-MM">
          <input id={`${idPrefix}-mfg`} className={inputCls} value={draft.manufactureDate} maxLength={10} inputMode="numeric" placeholder="2019-03" onChange={(e) => set('manufactureDate', e.target.value)} />
        </Field>
        <Field id={`${idPrefix}-install`} label="Installed (optional)" hint="YYYY-MM-DD">
          <input id={`${idPrefix}-install`} className={inputCls} value={draft.installDate} maxLength={10} inputMode="numeric" placeholder="2019-05-20" onChange={(e) => set('installDate', e.target.value)} />
        </Field>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={!canSubmit} className="flex-1 rounded-lg bg-accent px-3 py-3 text-sm font-semibold text-white disabled:opacity-50">
          Create passport
        </button>
        <button type="button" onClick={onRetake} className="rounded-lg border border-border px-3 py-3 text-sm font-medium text-text-primary">Retake photo</button>
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-3 text-sm font-medium text-text-secondary">Cancel</button>
      </div>
    </form>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 flex items-baseline justify-between text-xs font-medium text-text-secondary">
        <span>{label}</span>{hint && <span className="font-normal opacity-70">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function DoneCard({ scan, created, onAnother }: { scan: NameplateScan; created: NameplateCreated; onAnother: () => void }) {
  const f = scan.fields;
  const badge = warrantyBadge(created.warranty);
  const mfg = manufactureLabel(f.manufacture?.date, f.manufacture?.precision);
  const p = created.passport;
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-success-500">
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        {created.reused ? 'Already on file for this customer' : 'Equipment added'}
      </p>
      <div className="text-sm text-text-secondary">
        <p className="text-text-primary">{[f.make, f.model].filter(Boolean).join(' ') || 'Equipment'}</p>
        {f.serial && <p>Serial {f.serial}</p>}
        {mfg && <p>Manufactured {mfg}</p>}
      </div>

      <div>
        <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${TONE[badge.tone]}`}>{badge.label}</span>
        {created.warranty.basis === 'estimated' && created.warranty.note && (
          <p className="mt-1 text-[11px] text-text-secondary">{created.warranty.note}</p>
        )}
      </div>

      {p?.verified && p.code && (
        <Link to={`/e/${p.code}`} className="focus-ring inline-flex items-center gap-1.5 rounded-lg bg-accent/10 px-2.5 py-1.5 text-xs font-semibold text-accent">
          <QrCode className="h-3.5 w-3.5" aria-hidden="true" /> Passport {formatPassportCode(p.code)}
        </Link>
      )}
      {p && !p.verified && (
        <p className="rounded-md border border-border bg-bg-primary p-2 text-xs text-text-secondary">
          This unit already has a passport from another company. Scan the QR label on the unit to verify and unlock its history.
        </p>
      )}
      {!p && <p className="text-xs text-text-secondary">The passport is being issued and will appear on this equipment shortly.</p>}

      <button type="button" onClick={onAnother} className="w-full rounded-lg border border-border py-2.5 text-sm font-medium text-text-primary">
        Scan another plate
      </button>
    </div>
  );
}
