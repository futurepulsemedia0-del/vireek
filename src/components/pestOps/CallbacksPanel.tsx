import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { fetchCallbacks, fetchRecentJobs, friendlyPestOpsError, registerCallback, type JobOption } from '@/lib/pestOpsApi';
import { localTimeZone, todayISO } from '@/lib/recurringJobs';
import { PEST_CONTROL_PACK } from '@/lib/tradePacks';
import { Pill, SelectField } from '@/components/tradePacks/shared';
import { useResource } from './useResource';

const PESTS = PEST_CONTROL_PACK.logTypes.find((t) => t.key === 'chemical_application')?.fields.find((f) => f.key === 'target_pests')?.options ?? [];

const OUTCOME_LABEL: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  covered: { label: 'Covered — no charge', tone: 'success' },
  override: { label: 'Manager override — no charge', tone: 'warning' },
  out_of_window: { label: 'Outside guarantee — billable', tone: 'danger' },
  target_mismatch: { label: 'Different pest — billable', tone: 'danger' },
  callback_limit: { label: 'Callback limit reached — billable', tone: 'danger' },
};

const jobLabel = (j: JobOption) => `${j.scheduled_datetime ? j.scheduled_datetime.slice(0, 10) : 'unscheduled'} · ${j.service_type ?? 'Job'} · ${j.address ?? ''}`.slice(0, 90);

export function CallbacksPanel({ ownerId, canManage }: { ownerId: string; canManage: boolean }) {
  const { toast } = useToast();
  const list = useResource(() => fetchCallbacks(ownerId));
  const jobs = useResource(() => fetchRecentJobs(ownerId));
  const [original, setOriginal] = useState('');
  const [callback, setCallback] = useState('');
  const [requestedOn, setRequestedOn] = useState(todayISO());
  const [targets, setTargets] = useState<string[]>([]);
  const [override, setOverride] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ outcome: string; covered_until: string; billable: boolean } | null>(null);

  const toggle = (p: string) => setTargets((t) => (t.includes(p) ? t.filter((x) => x !== p) : [...t, p]));
  const invalid = !original || !callback || original === callback || targets.length === 0;

  const submit = async () => {
    setSaving(true);
    setResult(null);
    try {
      const r = await registerCallback({ originalJobId: original, callbackJobId: callback, requestedOn, targets, timeZone: localTimeZone(), overrideReason: canManage ? override : undefined });
      setResult(r);
      toast(r.existing ? 'Already registered' : 'Callback registered', 'success');
      await list.reload();
    } catch (e) {
      toast(friendlyPestOpsError(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <h3 className="font-semibold text-text-primary">Register a re-service</h3>
        {jobs.loading && !jobs.data ? <Skeleton className="h-24 w-full" /> : jobs.error ? (
          <EmptyState variant="load-failed" compact title="Could not load jobs" description={jobs.error} onRetry={() => void jobs.reload()} />
        ) : (
          <>
            <SelectField label="Original service job" value={original} onChange={setOriginal} required>
              <option value="">Choose…</option>
              {(jobs.data ?? []).map((j) => <option key={j.id} value={j.id}>{jobLabel(j)}</option>)}
            </SelectField>
            <SelectField label="Callback job" value={callback} onChange={setCallback} required helperText="The new visit created for the complaint.">
              <option value="">Choose…</option>
              {(jobs.data ?? []).filter((j) => j.id !== original).map((j) => <option key={j.id} value={j.id}>{jobLabel(j)}</option>)}
            </SelectField>
            <Input label="Date of the request" type="date" value={requestedOn} max={todayISO()} onChange={(e) => setRequestedOn(e.target.value)} required />
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium text-text-primary">Pest reported <span className="text-danger">*</span></legend>
              <div className="flex flex-wrap gap-2">
                {PESTS.map((p) => (
                  <label key={p} className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm text-text-primary">
                    <input type="checkbox" className="focus-ring h-4 w-4" checked={targets.includes(p)} onChange={() => toggle(p)} />
                    {p}
                  </label>
                ))}
              </div>
            </fieldset>
            {canManage && <Input label="Manager override reason (optional)" value={override} onChange={(e) => setOverride(e.target.value)} helperText="Only used when the guarantee would not cover this visit. Recorded in the audit log." maxLength={500} />}
            <Button size="sm" loading={saving} disabled={invalid} disabledReason={invalid ? 'Choose two different jobs and at least one pest' : undefined} onClick={() => void submit()}>Check guarantee & register</Button>
            {result && (
              <p role="status" className="text-sm text-text-primary">
                {OUTCOME_LABEL[result.outcome]?.label ?? result.outcome} (guarantee runs to {result.covered_until}).
              </p>
            )}
          </>
        )}
      </Card>

      {list.loading && !list.data ? <Skeleton className="h-32 w-full" /> : list.error ? (
        <EmptyState variant="load-failed" title="Could not load callbacks" description={list.error} onRetry={() => void list.reload()} />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState compact title="No callbacks yet" description="Re-service visits inside a guarantee window appear here." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Callbacks</caption>
            <thead className="text-xs text-text-secondary"><tr><th scope="col" className="py-2 pr-3">Requested</th><th scope="col" className="pr-3">Service</th><th scope="col" className="pr-3">Guarantee to</th><th scope="col" className="pr-3">Pest</th><th scope="col">Outcome</th></tr></thead>
            <tbody>
              {(list.data ?? []).map((c) => (
                <tr key={c.id} className="border-t border-border">
                  <td className="py-2 pr-3">{c.requested_on}</td><td className="pr-3">{c.service_date}</td><td className="pr-3">{c.covered_until}</td>
                  <td className="pr-3">{c.request_targets.join(', ')}</td>
                  <td><Pill tone={OUTCOME_LABEL[c.outcome]?.tone ?? 'neutral'}>{OUTCOME_LABEL[c.outcome]?.label ?? c.outcome}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
