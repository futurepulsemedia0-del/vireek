/**
 * Dispute detail sheet — evidence builder, deadline, timeline, submit / accept.
 * Right-hand panel on desktop, full-screen sheet on mobile.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, ExternalLink, FileText, Loader2, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyStateError } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  EVIDENCE_CATEGORIES,
  EVIDENCE_TEXT_FIELDS,
  TEXT_FIELD_MAX,
  deadlineState,
  evidenceReadiness,
  formatBytes,
  formatMoney,
  isNeedsResponse,
  reasonMeta,
  statusMeta,
  validateDraft,
  validateEvidenceFile,
  type DisputeEventRow,
  type DisputeEvidenceFile,
  type DisputeTone,
  type EvidenceCategory,
  type StripeDisputeRow,
} from '@/lib/disputes';
import {
  acceptDispute,
  fetchDisputeDetail,
  getEvidenceFileUrl,
  removeEvidenceFile,
  saveEvidenceDraft,
  submitEvidence,
  syncDispute,
  uploadEvidenceFile,
} from '@/lib/disputesApi';

export const TONE_CLASS: Record<DisputeTone, string> = {
  neutral: 'bg-bg-tertiary text-text-secondary border-border',
  accent: 'bg-accent/10 text-accent border-accent/25',
  success: 'bg-success/10 text-success border-success/25',
  danger: 'bg-danger/10 text-danger border-danger/25',
  warning: 'bg-warning-500/10 text-warning-500 border-warning-500/25',
};

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent disabled:opacity-60';

interface Props {
  dispute: StripeDisputeRow;
  ownerId: string;
  onClose: () => void;
  /** Called after any server-side change so the list + stats refetch. */
  onChanged: () => void;
}

