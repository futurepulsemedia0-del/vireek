import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { cancelNotice, fetchNotices, fetchRecentJobs, friendlyPestOpsError, queueNotice } from '@/lib/pestOpsApi';
import { fetchLogEntries } from '@/lib/tradePacksApi';
import { localTimeZone } from '@/lib/recurringJobs';
import { buildPreVisitNotice, buildTreatmentReport, noticeSendAt, type ReportProduct } from '@/lib/tradePacks/pestOps';
import { Pill, SelectField, fmtDateTime } from '@/components/tradePacks/shared';
import { useResource } from './useResource';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

const TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { sent: 'success', pending: 'warning', sending: 'warning', failed: 'danger', cancelled: 'neutral', skipped: 'neutral' };

export function NoticesPanel({ ownerId }: { ownerId: string }) {
  const { toast } = useToast();
  const list = useResource(() => fetchNotices(ownerId));
  const jobs = useResource(() => fetchRecentJobs(ownerId));
  const [jobId, setJobId] = useState('');
  const [kind, setKind] = useState<'pre_visit' | 'report'>('pre_visit');
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [recipient, setRecipient] = useState('');
  const [business, setBusiness] = useState('');
  const [customer, setCustomer] = useState('');
  const [leadHours, setLeadHours] = useState('24');
  const [saving, setSaving] = useState(false);

  const job = (jobs.data ?? []).find((j) => j.id === jobId);
  const invalid = !job || !recipient.trim() || !business.trim() || (kind === 'pre_visit' && !job?.scheduled_datetime);

  const submit = async () => {
    if (!job) return;
    setSaving(true);
    try {
      const tz = localTimeZone();
      if (kind === 'pre_visit') {
        const lead = Math.min(Math.max(Number(leadHours) || 24, 1), 168);
        const msg = buildPreVisitNotice({ businessName: business.trim(), customerName: customer || null, visitStartUtc: job.scheduled_datetime as string, timeZone: tz, channel });
        const sendAt = noticeSendAt(job.scheduled_datetime as string, lead, tz);
        await queueNotice({ jobId: job.id, kind, channel, sendAt: new Date(sendAt) < new Date() ? new Date().toISOString() : sendAt, recipient, subject: msg.subject, body: msg.text });
      } else {
        const entries = (await fetchLogEntries(ownerId, { packKey: 'pest_control', jobId: job.id })).filter((e) => !e.voided_at);
        const treat = entries.find((e) => e.entry_type === 'treatment');
        const apps = entries.filter((e) => e.entry_type === 'chemical_application');
        if (!treat && apps.length === 0) throw new Error('no_service_record: log the treatment before sending a report');
        const first = treat ?? apps[0];
        const products: ReportProduct[] = apps.map((a) => ({
          name: a.product_name ?? 'Product', registrationNumber: a.product_epa_reg, amount: Number(a.data.amount) || 0, unit: String(a.data.amount_unit ?? ''),
          targetPests: Array.isArray(a.data.target_pests) ? (a.data.target_pests as string[]) : [], area: str(a.data.application_site), reentryUntilUtc: a.reentry_until,
        }));
        const msg = buildTreatmentReport({
          businessName: business.trim(), timeZone: tz, customerName: customer || null, technicianName: first.technician_name, performedAtUtc: first.performed_at,
          visitType: str(treat?.data.treatment_type) ?? 'Pest', activityLevel: num(treat?.data.pest_activity),
          findings: str(treat?.data.findings), recommendations: str(treat?.data.recommendations), products,
        });
        await queueNotice({ jobId: job.id, kind, channel, sendAt: new Date().toISOString(), recipient, subject: msg.subject, body: msg.text });
      }
      toast('Notice queued', 'success');
      setRecipient('');
      await list.reload();
    } catch (e) {
      toast(friendlyPestOpsError(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await cancelNotice(id);
      await list.reload();
    } catch (e) {
      toast(friendlyPestOpsError(e), 'error');
    }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <h3 className="font-semibold text-text-primary">Queue a notice</h3>
        <p className="text-xs text-text-secondary">Messages are queued and sent by the delivery worker. Contacts on your opt-out lists are refused. Messaging-consent rules differ by region — REQUIRES COUNSEL.</p>
        <SelectField label="Job" value={jobId} onChange={setJobId} required>
          <option value="">Choose…</option>
          {(jobs.data ?? []).map((j) => <option key={j.id} value={j.id}>{(j.scheduled_datetime ?? 'unscheduled').slice(0, 10)} · {j.service_type ?? 'Job'} · {j.address ?? ''}</option>)}
        </SelectField>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Type" value={kind} onChange={(v) => setKind(v as 'pre_visit' | 'report')}>
            <option value="pre_visit">Pre-visit notice</option>
            <option value="report">Treatment report</option>
          </SelectField>
          <SelectField label="Channel" value={channel} onChange={(v) => setChannel(v as 'email' | 'sms')}>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </SelectField>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label={channel === 'email' ? 'Recipient email' : 'Recipient phone'} value={recipient} onChange={(e) => setRecipient(e.target.value)} required />
          <Input label="Customer name (first name is used)" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          <Input label="Business name" value={business} onChange={(e) => setBusiness(e.target.value)} required />
          {kind === 'pre_visit' && <Input label="Send hours before visit" type="number" min={1} max={168} value={leadHours} onChange={(e) => setLeadHours(e.target.value)} helperText="Never sent between 20:00 and 08:00 local." />}
        </div>
        <Button size="sm" loading={saving} disabled={invalid} disabledReason={invalid ? 'Choose a job and fill the required fields' : undefined} onClick={() => void submit()}>Queue notice</Button>
      </Card>

      {list.loading && !list.data ? <Skeleton className="h-32 w-full" /> : list.error ? (
        <EmptyState variant="load-failed" title="Could not load notices" description={list.error} onRetry={() => void list.reload()} />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState compact title="No notices yet" />
      ) : (
        <ul className="space-y-2" aria-label="Queued notices">
          {(list.data ?? []).map((n) => (
            <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3 text-sm">
              <div>
                <p className="font-medium text-text-primary">{n.subject}</p>
                <p className="text-xs text-text-secondary">{n.kind === 'report' ? 'Report' : 'Pre-visit'} · {n.channel} · {fmtDateTime(n.send_at)}{n.last_error ? ` · ${n.last_error}` : ''}</p>
              </div>
              <div className="flex items-center gap-2">
                <Pill tone={TONE[n.status] ?? 'neutral'}>{n.status}</Pill>
                {n.status === 'pending' && <Button size="xs" variant="ghost" onClick={() => void cancel(n.id)}>Cancel</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
