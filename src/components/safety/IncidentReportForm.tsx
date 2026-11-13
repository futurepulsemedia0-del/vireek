// Recreated: verify against original intent
import { useRef, useState } from 'react';
import { useToast } from '@/contexts/ToastContext';
import {
  ATTACHMENT_ALLOWED_TYPES,
  ATTACHMENT_MAX_COUNT,
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  reportIncident,
  uploadIncidentAttachment,
  type IncidentCategory,
  type IncidentSeverity,
} from '@/lib/siteSafety';

interface Props {
  /** Account owner id: attachments are stored under it (the storage policy checks it). */
  ownerId: string;
  jobId?: string | null;
  onSaved?: () => void;
}

const CATEGORY_LABEL: Record<IncidentCategory, string> = {
  threat: 'Threat or aggression',
  injury: 'Injury',
  near_miss: 'Near miss',
  hazard: 'Hazard',
};
const SEVERITY_LABEL: Record<IncidentSeverity, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
const UPLOAD_ERROR: Record<string, string> = {
  upload_failed: 'could not be uploaded',
  register_failed: 'was uploaded but could not be attached',
};

const MAX_DESCRIPTION = 4000;

export function IncidentReportForm({ ownerId, jobId = null, onSaved }: Props) {
  const { toast } = useToast();
  const [category, setCategory] = useState<IncidentCategory>('near_miss');
  const [severity, setSeverity] = useState<IncidentSeverity>('low');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((prev) => [...prev, ...Array.from(list)].slice(0, ATTACHMENT_MAX_COUNT));
    if (fileInput.current) fileInput.current.value = '';
  };

  const submit = async () => {
    if (lock.current || !description.trim()) return;
    lock.current = true;
    setBusy(true);
    try {
      const res = await reportIncident({ category, severity, description: description.trim(), jobId });
      const failures: string[] = [];
      let count = 0;
      for (const f of files) {
        // Sequential on purpose: the server counts existing attachments for each upload.
        const problem = await uploadIncidentAttachment(ownerId, res.id, f, count);
        if (problem) failures.push(`${f.name} ${UPLOAD_ERROR[problem] ?? problem}`);
        else count += 1;
      }
      toast(`Report #${res.case_number} saved.${res.wellbeing_due_at ? ' A manager will check in with you.' : ''}`, 'success');
      if (failures.length) toast(`Some files were not added: ${failures.join('; ')}.`, 'error');
      setDescription('');
      setFiles([]);
      onSaved?.();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not save the report. Try again.', 'error');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="incident-title" className="rounded-xl border border-border bg-bg-secondary p-4">
      <h2 id="incident-title" className="text-sm font-semibold text-text-primary">Report an incident</h2>
      <p className="mt-1 text-xs text-text-secondary">Reports go to your safety manager. Reporting never counts against you.</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="inc-cat" className="mb-1 block text-xs font-semibold text-text-secondary">What happened?</label>
          <select id="inc-cat" value={category} onChange={(e) => setCategory(e.target.value as IncidentCategory)} className="focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary">
            {INCIDENT_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="inc-sev" className="mb-1 block text-xs font-semibold text-text-secondary">How serious?</label>
          <select id="inc-sev" value={severity} onChange={(e) => setSeverity(e.target.value as IncidentSeverity)} className="focus-ring min-h-[44px] w-full rounded-lg border border-border bg-bg-primary px-3 text-sm text-text-primary">
            {INCIDENT_SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}
          </select>
        </div>
      </div>

      <label htmlFor="inc-desc" className="mb-1 mt-3 block text-xs font-semibold text-text-secondary">Describe it</label>
      <textarea id="inc-desc" value={description} maxLength={MAX_DESCRIPTION} rows={5} onChange={(e) => setDescription(e.target.value)} className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" />

      <div className="mt-3">
        <label htmlFor="inc-files" className="mb-1 block text-xs font-semibold text-text-secondary">Photos or files (optional, up to {ATTACHMENT_MAX_COUNT})</label>
        <input id="inc-files" ref={fileInput} type="file" multiple accept={ATTACHMENT_ALLOWED_TYPES.join(',')} onChange={(e) => addFiles(e.target.files)} className="block w-full text-sm text-text-secondary file:me-3 file:rounded-lg file:border file:border-border file:bg-bg-tertiary file:px-3 file:py-1.5 file:text-sm file:text-text-primary" />
        {files.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-text-secondary">
            {files.map((f, i) => (
              <li key={`${f.name}:${i}`} className="flex items-center justify-between gap-2">
                <span className="truncate">{f.name}</span>
                <button type="button" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`} className="focus-ring rounded px-1 font-semibold text-accent">Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 flex justify-end">
        <button type="button" onClick={() => void submit()} disabled={busy || !description.trim()} className="focus-ring min-h-[48px] rounded-lg bg-accent px-5 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Submit report'}
        </button>
      </div>
    </section>
  );
}
