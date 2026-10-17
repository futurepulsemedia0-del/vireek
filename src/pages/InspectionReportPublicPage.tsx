/**
 * Public customer view of an inspection report — /inspection/:token (no auth).
 * Reads ONLY through the inspection-report-public edge function (matches on the
 * unguessable share token; returns display-safe fields and short-lived signed
 * photo/PDF URLs). Signing itself happens on the existing /sign/:token page.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Circle, Clock3, Download, FileSignature, ImageOff } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/Skeleton';
import { ResultPill } from '@/components/inspection/pills';
import {
  SECTION_LABEL,
  VERDICT_LABEL,
  checklistProgress,
  fetchPublicReport,
  formatDate,
  formatDateTime,
  type PublicReportResult,
} from '@/lib/inspectionReports';

export function InspectionReportPublicPage() {
  const { token } = useParams<{ token: string }>();
  const [result, setResult] = useState<PublicReportResult | null>(null);

  const load = useCallback(async () => {
    setResult(null);
    if (!token) return setResult({ ok: false, reason: 'not_found' });
    setResult(await fetchPublicReport(token));
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex min-h-screen flex-col bg-bg-primary">
      <Header />
      <main className="flex-1 px-4 py-10 sm:py-16">
        <div className="mx-auto w-full max-w-3xl space-y-6">
          {result === null && (
            <div className="space-y-4" aria-busy="true" aria-label="Loading report">
              <Skeleton className="h-10 w-2/3" />
              <Skeleton className="h-40 w-full rounded-2xl" />
              <Skeleton className="h-56 w-full rounded-2xl" />
            </div>
          )}

          {result && !result.ok && (
            <Card className="text-center">
              {result.reason === 'expired' ? <Clock3 size={28} className="mx-auto mb-3 text-text-secondary" /> : <AlertCircle size={28} className="mx-auto mb-3 text-text-secondary" />}
              <h1 className="text-lg font-semibold text-text-primary">
                {result.reason === 'expired' ? 'This link has expired' : result.reason === 'error' ? "We couldn't load this report" : 'This report is not available'}
              </h1>
              <p className="mt-2 text-sm text-text-secondary">
                {result.reason === 'error'
                  ? 'Please check your connection and try again.'
                  : 'Ask the business that sent it for a fresh link.'}
              </p>
              {result.reason === 'error' && (
                <Button type="button" size="sm" className="mt-4" onClick={load}>Try again</Button>
              )}
            </Card>
          )}

          {result?.ok && <ReportView data={result.data} />}
        </div>
      </main>
      <Footer />
    </div>
  );
}

function ReportView({ data }: { data: Extract<PublicReportResult, { ok: true }>['data'] }) {
  const { report, businessName, photos, pdfUrl, signature } = data;
  const progress = checklistProgress(report.checklist);
  const signed = report.status === 'signed' || signature?.status === 'completed';
  const awaiting = !signed && signature && ['sent', 'viewed', 'partially_signed'].includes(signature.status);

  return (
    <>
      <header>
        <p className="text-xs font-semibold uppercase tracking-wider text-accent">{businessName ?? 'Inspection report'}</p>
        <h1 className="mt-1 break-words text-2xl font-bold text-text-primary sm:text-3xl">{report.title}</h1>
        <p className="mt-2 text-sm text-text-secondary">
          {report.report_number} · Inspected {formatDate(report.inspected_at)}
          {report.inspector_name ? ` by ${report.inspector_name}` : ''}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <ResultPill result={report.overall_result} />
          {pdfUrl && (
            <a href={pdfUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2 text-sm font-semibold text-text-primary hover:border-accent/40">
              <Download size={16} aria-hidden="true" /> Download PDF
            </a>
          )}
        </div>
      </header>

      {signed && (
        <div role="status" className="flex items-start gap-3 rounded-2xl border border-success/30 bg-success/10 p-4 text-sm text-text-primary">
          <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
          This report has been signed{report.signed_at ? ` on ${formatDateTime(report.signed_at)}` : ''}.
        </div>
      )}
      {awaiting && (
        <div role="status" className="flex items-start gap-3 rounded-2xl border border-accent/30 bg-accent/10 p-4 text-sm text-text-primary">
          <FileSignature size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          A signature request was sent to you by email or text. Open that message to review and sign this report.
        </div>
      )}

      <Card className="space-y-2 p-5 sm:p-8">
        <h2 className="text-lg font-semibold text-text-primary">Details</h2>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {[
            ['Customer', report.customer_name],
            ['Address', report.address],
            ['Service', report.service_type],
            ['Inspector', report.inspector_name],
          ].map(([k, v]) =>
            v ? (
              <div key={k}>
                <dt className="text-xs font-medium uppercase tracking-wide text-text-secondary">{k}</dt>
                <dd className="break-words text-text-primary">{v}</dd>
              </div>
            ) : null,
          )}
        </dl>
      </Card>

      {report.summary && (
        <Card className="space-y-2 p-5 sm:p-8">
          <h2 className="text-lg font-semibold text-text-primary">Summary</h2>
          <p className="whitespace-pre-wrap break-words text-sm text-text-primary">{report.summary}</p>
        </Card>
      )}

      {progress.total > 0 && (
        <Card className="space-y-4 p-5 sm:p-8">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-text-primary">Checklist</h2>
            <span className="text-sm text-text-secondary">{progress.done}/{progress.total} completed</span>
          </div>
          <ul className="divide-y divide-border/70">
            {report.checklist.map((item, i) => (
              <li key={`${item.label}-${i}`} className="flex items-start gap-3 py-2.5">
                {item.done ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" aria-label="Completed" /> : <Circle size={18} className="mt-0.5 shrink-0 text-warning-500" aria-label="Not completed" />}
                <span className="min-w-0 flex-1 break-words text-sm text-text-primary">{item.label}</span>
              </li>
            ))}
          </ul>
          {report.evidence && (
            <p className="rounded-xl bg-bg-tertiary p-4 text-sm text-text-secondary">
              <span className="font-semibold text-text-primary">Field evidence check: {VERDICT_LABEL[report.evidence.verdict]}.</span>{' '}
              {report.evidence.summary}
            </p>
          )}
        </Card>
      )}

      {photos.length > 0 && (
        <Card className="space-y-4 p-5 sm:p-8">
          <h2 className="text-lg font-semibold text-text-primary">Photos</h2>
          <ul className="grid gap-4 sm:grid-cols-2">
            {photos.map((p, i) => (
              <li key={i} className="overflow-hidden rounded-xl border border-border bg-bg-primary">
                {p.url ? (
                  <img src={p.url} alt={p.caption || `${SECTION_LABEL[p.section]} photo`} loading="lazy" className="aspect-[4/3] w-full object-cover" />
                ) : (
                  <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 bg-bg-tertiary text-xs text-text-secondary">
                    <ImageOff size={20} aria-hidden="true" /> Photo unavailable
                  </div>
                )}
                <div className="p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{SECTION_LABEL[p.section]}</p>
                  {p.caption && <p className="mt-1 break-words text-sm text-text-primary">{p.caption}</p>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {signature && signature.signers.length > 0 && (
        <Card className="space-y-3 p-5 sm:p-8">
          <h2 className="text-lg font-semibold text-text-primary">Signatures</h2>
          <ul className="space-y-2">
            {signature.signers.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-bg-tertiary px-4 py-3 text-sm">
                <span className="text-text-primary">{s.name}</span>
                <span className={`text-xs font-semibold capitalize ${s.status === 'signed' ? 'text-success' : 'text-text-secondary'}`}>
                  {s.status === 'signed' ? `Signed ${formatDateTime(s.signed_at)}` : s.status}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {report.share_expires_at && <p className="text-center text-xs text-text-secondary">This private link is available until {formatDate(report.share_expires_at)}.</p>}
    </>
  );
}
