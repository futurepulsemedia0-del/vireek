import { useEffect, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { SurveyModal } from '@/components/surveys/SurveyModal';
import { fetchRecentCompletedJobs, sendSurveyNow, type CompletedJobOption } from '@/lib/surveysApi';
import { SURVEY_TYPE_LABELS, type SurveyTemplate } from '@/lib/surveys';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary transition-colors focus-visible:border-accent';

/** Send one survey right now for a recently completed job (same compliant path as auto-send). */
export function SendSurveyDialog({
  open,
  ownerId,
  templates,
  presetTemplateId,
  onClose,
  onSent,
  onError,
}: {
  open: boolean;
  ownerId: string;
  templates: SurveyTemplate[];
  presetTemplateId: string | null;
  onClose: () => void;
  onSent: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [jobs, setJobs] = useState<CompletedJobOption[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [jobId, setJobId] = useState('');
  const [sending, setSending] = useState(false);

  const usable = templates.filter((t) => t.is_active);

  useEffect(() => {
    if (!open) return;
    setJobs(null);
    setLoadFailed(false);
    setJobId('');
    setTemplateId(presetTemplateId && usable.some((t) => t.id === presetTemplateId) ? presetTemplateId : (usable[0]?.id ?? ''));
    let cancelled = false;
    fetchRecentCompletedJobs(ownerId)
      .then((rows) => !cancelled && setJobs(rows))
      .catch(() => !cancelled && setLoadFailed(true));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ownerId, presetTemplateId]);

  const send = async () => {
    if (!templateId || !jobId || sending) return;
    setSending(true);
    const res = await sendSurveyNow(templateId, jobId);
    setSending(false);
    if (res.ok) {
      onSent(res.status === 'sent' ? `Survey sent${res.channel ? ` via ${res.channel.replace('+', ' + ')}` : ''}.` : 'Survey queued — it will go out when SMS hours open.');
      onClose();
    } else {
      onError(res.error);
    }
  };

  return (
    <SurveyModal open={open} onClose={onClose} title="Send a survey now" description="Pick a completed job from the last 30 days.">
      {usable.length === 0 ? (
        <p className="text-sm text-text-secondary">Create an active survey first, then you can send it to any completed job.</p>
      ) : (
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-text-primary">Survey</span>
            <select className={selectClass} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {usable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({SURVEY_TYPE_LABELS[t.survey_type]})
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-text-primary">Completed job</span>
            {jobs === null && !loadFailed ? (
              <div className="flex items-center gap-2 py-3 text-sm text-text-secondary" role="status">
                <Loader2 size={16} className="animate-spin" aria-hidden="true" /> Loading jobs…
              </div>
            ) : loadFailed ? (
              <p className="text-sm text-danger" role="alert">
                Couldn't load your jobs. Close and try again.
              </p>
            ) : jobs && jobs.length === 0 ? (
              <p className="text-sm text-text-secondary">No jobs were completed in the last 30 days.</p>
            ) : (
              <select className={selectClass} value={jobId} onChange={(e) => setJobId(e.target.value)}>
                <option value="">Select a job…</option>
                {jobs?.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.customer_name}
                    {j.service_type ? ` — ${j.service_type}` : ''}
                    {j.completed_at ? ` (${new Date(j.completed_at).toLocaleDateString()})` : ''}
                  </option>
                ))}
              </select>
            )}
          </label>

          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose} disabled={sending}>
              Cancel
            </Button>
            <Button onClick={() => void send()} disabled={!templateId || !jobId || sending}>
              {sending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
              Send survey
            </Button>
          </div>
        </div>
      )}
    </SurveyModal>
  );
}
