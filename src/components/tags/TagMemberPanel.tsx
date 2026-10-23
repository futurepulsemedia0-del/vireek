import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Wrench } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { TagPrintDialog } from '@/components/tags/TagPrintDialog';
import { createJobFromTag, rotateTag, tagErrorMessage, type RotationReason } from '@/lib/vireekTag';

const QUICK = ['Repair', 'Maintenance / tune-up', 'Inspection', 'Warranty service'];
const REASONS: { value: RotationReason; label: string }[] = [
  { value: 'damaged', label: 'Damaged or unreadable' },
  { value: 'lost', label: 'Lost / removed' },
  { value: 'suspected_tamper', label: 'Suspected tampering' },
  { value: 'scheduled', label: 'Scheduled refresh' },
];
const card = 'rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark';

interface Props { token: string; tagId: string | null; passportCode: string; equipmentId: string | null; equipmentCaption: string; businessName: string }

export function TagMemberPanel({ token, tagId, passportCode, equipmentId, equipmentCaption, businessName }: Props) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [type, setType] = useState(QUICK[0]);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<RotationReason>('damaged');
  const [rotateOpen, setRotateOpen] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);

  const createJob = async () => {
    setBusy(true);
    try {
      const r = await createJobFromTag(token, type);
      toast(r.existing ? 'Opening the job you just created' : 'Job created', 'success');
      navigate(`/tech/job/${r.job_id}`);
    } catch (e) {
      toast(tagErrorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    if (!tagId) return;
    setBusy(true);
    try {
      const r = await rotateTag(tagId, reason);
      setFresh(r.token);
      setRotateOpen(false);
    } catch (e) {
      toast(tagErrorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded-md border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary';

  return (
    <>
      <section className={card} aria-labelledby="tag-tech-title">
        <h2 id="tag-tech-title" className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary"><Wrench size={15} className="text-accent" aria-hidden="true" /> Technician tools</h2>
        <p className="mb-3 text-xs text-text-secondary">You are signed in with access to this machine’s full service history (below).</p>
        {equipmentId ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <select aria-label="Service type" value={type} onChange={(e) => setType(e.target.value)} className={field}>
              {QUICK.map((q) => <option key={q}>{q}</option>)}
            </select>
            <button type="button" onClick={createJob} disabled={busy} className="focus-ring shrink-0 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {busy ? 'Creating…' : 'Create job now'}
            </button>
          </div>
        ) : (
          <p className="text-xs text-text-secondary">Link this machine to an equipment record in your account to create jobs from the tag.</p>
        )}
        <div className="mt-3 flex flex-wrap gap-3 text-xs">
          <a className="focus-ring text-accent underline" href={`/dashboard/equipment-passports/${passportCode}`}>Open full passport</a>
          {tagId && <button type="button" onClick={() => setRotateOpen((v) => !v)} className="focus-ring inline-flex items-center gap-1 text-text-secondary underline hover:text-text-primary"><RefreshCw size={12} aria-hidden="true" /> Replace this sticker</button>}
        </div>
        {rotateOpen && (
          <div className="mt-3 rounded-xl border border-border p-3">
            <label className="block text-xs font-medium text-text-secondary">Why are you replacing it?
              <select value={reason} onChange={(e) => setReason(e.target.value as RotationReason)} className={`${field} mt-1`}>
                {REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </label>
            <p className="mt-2 text-[11px] text-text-secondary">The current sticker stops working immediately. Print the new one and stick it on the unit.</p>
            <button type="button" onClick={rotate} disabled={busy} className="focus-ring mt-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-text-primary hover:border-accent/40 disabled:opacity-50">{busy ? 'Rotating…' : 'Retire & issue new tag'}</button>
          </div>
        )}
      </section>
      {fresh && (
        <TagPrintDialog
          tags={[{ token: fresh, caption: equipmentCaption }]}
          businessName={businessName}
          title="Print the replacement tag"
          notice="The old sticker is already disabled. Remove it and attach the new one."
          onClose={() => { setFresh(null); navigate(`/t/${fresh}`, { replace: true }); }}
        />
      )}
    </>
  );
}
