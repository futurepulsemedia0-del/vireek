import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Circle,
  Copy,
  Download,
  ExternalLink,
  FileSignature,
  FileText,
  ImageOff,
  Link2,
  Loader2,
  RefreshCw,
  Save,
  Send,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCard } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { createSignatureRequest } from '@/lib/signatures';
import {
  CAPTION_MAX,
  RESULT_LABEL,
  SECTION_LABEL,
  SHARE_STATE_LABEL,
  SUMMARY_MAX,
  TITLE_MAX,
  VERDICT_LABEL,
  cancelSignatureRequest,
  checklistProgress,
  deleteReport,
  formatDate,
  formatDateTime,
  getReport,
  getShareUrl,
  isPdfStale,
  publishReport,
  shareState,
  updateReport,
  updateShareSettings,
  uploadReportPdf,
  voidReport,
  type OverallResult,
  type ReportDetail,
} from '@/lib/inspectionReports';
import { buildInspectionReportPdf, prepareReportPhotos } from '@/lib/inspectionReportPdf';
import { ResultPill, StatusPill } from '@/components/inspection/pills';

interface FormState {
  title: string;
  summary: string;
  overallResult: OverallResult | '';
  photos: { path: string; caption: string; include: boolean }[];
}

function formFrom(d: ReportDetail): FormState {
  return {
    title: d.report.title,
    summary: d.report.summary ?? '',
    overallResult: d.report.overall_result ?? '',
    photos: d.report.photos.map((p) => ({ path: p.path, caption: p.caption, include: p.include })),
  };
}

type Busy = null | 'save' | 'share' | 'pdf' | 'link' | 'sign' | 'cancelSign' | 'void' | 'delete';
type Confirm = null | 'void' | 'delete' | 'rotate' | 'cancelSign';

