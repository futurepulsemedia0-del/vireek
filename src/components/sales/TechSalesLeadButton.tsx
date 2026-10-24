import { useState } from 'react';
import { CheckCircle2, HandCoins, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { salesErrorMessage } from '@/lib/inHomeSales';
import { createSalesLeadFromJob } from '@/lib/inHomeSalesApi';

/**
 * Technician-generated lead: "this customer needs a replacement / upgrade quote".
 * Creates a lead (source: technician_referral) + a sales appointment for a comfort advisor.
 * Idempotent per job — a second tap returns the same lead.
 */
export function TechSalesLeadButton({ jobId }: { jobId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [service, setService] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ duplicate: boolean } | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await createSalesLeadFromJob(jobId, reason, service || undefined);
      setDone({ duplicate: res.duplicate });
    } catch (e) {
      setError(salesErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p role="status" className="flex items-center gap-2 rounded-lg border border-success-500/30 bg-success-500/10 p-3 text-sm text-success-500">
        <CheckCircle2 size={16} aria-hidden="true" />
        {done.duplicate ? 'A sales lead already exists for this job.' : 'Sales lead sent — an advisor will follow up.'}
      </p>
    );
  }
  if (!open) {
    return (
      <Button variant="secondary" size="sm" className="w-full" onClick={() => setOpen(true)}>
        <HandCoins size={16} aria-hidden="true" /> Request a sales appointment
      </Button>
    );
  }
  return (
    <section aria-label="Request a sales appointment" className="space-y-3 rounded-lg border border-border bg-bg-secondary p-3">
      <Textarea label="Why does this customer need a sales visit?" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. 18-year-old furnace, cracked heat exchanger — needs replacement quote" />
      <Input label="What are they interested in? (optional)" maxLength={120} value={service} onChange={(e) => setService(e.target.value)} />
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" className="flex-1" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
        <Button size="sm" className="flex-1" disabled={busy || reason.trim().length < 3} onClick={() => void submit()}>
          {busy ? <Loader2 className="animate-spin" size={14} aria-hidden="true" /> : null} Send lead
        </Button>
      </div>
    </section>
  );
}
