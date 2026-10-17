import { RESULT_LABEL, STATUS_LABEL, type OverallResult, type ReportStatus } from '@/lib/inspectionReports';

const RESULT_CLS: Record<OverallResult, string> = {
  pass: 'bg-success/10 text-success',
  attention: 'bg-warning-500/10 text-warning-500',
  fail: 'bg-danger/10 text-danger',
};

const STATUS_CLS: Record<ReportStatus, string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  published: 'bg-accent/10 text-accent',
  signed: 'bg-success/10 text-success',
  voided: 'bg-bg-tertiary text-text-secondary line-through',
};

export function ResultPill({ result }: { result: OverallResult | null }) {
  if (!result) return null;
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${RESULT_CLS[result]}`}>{RESULT_LABEL[result]}</span>;
}

export function StatusPill({ status }: { status: ReportStatus }) {
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_CLS[status]}`}>{STATUS_LABEL[status]}</span>;
}