export function InspectionReportDetail({
  reportId,
  onBack,
  onDeleted,
}: {
  reportId: string;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const { toast } = useToast();
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorText, setErrorText] = useState<string | undefined>();
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [shareDays, setShareDays] = useState(30);
  const [copied, setCopied] = useState(false);
  const [signer, setSigner] = useState({ name: '', email: '', phone: '' });
  const [signerTouched, setSignerTouched] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const apply = useCallback((d: ReportDetail) => {
    setDetail(d);
    setForm(formFrom(d));
    setSigner((s) => (s.name || s.email || s.phone ? s : { name: d.report.customer_name, email: d.report.customer_email ?? '', phone: d.report.customer_phone ?? '' }));
  }, []);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      apply(await getReport(reportId));
      setStatus('ready');
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : undefined);
      setStatus('error');
    }
  }, [apply, reportId]);

  useEffect(() => {
    void load();
  }, [load]);

  const report = detail?.report ?? null;
  const isDraft = report?.status === 'draft';
  const baseline = useMemo(() => (detail ? formFrom(detail) : null), [detail]);
  const dirty = !!form && !!baseline && JSON.stringify(form) !== JSON.stringify(baseline);

  const run = async (kind: NonNullable<Busy>, fn: () => Promise<ReportDetail>, success?: string): Promise<boolean> => {
    setBusy(kind);
    try {
      apply(await fn());
      if (success) toast(success, 'success');
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong. Please try again.', 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    form
      ? run(
          'save',
          () => updateReport({ id: reportId, title: form.title, summary: form.summary, overallResult: form.overallResult || null, photos: form.photos }),
          'Report saved.',
        )
      : Promise.resolve(false);

  const handleShare = async () => {
    if (!form || !report) return;
    if (!form.title.trim()) return toast('Add a title before sharing.', 'error');
    if (!form.overallResult) return toast('Choose an overall result before sharing.', 'error');
    if (dirty && !(await save())) return;
    await run('share', () => publishReport(reportId, shareDays), 'Report shared — the customer link is live.');
  };

  const handlePdf = async () => {
    if (!detail || !report) return;
    setBusy('pdf');
    try {
      const prepared = await prepareReportPhotos(detail.photos);
      const blob = await buildInspectionReportPdf({
        report,
        businessName: detail.businessName,
        photos: prepared,
        signature: detail.signature,
        shareUrl: report.status === 'draft' ? null : getShareUrl(report.share_token),
      });
      const skipped = detail.photos.filter((p) => p.include).length - prepared.length;
      // Always hand the user the file, even if storing it for the customer link fails.
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `${report.report_number}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      try {
        apply(await uploadReportPdf(reportId, blob));
        toast(skipped > 0 ? `PDF ready — ${skipped} photo(s) couldn't be loaded and were left out.` : 'PDF generated and attached.', skipped > 0 ? 'info' : 'success');
      } catch (e) {
        toast(e instanceof Error ? `PDF downloaded, but not saved: ${e.message}` : 'PDF downloaded, but could not be saved.', 'error');
      }
    } catch {
      toast('Could not generate the PDF. Please try again.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(getShareUrl(report.share_token));
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('Could not access the clipboard — select the link and copy it manually.', 'error');
    }
  };

  const sendSignature = async () => {
    if (!report) return;
    setSignerTouched(true);
    if (!signer.name.trim() || (!signer.email.trim() && !signer.phone.trim())) return;
    setBusy('sign');
    try {
      await createSignatureRequest({
        document_type: 'custom',
        document_id: report.id,
        customer_id: report.customer_id,
        title: report.title,
        document_summary: `Inspection report ${report.report_number}${report.overall_result ? ` — ${RESULT_LABEL[report.overall_result]}` : ''}. Review the full report before signing.`,
        document_url: getShareUrl(report.share_token),
        signers: [{ name: signer.name.trim(), email: signer.email.trim() || undefined, phone: signer.phone.trim() || undefined, role: 'signer' }],
      });
      apply(await getReport(reportId));
      toast('Signature request sent.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not send the signature request.', 'error');
    } finally {
      setBusy(null);
    }
  };

  // ------------------------------------------------------------ render
  if (status === 'loading') {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading report">
        <Skeleton className="h-8 w-2/3" />
        <SkeletonCard rows={4} />
        <SkeletonCard rows={3} />
      </div>
    );
  }
  if (status === 'error' || !detail || !report || !form) {
    return <EmptyStateError icon={FileText} title="Couldn't load this report" description={errorText} onRetry={load} />;
  }

  const share = shareState(report, new Date());
  const progress = checklistProgress(report.checklist);
  const stale = isPdfStale(report.updated_at, report.pdf_generated_at);
  const photosShown = isDraft ? detail.photos : detail.photos.filter((p) => p.include);
  const signatureLive = detail.signature;
  const signatureOpen = signatureLive && !['completed', 'declined', 'expired'].includes(signatureLive.status);
  const canShareActions = report.status === 'published' || report.status === 'signed';
  const signerError = signerTouched && (!signer.name.trim() || (!signer.email.trim() && !signer.phone.trim()));

  return (
    <div className="space-y-6">
      {/* ---------- Header ---------- */}
      <div>
        <button type="button" onClick={onBack} className="focus-ring mb-3 rounded-lg text-sm font-medium text-text-secondary hover:text-text-primary">
          ← All reports
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-bold text-text-primary">{report.title}</h1>
            <p className="mt-1 text-sm text-text-secondary">
              {report.report_number} · {report.customer_name}
              {report.address ? ` · ${report.address}` : ''} · Inspected {formatDate(report.inspected_at)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ResultPill result={report.overall_result} />
            <StatusPill status={report.status} />
          </div>
        </div>
      </div>

      {report.status === 'voided' && (
        <div role="status" className="flex items-start gap-3 rounded-2xl border border-border bg-bg-tertiary p-4 text-sm text-text-secondary">
          <XCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
          This report was voided on {formatDate(report.updated_at)}. Its customer link no longer works.
        </div>
      )}

      {/* ---------- Overview ---------- */}
      <Card className="space-y-4 p-5 sm:p-8">
        <h2 className="text-lg font-semibold text-text-primary">Overview</h2>
        {isDraft ? (
          <>
            <Input label="Title" value={form.title} maxLength={TITLE_MAX} required onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text-primary">Overall result</span>
              <select
                value={form.overallResult}
                onChange={(e) => setForm({ ...form, overallResult: e.target.value as FormState['overallResult'] })}
                className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary"
              >
                <option value="">Select a result…</option>
                {(Object.keys(RESULT_LABEL) as OverallResult[]).map((r) => (
                  <option key={r} value={r}>{RESULT_LABEL[r]}</option>
                ))}
              </select>
              <span className="mt-1.5 block text-xs text-text-secondary">Pre-filled from the checklist and field evidence — you can change it.</span>
            </label>
            <Textarea
              label="Summary & findings"
              rows={6}
              value={form.summary}
              maxLength={SUMMARY_MAX}
              helperText={`${form.summary.length}/${SUMMARY_MAX} · Pre-filled from the job's work notes.`}
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
            />
          </>
        ) : report.summary ? (
          <p className="whitespace-pre-wrap break-words text-sm text-text-primary">{report.summary}</p>
        ) : (
          <p className="text-sm text-text-secondary">No summary was added.</p>
        )}
      </Card>

      {/* ---------- Checklist ---------- */}
      <Card className="space-y-4 p-5 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-text-primary">Checklist</h2>
          {progress.total > 0 && <span className="text-sm text-text-secondary">{progress.done}/{progress.total} completed</span>}
        </div>
        {progress.total === 0 ? (
          <p className="text-sm text-text-secondary">No checklist is configured for this service type. Add one in Settings → Job Quality Gate.</p>
        ) : (
          <>
            <div className="h-2 overflow-hidden rounded-full bg-bg-tertiary" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Checklist completion">
              <div className={`h-full rounded-full ${progress.percent === 100 ? 'bg-success' : 'bg-warning-500'}`} style={{ width: `${progress.percent}%` }} />
            </div>
            <ul className="divide-y divide-border/70">
              {report.checklist.map((item, i) => (
                <li key={`${item.label}-${i}`} className="flex items-start gap-3 py-2.5">
                  {item.done ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" aria-label="Completed" /> : <Circle size={18} className="mt-0.5 shrink-0 text-warning-500" aria-label="Not completed" />}
                  <span className="min-w-0 flex-1 break-words text-sm text-text-primary">{item.label}</span>
                  {item.completed_at && <span className="shrink-0 text-xs text-text-secondary">{formatDate(item.completed_at)}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
        {report.evidence && (
          <div className="rounded-xl bg-bg-tertiary p-4 text-sm">
            <p className="font-semibold text-text-primary">Field evidence check: {VERDICT_LABEL[report.evidence.verdict]}</p>
            {report.evidence.summary && <p className="mt-1 text-text-secondary">{report.evidence.summary}</p>}
            {report.evidence.safety_flag_count > 0 && (
              <p className="mt-1 flex items-center gap-1.5 text-danger"><AlertTriangle size={14} aria-hidden="true" /> {report.evidence.safety_flag_count} safety flag(s) raised</p>
            )}
          </div>
        )}
      </Card>

      {/* ---------- Photos ---------- */}
      <Card className="space-y-4 p-5 sm:p-8">
        <h2 className="text-lg font-semibold text-text-primary">Photos</h2>
        {photosShown.length === 0 ? (
          <p className="text-sm text-text-secondary">No photos were captured for this job.</p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {photosShown.map((p) => {
              const f = form.photos.find((x) => x.path === p.path);
              return (
                <li key={`${p.bucket}/${p.path}`} className={`overflow-hidden rounded-xl border border-border bg-bg-primary ${isDraft && f && !f.include ? 'opacity-60' : ''}`}>
                  {p.url ? (
                    <img src={p.url} alt={p.caption || `${SECTION_LABEL[p.section]} photo`} loading="lazy" className="aspect-[4/3] w-full object-cover" />
                  ) : (
                    <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 bg-bg-tertiary text-xs text-text-secondary">
                      <ImageOff size={20} aria-hidden="true" /> Photo unavailable
                    </div>
                  )}
                  <div className="space-y-2 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{SECTION_LABEL[p.section]}</p>
                    {isDraft && f ? (
                      <>
                        <Input
                          aria-label="Photo caption"
                          placeholder="Add a caption"
                          value={f.caption}
                          maxLength={CAPTION_MAX}
                          onChange={(e) => setForm({ ...form, photos: form.photos.map((x) => (x.path === p.path ? { ...x, caption: e.target.value } : x)) })}
                        />
                        <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                          <input
                            type="checkbox"
                            checked={f.include}
                            className="focus-ring h-4 w-4 rounded border-border"
                            onChange={(e) => setForm({ ...form, photos: form.photos.map((x) => (x.path === p.path ? { ...x, include: e.target.checked } : x)) })}
                          />
                          Include in report
                        </label>
                      </>
                    ) : (
                      p.caption && <p className="break-words text-sm text-text-primary">{p.caption}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* ---------- Customer link ---------- */}
      {report.status !== 'voided' && (
        <Card className="space-y-4 p-5 sm:p-8">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-text-primary"><Link2 size={18} aria-hidden="true" /> Customer link</h2>
          {isDraft ? (
            <>
              <p className="text-sm text-text-secondary">Sharing creates a private link the customer can open without an account. Once shared, the content is locked.</p>
              <label className="flex flex-wrap items-center gap-2 text-sm text-text-primary">
                Link expires after
                <select value={shareDays} onChange={(e) => setShareDays(Number(e.target.value))} className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm">
                  {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
                </select>
              </label>
              <Button type="button" size="sm" onClick={handleShare} disabled={busy !== null}>
                {busy === 'share' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
                {dirty ? 'Save & share with customer' : 'Share with customer'}
              </Button>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${share === 'active' ? 'bg-success/10 text-success' : 'bg-warning-500/10 text-warning-500'}`}>{SHARE_STATE_LABEL[share]}</span>
                <span className="text-xs text-text-secondary">
                  {report.share_expires_at ? `Expires ${formatDate(report.share_expires_at)}` : 'No expiry'} · {report.view_count} view{report.view_count === 1 ? '' : 's'}
                  {report.last_viewed_at ? ` · last ${formatDateTime(report.last_viewed_at)}` : ''}
                </span>
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-border bg-bg-primary p-3">
                <code className="min-w-0 flex-1 break-all text-xs text-text-primary">{getShareUrl(report.share_token)}</code>
                <button type="button" onClick={copyLink} aria-label={copied ? 'Link copied' : 'Copy link'} className="focus-ring inline-flex h-9 min-w-[36px] shrink-0 items-center justify-center rounded-lg border border-border px-2 text-text-secondary hover:text-text-primary">
                  {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                </button>
                <a href={getShareUrl(report.share_token)} target="_blank" rel="noreferrer" aria-label="Open customer view" className="focus-ring inline-flex h-9 min-w-[36px] shrink-0 items-center justify-center rounded-lg border border-border px-2 text-text-secondary hover:text-text-primary">
                  <ExternalLink size={14} />
                </a>
              </div>
              {canShareActions && (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => run('link', () => updateShareSettings(reportId, { enabled: !report.share_enabled }), report.share_enabled ? 'Link disabled.' : 'Link enabled.')}>
                    {report.share_enabled ? 'Disable link' : 'Enable link'}
                  </Button>
                  <Button type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => run('link', () => updateShareSettings(reportId, { expiresInDays: shareDays, enabled: true }), `Link now expires in ${shareDays} days.`)}>
                    Extend to {shareDays} days
                  </Button>
                  <select aria-label="Expiry days" value={shareDays} onChange={(e) => setShareDays(Number(e.target.value))} className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm">
                    {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
                  </select>
                  <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirm('rotate')}>
                    <RefreshCw size={16} aria-hidden="true" /> New link
                  </Button>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {/* ---------- E-sign ---------- */}
      {canShareActions && (
        <Card className="space-y-4 p-5 sm:p-8">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-text-primary"><FileSignature size={18} aria-hidden="true" /> Customer e-signature</h2>
          {signatureLive && !['declined', 'expired'].includes(signatureLive.status) ? (
            <>
              <p className="text-sm text-text-secondary">
                {signatureLive.status === 'completed' ? 'Signed — a legally-recorded e-signature with audit trail is on file.' : 'Waiting on the customer. They received a secure signing link.'}
              </p>
              <ul className="space-y-2">
                {signatureLive.signers.map((s, i) => (
                  <li key={i} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-bg-tertiary px-4 py-3 text-sm">
                    <span className="text-text-primary">{s.name}</span>
                    <span className={`text-xs font-semibold capitalize ${s.status === 'signed' ? 'text-success' : s.status === 'declined' ? 'text-danger' : 'text-text-secondary'}`}>
                      {s.status === 'signed' ? `Signed ${formatDateTime(s.signed_at)}` : s.status}
                    </span>
                  </li>
                ))}
              </ul>
              {signatureOpen && (
                <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirm('cancelSign')}>
                  Cancel signature request
                </Button>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-text-secondary">Send the customer a secure link to review this report and sign it electronically.</p>
              {share !== 'active' && <p role="status" className="text-sm text-warning-500">Enable the customer link first — the signing page links to the report.</p>}
              <div className="grid gap-4 sm:grid-cols-3">
                <Input label="Signer name" value={signer.name} required error={signerTouched && !signer.name.trim() ? 'Required' : undefined} onChange={(e) => setSigner({ ...signer, name: e.target.value })} />
                <Input label="Email" type="email" inputMode="email" value={signer.email} onChange={(e) => setSigner({ ...signer, email: e.target.value })} />
                <Input label="Phone" type="tel" inputMode="tel" value={signer.phone} onChange={(e) => setSigner({ ...signer, phone: e.target.value })} />
              </div>
              {signerError && signer.name.trim() && <p role="alert" className="text-xs text-danger">Add an email or phone number so we can deliver the signing link.</p>}
              <Button type="button" size="sm" onClick={sendSignature} disabled={busy !== null || share !== 'active'}>
                {busy === 'sign' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
                Request signature
              </Button>
            </>
          )}
        </Card>
      )}

      {/* ---------- PDF ---------- */}
      {report.status !== 'voided' && (
        <Card className="space-y-4 p-5 sm:p-8">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-text-primary"><FileText size={18} aria-hidden="true" /> Branded PDF</h2>
          <p className="text-sm text-text-secondary">
            {report.pdf_generated_at ? `Last generated ${formatDateTime(report.pdf_generated_at)}.` : 'Generate a branded PDF with the checklist and photos. It is also offered to the customer on their link.'}
            {stale && ' The report changed since — regenerate to refresh it.'}
          </p>
          {isDraft && dirty && <p role="status" className="text-sm text-warning-500">Save your changes before generating the PDF.</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={handlePdf} disabled={busy !== null || (isDraft && dirty)}>
              {busy === 'pdf' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
              {report.pdf_path ? 'Regenerate PDF' : 'Generate PDF'}
            </Button>
            {detail.pdfUrl && (
              <a href={detail.pdfUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary hover:border-accent/40">
                <ExternalLink size={16} aria-hidden="true" /> Open saved PDF
              </a>
            )}
          </div>
        </Card>
      )}

      {/* ---------- Danger zone ---------- */}
      {(isDraft || (report.status === 'published')) && (
        <div className="flex flex-wrap gap-2">
          {isDraft && (
            <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirm('delete')}>
              <Trash2 size={16} aria-hidden="true" /> Delete draft
            </Button>
          )}
          {report.status === 'published' && (
            <Button type="button" size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirm('void')}>
              <XCircle size={16} aria-hidden="true" /> Void report
            </Button>
          )}
        </div>
      )}

      {/* ---------- Sticky save bar (draft) ---------- */}
      {isDraft && (
        <div className={`fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg-secondary/95 px-4 py-3 backdrop-blur transition-transform duration-200 lg:left-60 print:hidden ${dirty ? 'translate-y-0' : 'translate-y-full'}`} aria-hidden={!dirty}>
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
            <p className="text-sm text-text-secondary">You have unsaved changes.</p>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="ghost" tabIndex={dirty ? 0 : -1} disabled={busy !== null} onClick={() => baseline && setForm(baseline)}>Discard</Button>
              <Button type="button" size="sm" tabIndex={dirty ? 0 : -1} disabled={busy !== null || !form.title.trim()} onClick={() => void save()}>
                {busy === 'save' ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />} Save changes
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirm === 'void'}
        title="Void this report?"
        description="The customer link stops working immediately and any pending signature request is cancelled. This can't be undone."
        confirmLabel="Void report"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => { setConfirm(null); await run('void', () => voidReport(reportId), 'Report voided.'); }}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete this draft?"
        description="The draft is removed permanently. The job and its photos are not affected."
        confirmLabel="Delete draft"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          setConfirm(null);
          setBusy('delete');
          try { await deleteReport(reportId); toast('Draft deleted.', 'success'); onDeleted(); }
          catch (e) { toast(e instanceof Error ? e.message : 'Could not delete the draft.', 'error'); setBusy(null); }
        }}
      />
      <ConfirmDialog
        open={confirm === 'rotate'}
        title="Create a new customer link?"
        description="The current link stops working. Anyone you already sent it to will need the new one."
        confirmLabel="Create new link"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => { setConfirm(null); await run('link', () => updateShareSettings(reportId, { rotate: true }), 'New link created.'); }}
      />
      <ConfirmDialog
        open={confirm === 'cancelSign'}
        title="Cancel the signature request?"
        description="The customer's signing link stops working. You can send a new request afterwards."
        confirmLabel="Cancel request"
        onCancel={() => setConfirm(null)}
        onConfirm={async () => { setConfirm(null); await run('cancelSign', () => cancelSignatureRequest(reportId), 'Signature request cancelled.'); }}
      />
    </div>
  );
}
