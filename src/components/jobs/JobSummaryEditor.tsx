// Staff editor for ONE job summary: edit → preview → send / publish to portal / hold / skip.
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Eye, Loader2, Pencil, Plus, RefreshCw, Save, Send, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { JobSummaryView } from '@/components/jobs/JobSummaryView';
import { useToast } from '@/contexts/ToastContext';
import {
  CHANNEL_LABELS,
  STATUS_LABELS,
  canEditContent,
  describeSummaryError,
  describeWarnings,
  draftChanged,
  draftWarnings,
  hasBlockingWarning,
  normalizeDraft,
  scheduledCountdown,
  summaryLink,
  toDraft,
  validateDraft,
  type JobSummary,
  type SummaryChannel,
  type SummaryDraft,
} from '@/lib/jobSummaries';
import {
  fetchJobGalleryPhotos,
  generateSummary,
  holdSummary,
  publishSummary,
  saveSummaryDraft,
  sendSummary,
  signStaffPhotoUrls,
  skipSummary,
} from '@/lib/jobSummariesApi';

const input = 'w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus-ring';
const label = 'mb-1 block text-xs font-medium text-text-secondary';
const lines = (v: string) => v.split('\n');

type Confirm = null | { kind: 'send' | 'resend' | 'skip' | 'regenerate'; blocking: boolean };

