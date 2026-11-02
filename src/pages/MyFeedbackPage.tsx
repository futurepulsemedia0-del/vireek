import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, MessageSquarePlus, Trash2 } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/contexts/ToastContext';
import {
  deleteMyFeedbackData, exportMyFeedbackData, getFeedbackPrivacy, listMyFeedback, setFeedbackPrivacy,
  type FeedbackPrivacy, type MyFeedbackItem,
} from '@/lib/feedback/api';
import { openFeedback } from '@/lib/feedback/events';
import { formatDate } from '@/lib/format';

const STATUS_LABEL: Record<string, string> = {
  received: 'Received', triaged: 'Reviewing', planned: 'Planned', in_progress: 'In progress', shipped: 'Shipped', closed: 'Closed', declined: 'Not planned',
};

export function MyFeedbackPage() {
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<MyFeedbackItem[] | null>(null);
  const [privacy, setPrivacy] = useState<FeedbackPrivacy | null>(null);
  const [error, setError] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    try { setError(false); const [l, p] = await Promise.all([listMyFeedback(), getFeedbackPrivacy()]); setItems(l); setPrivacy(p); }
    catch { setError(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // The command palette links here with ?new=1 to open the feedback dialog.
  useEffect(() => {
    if (params.get('new') === '1') { openFeedback(); params.delete('new'); setParams(params, { replace: true }); }
  }, [params, setParams]);

  const update = async (p: { neverAsk?: boolean; anonymousDefault?: boolean }) => {
    try { setPrivacy(await setFeedbackPrivacy(p)); } catch { toast('Could not save that. Please try again.', 'error'); }
  };

  const download = async () => {
    try {
      const data = await exportMyFeedbackData();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'vireek-my-feedback-data.json'; a.click();
      URL.revokeObjectURL(url);
    } catch { toast('Could not prepare your data. Please try again.', 'error'); }
  };

  const erase = async () => {
    try {
      const r = await deleteMyFeedbackData();
      toast(`Deleted ${r.feedback} feedback item(s) and ${r.survey_responses} survey answer(s).`, 'success');
      setConfirmDelete(false); await load();
    } catch { toast('Could not delete your data. Please try again.', 'error'); }
  };

  return (
    <DashboardLayout activeLabel="My Feedback">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">My feedback</h1>
            <p className="mt-1 text-sm text-text-secondary">Follow what happens to what you send us.</p>
          </div>
          <Button onClick={() => openFeedback()}><MessageSquarePlus className="h-4 w-4" aria-hidden="true" /> Send feedback</Button>
        </div>

        {error && <div role="alert" className="rounded-lg border border-warning-500/25 bg-warning-500/10 px-3 py-2 text-sm text-warning-500">We couldn’t load your feedback. <button type="button" className="underline" onClick={() => void load()}>Try again</button></div>}

        {items === null && !error ? <SkeletonCardList count={2} rows={3} /> : items && items.length === 0 ? (
          <EmptyState icon={MessageSquarePlus} title="No feedback sent yet" description="Press F then B anywhere, or use the button above." action={{ label: 'Send feedback', onClick: () => openFeedback() }} />
        ) : (
          <ul className="space-y-3">
            {items?.map((f) => (
              <li key={f.id}>
                <Card className="!p-4">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono font-semibold text-text-primary">{f.tracking_code}</span>
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 font-semibold text-accent">{STATUS_LABEL[f.status] ?? f.status}</span>
                    <span className="text-text-secondary">{f.category}{f.anonymous ? ' · anonymous' : ''}</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-text-primary">{f.message}</p>
                  {f.public_note && <p className="mt-2 rounded-lg bg-bg-tertiary p-2 text-sm text-text-secondary">Our note: {f.public_note}</p>}
                  <ol className="mt-3 space-y-1 border-s border-border ps-3 text-xs text-text-secondary" aria-label="Status history">
                    {f.events.map((e, i) => <li key={i}>{STATUS_LABEL[e.status] ?? e.status} — {formatDate(e.at)}{e.note ? `: ${e.note}` : ''}</li>)}
                  </ol>
                </Card>
              </li>
            ))}
          </ul>
        )}

        <Card className="space-y-4 !p-5">
          <h2 className="text-base font-semibold text-text-primary">Privacy and surveys</h2>
          {privacy && (
            <>
              <Switch label="Send my feedback anonymously by default" checked={privacy.anonymous_default} onChange={(v) => void update({ anonymousDefault: v })} />
              <Switch label="Don’t ask me to take surveys" checked={privacy.never_ask} onChange={(v) => void update({ neverAsk: v })} />
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void download()}><Download className="h-4 w-4" aria-hidden="true" /> Download my feedback data</Button>
            {!confirmDelete ? (
              <Button variant="secondary" onClick={() => setConfirmDelete(true)}><Trash2 className="h-4 w-4" aria-hidden="true" /> Delete my feedback data</Button>
            ) : (
              <span role="alert" className="flex flex-wrap items-center gap-2 text-sm text-text-primary">
                This permanently deletes everything above. <Button size="sm" onClick={() => void erase()}>Yes, delete</Button>
                <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button>
              </span>
            )}
          </div>
          <p className="text-xs text-text-secondary">Feedback is kept for up to 2 years, screenshots for 90 days, then personal links are removed.</p>
        </Card>
      </div>
    </DashboardLayout>
  );
}
