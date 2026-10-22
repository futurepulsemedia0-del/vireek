import { useState } from 'react';
import { BellRing } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { fetchNotices, fetchObjections, submitObjection } from '@/lib/trustPack/api';
import { changeLabel, daysUntil, noticePhase } from '@/lib/trustPack/notices';
import { Badge, Card, Field, PanelError, PanelSkeleton, Spinner, fmtDate, inputClass, useLoader, type Tone } from './ui';

const OBJ_TONE: Record<string, Tone> = { open: 'warn', under_review: 'warn', resolved: 'ok', withdrawn: 'neutral' };

export function NoticesPanel({ ownerId, isOwner }: { ownerId: string; isOwner: boolean }) {
  const { toast } = useToast();
  const [now] = useState(() => Date.now());
  const { data, status, error, reload, retry } = useLoader(async () => {
    const [notices, objections] = await Promise.all([fetchNotices(), fetchObjections(ownerId)]);
    return { notices, objections };
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  if (status === 'loading') return <PanelSkeleton />;
  if (status === 'error' || !data) return <PanelError message={error || 'Could not load notices.'} onRetry={retry} />;

  const objectionFor = (id: string) => data.objections.find((o) => o.notice_id === id);
  const reasonError = reason.trim().length > 0 && reason.trim().length < 20 ? 'Please explain in at least 20 characters.' : undefined;

  async function submit(noticeId: string) {
    setBusy(true);
    try {
      await submitObjection(ownerId, noticeId, reason);
      toast('Objection submitted', 'success');
      setOpenId(null); setReason('');
      await reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not submit your objection.', 'error');
    } finally { setBusy(false); }
  }

  return (
    <Card title="Sub-processor changes" icon={BellRing}>
      <p className="text-sm text-text-secondary">
        We give notice before adding or replacing a sub-processor. You may object on reasonable data-protection grounds while the window is open.
        Public feed: <a className="text-accent underline" href="/trust/security#subprocessor-notices">Security portal</a>.
      </p>
      {data.notices.length === 0 ? (
        <p className="mt-4 text-sm text-text-secondary">No changes have been announced.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {data.notices.map((n) => {
            const phase = noticePhase(n, now);
            const obj = objectionFor(n.id);
            return (
              <li key={n.id} className="py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-text-primary">{changeLabel(n.change_type)}: {n.processor_name}</p>
                  <Badge tone={phase === 'objection_open' ? 'warn' : phase === 'withdrawn' ? 'neutral' : 'ok'}>
                    {phase === 'objection_open' ? `Objection window: ${daysUntil(n.effective_at, now)}d left` : phase === 'withdrawn' ? 'Withdrawn' : 'In effect'}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-text-secondary">{n.summary}</p>
                <p className="mt-1 text-xs text-text-secondary">{n.location} · effective {fmtDate(n.effective_at)}{n.emergency ? ' · emergency change' : ''}</p>

                {obj ? (
                  <p className="mt-2 text-xs text-text-secondary"><Badge tone={OBJ_TONE[obj.status]}>Your objection: {obj.status.replace('_', ' ')}</Badge>{obj.response ? ` — ${obj.response}` : ''}</p>
                ) : phase === 'objection_open' && isOwner ? (
                  openId === n.id ? (
                    <div className="mt-3 space-y-2">
                      <Field label="Grounds for objection" error={reasonError}>
                        <textarea className={inputClass} rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
                      </Field>
                      <div className="flex gap-2">
                        <Button size="sm" disabled={busy || reason.trim().length < 20} onClick={() => submit(n.id)}>{busy ? <Spinner /> : null} Submit objection</Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setOpenId(null); setReason(''); }}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" variant="secondary" className="mt-3" onClick={() => setOpenId(n.id)}>Object to this change</Button>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
