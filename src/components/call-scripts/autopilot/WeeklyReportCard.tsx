import { useState } from 'react';
import { Newspaper, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useAutopilotT } from '@/i18n/autopilotNamespace';
import { fetchWeeklyReport, type ConcludedExperiment, type ReportItem, type WeeklyReport } from '@/lib/voiceAutopilot';
import { formatEffect } from './format';

export function WeeklyReportCard() {
  const { t } = useAutopilotT();
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(false);
    try { setReport(await fetchWeeklyReport()); } catch { setError(true); } finally { setLoading(false); }
  };

  const concluded = (e: ConcludedExperiment) => ({
    name: e.name, dimension: t(`dimension.${e.dimension}`), metric: t(`metric.${e.metric}`),
    estimate: formatEffect(e.metric, e.estimate), low: formatEffect(e.metric, e.low), high: formatEffect(e.metric, e.high), n: Math.min(e.nControl, e.nChallenger),
  });

  const line = (item: ReportItem): string => {
    switch (item.kind) {
      case 'win': return t('report.win', { ...concluded(item.exp), action: item.exp.appliedAction === 'promoted' ? t('report.winApplied') : t('report.winAwaiting') });
      case 'loss': return t('report.loss', concluded(item.exp));
      case 'inconclusive': return t('report.inconclusive', concluded(item.exp));
      case 'rollback': return t('report.rollback', concluded(item.exp));
      case 'running': return t('report.running', { name: item.exp.name, dimension: t(`dimension.${item.exp.dimension}`), n: item.exp.nMin, target: item.exp.nTarget });
      case 'learning': return t(`report.learning_${item.code}`);
      case 'next': return t('report.next', { dimension: t(`dimension.${item.test.dimension}`), scenario: item.test.scenario.replace(/_/g, ' ') });
    }
  };

  return (
    <section aria-labelledby="weekly-title" className="rounded-2xl border border-border bg-bg-secondary p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="weekly-title" className="flex items-center gap-2 text-base font-semibold text-text-primary"><Newspaper size={18} aria-hidden="true" className="text-accent" />{t('report.title')}</h3>
        <Button type="button" variant="secondary" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          {loading ? t('report.loading') : t('report.load')}
        </Button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{t('report.failed')}</p>}
      {report && (
        <div className="mt-3" aria-live="polite">
          <ul className="space-y-2 text-sm text-text-primary">
            {report.items.map((it, i) => (<li key={i} className="rounded-xl border border-border bg-bg-primary px-4 py-3">{line(it)}</li>))}
          </ul>
          <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-text-secondary">{t('report.limitsTitle')}</h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-text-secondary">
            {report.limitations.map((l) => (<li key={l}>{t(`report.limit_${l}`)}</li>))}
          </ul>
        </div>
      )}
    </section>
  );
}
