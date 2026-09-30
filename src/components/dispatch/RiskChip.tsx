import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { DECISION_LABELS, LEVEL_COLORS, LEVEL_LABELS, type RiskReport } from '@/lib/riskIntelligence';

/** Compact Risk Intelligence badge for job cards. Renders nothing without a report. */
export function RiskChip({ report }: { report: RiskReport | null | undefined }) {
  if (!report) return null;
  const top = report.flags[0]?.title;
  const title = [`${DECISION_LABELS[report.coverage.decision]} (score ${report.overallScore})`, top].filter(Boolean).join(' — ');
  const Icon = report.overallLevel === 'low' ? ShieldCheck : ShieldAlert;
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${LEVEL_COLORS[report.overallLevel]}`}
    >
      <Icon size={11} aria-hidden="true" />
      Risk: {LEVEL_LABELS[report.overallLevel]} · {report.overallScore}
    </span>
  );
}