export function JobSummaryEditor({ summary, ownerId, onChange }: { summary: JobSummary; ownerId: string; onChange: (s: JobSummary) => void }) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<SummaryDraft>(() => toDraft(summary));
  const [busy, setBusy] = useState<null | 'save' | 'send' | 'publish' | 'hold' | 'skip' | 'regenerate'>(null);
  const [preview, setPreview] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [gallery, setGallery] = useState<{ storage_path: string; kind: 'before' | 'after' | 'progress'; caption: string | null }[]>([]);
  const [confirm, setConfirm] = useState<Confirm>(null);

  // Re-sync when the server row changes underneath us (realtime / regenerate) and there are no local edits.
  const serverDraft = useMemo(() => toDraft(summary), [summary]);
  useEffect(() => {
    setDraft(serverDraft);
  }, [summary.id, summary.generated_at, summary.last_edited_at]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = draftChanged(draft, serverDraft);
  const errors = validateDraft(draft);
  const hasErrors = Object.keys(errors).length > 0;
  const warnings = draftWarnings(draft, summary.warnings);
  const blocking = hasBlockingWarning(warnings);
  const editable = canEditContent(summary);
  const sent = !!summary.sent_at;

  const photoKey = draft.photos.map((p) => `${p.bucket}/${p.path}`).join('|');
  useEffect(() => {
    let cancelled = false;
    if (draft.photos.length === 0) return setUrls({});
    void signStaffPhotoUrls(draft.photos).then((u) => !cancelled && setUrls(u));
    return () => {
      cancelled = true;
    };
  }, [photoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    void fetchJobGalleryPhotos(summary.job_id, ownerId)
      .then((g) => !cancelled && setGallery(g))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [summary.job_id, ownerId]);

  const patch = (p: Partial<SummaryDraft>) => setDraft((d) => ({ ...d, ...p }));

  async function save(): Promise<JobSummary | null> {
    if (hasErrors) {
      toast(Object.values(errors)[0] as string, 'error');
      return null;
    }
    setBusy('save');
    try {
      const next = await saveSummaryDraft(ownerId, summary.id, normalizeDraft(draft));
      onChange(next);
      setDraft(toDraft(next));
      toast('Summary saved.', 'success');
      return next;
    } catch (e) {
      toast(describeSummaryError(e), 'error');
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function run(kind: 'send' | 'publish' | 'hold' | 'skip' | 'regenerate', resend = false) {
    setConfirm(null);
    if (kind !== 'regenerate' && kind !== 'hold' && kind !== 'skip' && dirty) {
      const saved = await save();
      if (!saved) return;
    }
    setBusy(kind);
    try {
      if (kind === 'send') {
        const r = await sendSummary(summary.id, { channel: draft.channel, resend });
        if (!r.ok) return void toast(r.error, 'error');
        onChange(r.data.summary);
        toast(r.data.status === 'sent' ? `Sent (${r.data.channel ?? 'portal'}).` : r.data.status === 'scheduled' ? 'Scheduled — it will go out when delivery windows allow.' : r.data.error || 'Could not send.', r.data.status === 'sent' || r.data.status === 'scheduled' ? 'success' : 'error');
      } else if (kind === 'publish') {
        const r = await publishSummary(summary.id);
        if (!r.ok) return void toast(r.error, 'error');
        onChange(r.data.summary);
        toast('Published to the customer portal (nothing was texted or emailed).', 'success');
      } else if (kind === 'hold') {
        const r = await holdSummary(summary.id);
        if (!r.ok) return void toast(r.error, 'error');
        onChange(r.data.summary);
        toast('Moved back to review.', 'success');
      } else if (kind === 'skip') {
        const r = await skipSummary(summary.id);
        if (!r.ok) return void toast(r.error, 'error');
        onChange(r.data.summary);
        toast('Marked as not sent.', 'success');
      } else {
        const r = await generateSummary(summary.job_id);
        if (!r.ok) return void toast(r.error, 'error');
        onChange(r.data.summary);
        setDraft(toDraft(r.data.summary));
        toast('Summary regenerated from the latest job data.', 'success');
      }
    } finally {
      setBusy(null);
    }
  }

  const addPhoto = (g: (typeof gallery)[number]) => {
    if (draft.photos.length >= 12 || draft.photos.some((p) => p.path === g.storage_path)) return;
    patch({ photos: [...draft.photos, { bucket: 'job-photos', path: g.storage_path, kind: g.kind, caption: g.caption }] });
  };
  const available = gallery.filter((g) => !draft.photos.some((p) => p.path === g.storage_path));

  const previewData = {
    business_name: null,
    headline: draft.headline,
    intro: draft.intro,
    work_summary: draft.work_summary,
    work_items: normalizeDraft(draft).work_items,
    parts: normalizeDraft(draft).parts,
    warranty: normalizeDraft(draft).warranty,
    maintenance_tips: normalizeDraft(draft).maintenance_tips,
    next_service_date: normalizeDraft(draft).next_service_date,
    next_service_note: draft.next_service_note,
    service_date: summary.service_date,
    photos: draft.photos.map((p) => ({ url: urls[`${p.bucket}/${p.path}`] ?? null, kind: p.kind, caption: p.caption })),
  };

  return (
    <div className="space-y-4">
      {/* status strip */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full border border-border px-2.5 py-1 font-semibold text-text-primary">{STATUS_LABELS[summary.status]}</span>
        {summary.status === 'scheduled' && <span className="text-text-secondary">{scheduledCountdown(summary.scheduled_send_at)}</span>}
        {sent && <span className="text-text-secondary">Sent {new Date(summary.sent_at!).toLocaleString()} · {summary.channel_used}</span>}
        {summary.view_count > 0 && <span className="text-text-secondary">Viewed {summary.view_count}×</span>}
        {summary.ai_polished && <span className="text-text-secondary">Wording tidied by AI — please read it</span>}
        {summary.edited_after_send_at && <span className="text-text-secondary">Edited after sending</span>}
      </div>
      {summary.delivery_error && (
        <p className="rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-xs text-text-primary">{summary.delivery_error}</p>
      )}
      {warnings.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-xs text-text-primary" aria-label="Things to check">
          {describeWarnings(warnings).map((m) => (
            <li key={m} className="flex gap-2">
              <AlertTriangle size={14} className="mt-px shrink-0 text-warning-500" aria-hidden="true" /> {m}
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <Button variant={preview ? 'secondary' : 'primary'} size="sm" onClick={() => setPreview(false)}>
          <Pencil size={14} aria-hidden="true" /> Edit
        </Button>
        <Button variant={preview ? 'primary' : 'secondary'} size="sm" onClick={() => setPreview(true)}>
          <Eye size={14} aria-hidden="true" /> Customer view
        </Button>
      </div>

      {preview ? (
        <div className="rounded-2xl border border-border bg-bg-primary p-4 sm:p-6">
          <JobSummaryView data={previewData} todayISO={new Date().toISOString().slice(0, 10)} />
        </div>
      ) : (
        <fieldset disabled={!editable} className="space-y-4 disabled:opacity-60">
          <div>
            <label className={label} htmlFor="js-headline">Headline</label>
            <input id="js-headline" className={input} value={draft.headline} onChange={(e) => patch({ headline: e.target.value })} maxLength={140} />
            {errors.headline && <p className="mt-1 text-xs text-danger-500">{errors.headline}</p>}
          </div>
          <div>
            <label className={label} htmlFor="js-intro">Introduction</label>
            <textarea id="js-intro" rows={3} className={input} value={draft.intro} onChange={(e) => patch({ intro: e.target.value })} maxLength={600} />
          </div>
          <div>
            <label className={label} htmlFor="js-found">What we found (optional)</label>
            <textarea id="js-found" rows={2} className={input} value={draft.work_summary} onChange={(e) => patch({ work_summary: e.target.value })} />
          </div>
          <div>
            <label className={label} htmlFor="js-items">What we did — one item per line</label>
            <textarea id="js-items" rows={5} className={input} value={draft.work_items.join('\n')} onChange={(e) => patch({ work_items: lines(e.target.value) })} />
            {(errors.work_items || errors.content) && <p className="mt-1 text-xs text-danger-500">{errors.work_items || errors.content}</p>}
          </div>

          {/* photos */}
          <div>
            <span className={label}>Photos ({draft.photos.length}/12)</span>
            <div className="flex flex-wrap gap-2">
              {draft.photos.map((p, i) => (
                <div key={`${p.bucket}/${p.path}`} className="relative h-20 w-20 overflow-hidden rounded-lg border border-border">
                  {urls[`${p.bucket}/${p.path}`] ? <img src={urls[`${p.bucket}/${p.path}`]} alt={p.caption || `${p.kind} photo`} className="h-full w-full object-cover" /> : <div className="h-full w-full bg-bg-tertiary" />}
                  <button type="button" aria-label="Remove photo" onClick={() => patch({ photos: draft.photos.filter((_, j) => j !== i) })} className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white">
                    <X size={12} aria-hidden="true" />
                  </button>
                  <span className="absolute bottom-0 left-0 bg-black/60 px-1 text-[10px] capitalize text-white">{p.kind}</span>
                </div>
              ))}
            </div>
            {available.length > 0 && draft.photos.length < 12 && (
              <details className="mt-2 text-xs text-text-secondary">
                <summary className="cursor-pointer">Add from this job’s gallery ({available.length})</summary>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {available.map((g) => (
                    <li key={g.storage_path}>
                      <button type="button" onClick={() => addPhoto(g)} className="focus-ring rounded-lg border border-border px-2 py-1 capitalize hover:bg-bg-tertiary">
                        <Plus size={11} className="mr-1 inline" aria-hidden="true" />
                        {g.kind}{g.caption ? ` · ${g.caption.slice(0, 20)}` : ''}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          {/* parts */}
          <div>
            <span className={label}>Parts used</span>
            <div className="space-y-2">
              {draft.parts.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <input aria-label="Quantity" type="number" min={1} className={`${input} w-20`} value={p.quantity} onChange={(e) => patch({ parts: draft.parts.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)) })} />
                  <input aria-label="Part name" className={input} value={p.name} onChange={(e) => patch({ parts: draft.parts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <button type="button" aria-label="Remove part" onClick={() => patch({ parts: draft.parts.filter((_, j) => j !== i) })} className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary"><Trash2 size={14} aria-hidden="true" /></button>
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={() => patch({ parts: [...draft.parts, { name: '', quantity: 1 }] })}><Plus size={14} aria-hidden="true" /> Add part</Button>
            </div>
          </div>

          {/* warranty */}
          <div>
            <span className={label}>Warranty</span>
            <div className="space-y-2">
              {draft.warranty.map((w, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-[1fr_9.5rem_1fr_auto]">
                  <input aria-label="Warranty label" placeholder="What is covered" className={input} value={w.label} onChange={(e) => patch({ warranty: draft.warranty.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                  <input aria-label="Warranty end date" type="date" className={input} value={w.expires_on ?? ''} onChange={(e) => patch({ warranty: draft.warranty.map((x, j) => (j === i ? { ...x, expires_on: e.target.value || null } : x)) })} />
                  <input aria-label="Warranty note" placeholder="Note (optional)" className={input} value={w.note ?? ''} onChange={(e) => patch({ warranty: draft.warranty.map((x, j) => (j === i ? { ...x, note: e.target.value || null } : x)) })} />
                  <button type="button" aria-label="Remove warranty" onClick={() => patch({ warranty: draft.warranty.filter((_, j) => j !== i) })} className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary"><Trash2 size={14} aria-hidden="true" /></button>
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={() => patch({ warranty: [...draft.warranty, { label: '', expires_on: null, note: null }] })}><Plus size={14} aria-hidden="true" /> Add warranty</Button>
            </div>
          </div>

          <div>
            <label className={label} htmlFor="js-tips">Maintenance tips — one per line</label>
            <textarea id="js-tips" rows={4} className={input} value={draft.maintenance_tips.join('\n')} onChange={(e) => patch({ maintenance_tips: lines(e.target.value) })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-[11rem_1fr]">
            <div>
              <label className={label} htmlFor="js-next">Next service date</label>
              <input id="js-next" type="date" className={input} value={draft.next_service_date ?? ''} onChange={(e) => patch({ next_service_date: e.target.value || null })} />
              {errors.next_service_date && <p className="mt-1 text-xs text-danger-500">{errors.next_service_date}</p>}
            </div>
            <div>
              <label className={label} htmlFor="js-next-note">Note</label>
              <input id="js-next-note" className={input} value={draft.next_service_note ?? ''} onChange={(e) => patch({ next_service_note: e.target.value || null })} maxLength={300} />
            </div>
          </div>
          <div>
            <label className={label} htmlFor="js-channel">Send by</label>
            <select id="js-channel" className={input} value={draft.channel} onChange={(e) => patch({ channel: e.target.value as SummaryChannel })}>
              {(Object.keys(CHANNEL_LABELS) as SummaryChannel[]).map((c) => (
                <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>
              ))}
            </select>
          </div>
        </fieldset>
      )}

      {/* actions */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button variant="secondary" size="sm" onClick={() => void save()} disabled={!dirty || busy !== null || !editable}>
          {busy === 'save' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />} Save
        </Button>
        {!sent ? (
          <Button size="sm" disabled={busy !== null || hasErrors} onClick={() => (blocking ? setConfirm({ kind: 'send', blocking: true }) : void run('send'))}>
            {busy === 'send' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Send size={14} aria-hidden="true" />} Send to customer
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={busy !== null || hasErrors} onClick={() => setConfirm({ kind: 'resend', blocking: false })}>
            <Send size={14} aria-hidden="true" /> Resend
          </Button>
        )}
        {!sent && (
          <Button variant="ghost" size="sm" disabled={busy !== null || hasErrors} onClick={() => void run('publish')}>Publish to portal only</Button>
        )}
        {summary.status === 'scheduled' && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run('hold')}>Hold</Button>}
        {!sent && summary.status !== 'draft' && summary.status !== 'scheduled' && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run('hold')}>Back to review</Button>}
        {!sent && summary.status !== 'skipped' && <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirm({ kind: 'skip', blocking: false })}>Don’t send</Button>}
        {!sent && (
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirm({ kind: 'regenerate', blocking: false })}>
            {busy === 'regenerate' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />} Regenerate
          </Button>
        )}
        {sent && (
          <button type="button" className="focus-ring text-xs text-accent underline" onClick={() => void navigator.clipboard.writeText(summaryLink(summary.token, window.location.origin))}>
            Copy customer link
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === 'skip' ? 'Don’t send this summary?' : confirm?.kind === 'regenerate' ? 'Regenerate from job data?' : confirm?.kind === 'resend' ? 'Send it again?' : 'Send despite warnings?'}
        description={
          confirm?.kind === 'skip'
            ? 'The customer will not receive it. You can move it back to review later.'
            : confirm?.kind === 'regenerate'
              ? 'This replaces your edits with a fresh summary built from the current job notes, photos and parts.'
              : confirm?.kind === 'resend'
                ? 'The customer gets the text/email again with the current version of the summary.'
                : 'There are items flagged above. Are you sure the customer should receive this now?'
        }
        confirmLabel={confirm?.kind === 'skip' ? 'Don’t send' : confirm?.kind === 'regenerate' ? 'Regenerate' : 'Send'}
        onConfirm={() => void run(confirm!.kind === 'resend' ? 'send' : confirm!.kind, confirm!.kind === 'resend')}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