export function DisputeDetailPanel({ dispute, ownerId, onClose, onChanged }: Props) {
  const { toast } = useToast();
  const dialogRef = useFocusTrap(true);
  useEscapeToClose(true, onClose);

  const [files, setFiles] = useState<DisputeEvidenceFile[]>([]);
  const [events, setEvents] = useState<DisputeEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>(dispute.evidence_draft ?? {});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<EvidenceCategory | null>(null);
  const [busy, setBusy] = useState<'submit' | 'accept' | 'sync' | null>(null);
  const [confirm, setConfirm] = useState<'submit' | 'accept' | null>(null);
  const [showAllFields, setShowAllFields] = useState(false);
  const inputs = useRef<Partial<Record<EvidenceCategory, HTMLInputElement | null>>>({});

  const editable = isNeedsResponse(dispute.status) && dispute.submission_count === 0;
  const deadline = deadlineState(dispute.evidence_due_by);
  const expired = deadline.kind === 'overdue';
  const meta = reasonMeta(dispute.reason);
  const status = statusMeta(dispute.status);
  const readiness = useMemo(() => evidenceReadiness(dispute.reason, draft, files), [dispute.reason, draft, files]);

  // Reset local state when a different dispute is opened in the same panel instance.
  useEffect(() => {
    setDraft(dispute.evidence_draft ?? {});
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispute.id]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const detail = await fetchDisputeDetail(ownerId, dispute.id);
      setFiles(detail.files);
      setEvents(detail.events);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [ownerId, dispute.id]);

  useEffect(() => { void load(); }, [load]);

  // Warn before closing the tab with unsaved evidence text.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const setField = (key: string, value: string) => { setDraft((d) => ({ ...d, [key]: value })); setDirty(true); };

  const save = async (silent = false): Promise<boolean> => {
    const problem = validateDraft(draft);
    if (problem) { toast(problem, 'error'); return false; }
    setSaving(true);
    try {
      await saveEvidenceDraft(dispute.id, draft);
      setDirty(false);
      if (!silent) toast('Evidence draft saved', 'success');
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the draft.', 'error');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const onPick = async (category: EvidenceCategory, list: FileList | null) => {
    const file = list?.[0];
    const input = inputs.current[category];
    if (input) input.value = '';
    if (!file) return;
    const problem = validateEvidenceFile(file, files);
    if (problem) { toast(problem, 'error'); return; }
    setUploading(category);
    try {
      await uploadEvidenceFile(ownerId, dispute.id, category, file);
      await load();
      toast('File attached', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Upload failed.', 'error');
    } finally {
      setUploading(null);
    }
  };

  const onRemove = async (file: DisputeEvidenceFile) => {
    try {
      await removeEvidenceFile(file.id);
      setFiles((f) => f.filter((x) => x.id !== file.id));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove the file.', 'error');
    }
  };

  const onOpen = async (file: DisputeEvidenceFile) => {
    try { window.open(await getEvidenceFileUrl(file.storage_path), '_blank', 'noopener'); }
    catch { toast('Could not open the file.', 'error'); }
  };

  const run = async (kind: 'submit' | 'accept' | 'sync') => {
    setBusy(kind);
    try {
      if (kind === 'submit' && !(await save(true))) return;
      if (kind === 'submit') await submitEvidence(dispute.id);
      else if (kind === 'accept') await acceptDispute(dispute.id);
      else await syncDispute(dispute.id);
      toast(kind === 'submit' ? 'Evidence submitted to the bank' : kind === 'accept' ? 'Dispute accepted' : 'Refreshed from Stripe', 'success');
      onChanged();
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong.', 'error');
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const recommendedFields = EVIDENCE_TEXT_FIELDS.filter((f) => meta.texts.includes(f.key));
  const otherFields = EVIDENCE_TEXT_FIELDS.filter((f) => !meta.texts.includes(f.key));
  const visibleFields = showAllFields ? [...recommendedFields, ...otherFields] : recommendedFields;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Dispute ${dispute.stripe_dispute_id}`}
        className="flex h-full w-full flex-col overflow-hidden bg-bg-primary shadow-2xl sm:max-w-2xl sm:border-l sm:border-border">
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-text-primary">{formatMoney(dispute.amount_cents, dispute.currency)}</h2>
              <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASS[status.tone]}`}>{status.label}</span>
              {isNeedsResponse(dispute.status) && (
                <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASS[deadline.tone]}`}>{deadline.label}</span>
              )}
            </div>
            <p className="mt-1 truncate text-sm text-text-secondary">{dispute.customer_name ?? 'Unknown customer'} · {meta.label}{dispute.network_reason_code ? ` · code ${dispute.network_reason_code}` : ''}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring -mr-1 rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary"><X className="h-5 w-5" /></button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-4 py-5 sm:px-6">
          <section className="rounded-2xl border border-border bg-bg-secondary p-4 text-sm text-text-secondary">
            <p>{meta.hint}</p>
            {dispute.evidence_due_by && (
              <p className="mt-2 text-xs">Evidence due <strong className="text-text-primary">{new Date(dispute.evidence_due_by).toLocaleString()}</strong>. Missing it means an automatic loss.</p>
            )}
            {dispute.is_charge_refundable === false && <p className="mt-1 text-xs">This charge can no longer be refunded.</p>}
          </section>

          {editable && (
            <section aria-label="Evidence readiness">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-text-primary">Evidence readiness for “{meta.label}”</span>
                <span className="text-text-secondary">{readiness.pct}%</span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-valuenow={readiness.pct} aria-valuemin={0} aria-valuemax={100}>
                <div className={`h-full rounded-full transition-all ${readiness.pct >= 80 ? 'bg-success' : readiness.pct >= 40 ? 'bg-warning-500' : 'bg-danger'}`} style={{ width: `${readiness.pct}%` }} />
              </div>
              <p className="mt-1.5 text-[11px] text-text-secondary">Guidance based on what typically supports this reason — it does not guarantee the outcome. You can submit evidence only once.</p>
            </section>
          )}

          {loading ? (
            <div className="space-y-3" aria-busy="true"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>
          ) : loadFailed ? (
            <EmptyStateError title="Could not load evidence" onRetry={load} />
          ) : (
            <>
              {editable && !expired && (
                <section className="space-y-3" aria-label="Written evidence">
                  <h3 className="text-sm font-semibold text-text-primary">Written evidence</h3>
                  {visibleFields.map((f) => {
                    const value = draft[f.key] ?? '';
                    return (
                      <label key={f.key} className="block">
                        <span className="mb-1 flex items-center justify-between text-xs font-medium text-text-secondary">
                          <span>{f.label}{meta.texts.includes(f.key) && <span className="ml-1 text-accent">recommended</span>}</span>
                          {f.multiline && <span>{value.length.toLocaleString()}/{TEXT_FIELD_MAX.toLocaleString()}</span>}
                        </span>
                        {f.multiline ? (
                          <textarea rows={4} value={value} maxLength={TEXT_FIELD_MAX} placeholder={f.placeholder} onChange={(e) => setField(f.key, e.target.value)} className={inputClass} />
                        ) : (
                          <input type="text" value={value} maxLength={500} placeholder={f.placeholder} onChange={(e) => setField(f.key, e.target.value)} className={inputClass} />
                        )}
                      </label>
                    );
                  })}
                  {otherFields.length > 0 && (
                    <button type="button" onClick={() => setShowAllFields((v) => !v)} className="focus-ring rounded text-xs font-semibold text-accent">
                      {showAllFields ? 'Show fewer fields' : `Show ${otherFields.length} more fields`}
                    </button>
                  )}
                </section>
              )}

              {!editable && Object.values(dispute.evidence_draft ?? {}).some(Boolean) && (
                <section className="space-y-2" aria-label="Submitted evidence">
                  <h3 className="text-sm font-semibold text-text-primary">Evidence on file</h3>
                  {EVIDENCE_TEXT_FIELDS.filter((f) => dispute.evidence_draft?.[f.key]).map((f) => (
                    <div key={f.key} className="rounded-xl border border-border bg-bg-secondary p-3">
                      <p className="text-[11px] font-medium uppercase text-text-secondary">{f.label}</p>
                      <p className="mt-0.5 whitespace-pre-wrap text-sm text-text-primary">{dispute.evidence_draft[f.key]}</p>
                    </div>
                  ))}
                </section>
              )}

              <section className="space-y-3" aria-label="Evidence files">
                <h3 className="text-sm font-semibold text-text-primary">Files <span className="font-normal text-text-secondary">· PDF, JPG or PNG · {formatBytes(files.reduce((s, f) => s + f.size_bytes, 0))} of 4.5 MB used</span></h3>
                {EVIDENCE_CATEGORIES.filter((c) => editable || files.some((f) => f.category === c.key)).map((c) => {
                  const mine = files.filter((f) => f.category === c.key);
                  const recommended = meta.files.includes(c.key);
                  if (editable && !recommended && mine.length === 0 && !showAllFields) return null;
                  return (
                    <div key={c.key} className="rounded-xl border border-border bg-bg-secondary p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-text-primary">{c.label}{recommended && <span className="ml-1.5 text-xs font-normal text-accent">recommended</span>}</p>
                          <p className="text-xs text-text-secondary">{c.help}</p>
                        </div>
                        {editable && !expired && (
                          <>
                            <input ref={(el) => { inputs.current[c.key] = el; }} type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" aria-label={`Upload ${c.label}`} onChange={(e) => void onPick(c.key, e.target.files)} />
                            <Button type="button" variant="secondary" size="sm" disabled={uploading !== null} onClick={() => inputs.current[c.key]?.click()}>
                              {uploading === c.key ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Add
                            </Button>
                          </>
                        )}
                      </div>
                      {mine.length > 0 && (
                        <ul className="mt-2 space-y-1.5">
                          {mine.map((f) => (
                            <li key={f.id} className="flex items-center gap-2 rounded-lg bg-bg-primary px-2.5 py-1.5 text-xs">
                              <FileText className="h-4 w-4 shrink-0 text-text-secondary" />
                              <button type="button" onClick={() => void onOpen(f)} className="focus-ring min-w-0 flex-1 truncate text-left text-text-primary hover:underline">{f.file_name}</button>
                              <span className="shrink-0 text-text-secondary">{formatBytes(f.size_bytes)}</span>
                              {editable && !expired && (
                                <button type="button" onClick={() => void onRemove(f)} aria-label={`Remove ${f.file_name}`} className="focus-ring rounded p-1 text-text-secondary hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
                {!editable && files.length === 0 && <p className="text-xs text-text-secondary">No files were attached.</p>}
                {editable && <p className="text-[11px] text-text-secondary">Stripe accepts one file per category — if you have several documents, merge them into one PDF.</p>}
              </section>

              <section aria-label="Timeline">
                <h3 className="mb-2 text-sm font-semibold text-text-primary">Timeline</h3>
                {events.length === 0 ? <p className="text-xs text-text-secondary">No events recorded yet.</p> : (
                  <ol className="space-y-2 border-l border-border pl-4">
                    {events.map((ev) => (
                      <li key={ev.stripe_event_id} className="text-xs">
                        <p className="font-medium text-text-primary">{ev.event_type.replace('charge.dispute.', '').replace(/_/g, ' ')}{ev.status_after ? ` → ${statusMeta(ev.status_after).label}` : ''}</p>
                        <p className="text-text-secondary">{new Date(ev.event_created * 1000).toLocaleString()}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}

          {dispute.status === 'won' && <p className="flex items-center gap-2 rounded-xl border border-success/25 bg-success/10 p-3 text-sm text-success"><CircleCheck className="h-4 w-4" /> The bank ruled in your favor.</p>}
          {dispute.status === 'lost' && <p className="flex items-center gap-2 rounded-xl border border-danger/25 bg-danger/10 p-3 text-sm text-danger"><CircleAlert className="h-4 w-4" /> The bank ruled against you{dispute.submission_count === 0 ? ' — no evidence was submitted.' : '.'}</p>}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-border bg-bg-primary px-4 py-3 sm:px-6">
          <a href={`https://dashboard.stripe.com/disputes/${dispute.stripe_dispute_id}`} target="_blank" rel="noopener noreferrer" className="focus-ring mr-auto inline-flex items-center gap-1 rounded text-xs text-text-secondary hover:text-text-primary">
            Stripe <ExternalLink className="h-3 w-3" />
          </a>
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void run('sync')} aria-label="Refresh from Stripe">
            {busy === 'sync' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
          {editable && !expired && (
            <>
              <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirm('accept')}>Accept dispute</Button>
              <Button type="button" variant="secondary" size="sm" disabled={!dirty || saving || busy !== null} onClick={() => void save()}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save draft
              </Button>
              <Button type="button" size="sm" disabled={busy !== null || (files.length === 0 && !Object.values(draft).some((v) => v.trim()))} onClick={() => setConfirm('submit')}>
                {busy === 'submit' && <Loader2 className="h-4 w-4 animate-spin" />} Submit evidence
              </Button>
            </>
          )}
        </footer>
      </div>

      <ConfirmDialog
        open={confirm === 'submit'}
        title="Submit evidence to the bank?"
        description="You can only submit once. After this, the evidence is final and the bank decides — usually within 60–75 days."
        confirmLabel="Submit evidence"
        onConfirm={() => run('submit')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'accept'}
        title="Accept this dispute?"
        description={`You concede ${formatMoney(dispute.amount_cents, dispute.currency)} to the customer. The dispute closes as lost and this cannot be undone.`}
        confirmPhrase="accept dispute"
        confirmLabel="Accept and close"
        onConfirm={() => run('accept')}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
