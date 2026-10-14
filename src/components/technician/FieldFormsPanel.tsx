// src/components/technician/FieldFormsPanel.tsx
// Checklists & inspection forms for one job — schema v2 (photo, signature, pass/fail, numeric
// ranges, conditional logic). Templates are cached on the device and everything below runs
// locally, so the form works with no signal; each part (photos, signatures, then the form
// itself) is written to the offline outbox and synced automatically when the network returns.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardCheck, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { FormRunner } from '@/components/forms/FormRunner';
import { useFormSession } from '@/components/forms/useFormSession';
import { useToast } from '@/contexts/ToastContext';
import { useFieldVersion } from '@/hooks/useFieldSync';
import { dataUrlToBlob, getLastKnownFix } from '@/lib/offline/capture';
import { idb } from '@/lib/offline/db';
import { loadTemplates, sortForService } from '@/lib/offline/forms';
import { draftKey } from '@/lib/offline/formLogic';
import { enqueue } from '@/lib/offline/outbox';
import type { FormTemplate } from '@/lib/offline/formSchema';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

export function FieldFormsPanel({ jobId }: { jobId: string }) {
  const { toast } = useToast();
  const version = useFieldVersion();
  const [templates, setTemplates] = useState<FormTemplate[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      loadTemplates(),
      idb.get<{ service_type?: string | null }>('jobs', jobId).catch(() => undefined),
    ]).then(([all, job]) => {
      if (cancelled) return;
      const sorted = sortForService(all, job?.service_type) as FormTemplate[];
      setTemplates(sorted);
      setSelectedId((current) => (sorted.some((t) => t.id === current) ? current : sorted[0]?.id ?? ''));
    });
    return () => {
      cancelled = true;
    };
  }, [jobId, version]);

  const template = useMemo(() => templates.find((t) => t.id === selectedId) ?? null, [templates, selectedId]);
  const session = useFormSession(template, template ? draftKey(jobId, template.id, template.version) : null);

  if (!template) return null;

  async function submit() {
    if (!template || busy) return;
    if (!session.validate()) {
      toast('Please complete the highlighted fields.', 'error');
      // Bring the first problem into view (the form can be long on a phone).
      window.setTimeout(() => {
        containerRef.current?.querySelector('[role="alert"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }, 0);
      return;
    }
    const built = session.build();
    if (!built) return;

    setBusy(true);
    try {
      const fix = getLastKnownFix();
      const geo = { lat: fix?.lat ?? null, lng: fix?.lng ?? null };

      // Parts first, the form last: if anything fails midway the technician retries, and the
      // deterministic refs let the server de-duplicate whatever was already queued.
      for (const p of built.photos) {
        await enqueue(
          'artifact',
          jobId,
          { kind: 'photo', data: { form_ref: built.data.submission_ref, field_id: p.fieldId, ref: p.ref, bytes: p.blob.size }, ...geo },
          { blob: { data: p.blob, bucket: 'job-evidence-photos', ext: 'jpg' } }
        );
      }
      for (const s of built.signatures) {
        const sig = s.signature;
        if (sig.method === 'drawn') {
          await enqueue(
            'artifact',
            jobId,
            { kind: 'signature', data: { method: 'drawn', signer_name: sig.signerName, form_ref: built.data.submission_ref, field_id: s.fieldId, ref: s.ref }, ...geo },
            { blob: { data: dataUrlToBlob(sig.data), bucket: 'field-captures', ext: 'png' } }
          );
        } else {
          await enqueue('artifact', jobId, {
            kind: 'signature',
            data: { method: 'typed', signer_name: sig.signerName, typed_name: sig.data, font: sig.typedFont, form_ref: built.data.submission_ref, field_id: s.fieldId, ref: s.ref },
            ...geo,
          });
        }
      }
      await enqueue('artifact', jobId, { kind: 'form', data: built.data, ...geo });

      session.reset();
      toast(online ? `${template.title} saved` : `${template.title} saved — it will sync when you're back online`, 'success');
    } catch {
      toast('Could not save on this device — free up storage and try again.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="rounded-lg border border-border bg-bg-primary p-3">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-text-primary">
        <ClipboardCheck className="h-4 w-4" /> Checklists &amp; forms
        {!online && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-xs font-normal text-text-secondary">
            <WifiOff size={12} /> Offline
          </span>
        )}
      </summary>
      <div ref={containerRef} className="mt-3 space-y-4">
        {templates.length > 1 && (
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            aria-label="Choose a form"
            className={selectClass}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        )}
        {template.description && <p className="text-xs text-text-secondary">{template.description}</p>}
        {session.draftRestored && <p className="text-xs text-text-secondary">Your unsaved answers were restored.</p>}

        <FormRunner template={template} session={session} disabled={busy} idPrefix={`job-${jobId.slice(0, 8)}`} />

        <Button type="button" className="w-full" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Save form'}
        </Button>
      </div>
    </details>
  );
}
