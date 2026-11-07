import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Dices } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { RZ_NS } from '@/i18n/dispatchRandomizationNamespace';
import { projectedDaysToPower, type NaturalAnalysis } from '@/lib/naturalRandomization';

interface Props {
  analysis: NaturalAnalysis;
  elapsedDays: number;
  /** null while the setting is still loading. */
  randomizationEnabled: boolean | null;
}

/** Progress and honesty notes for a running near-tie experiment (all text via i18next). */
export function NaturalProgressCard({ analysis, elapsedDays, randomizationEnabled }: Props) {
  const { t, i18n } = useTranslation(RZ_NS);
  const num = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 });
  const days = projectedDaysToPower(analysis, elapsedDays);
  return (
    <Card className="!p-5">
      <div className="flex items-center gap-2">
        <Dices size={16} className="text-accent" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-text-primary">{t('experiment.cardTitle')}</h3>
      </div>
      {randomizationEnabled === false && (
        <p role="alert" className="mt-3 rounded-lg border border-warning-500/30 bg-warning-500/10 p-3 text-sm text-text-primary">{t('experiment.off')}</p>
      )}
      <ul className="mt-3 space-y-1 text-sm text-text-primary">
        <li>{t('experiment.draws', { n: num.format(analysis.randomizedJobs) })}</li>
        <li>{t('experiment.informative', { n: num.format(analysis.informativeJobs) })}</li>
        {analysis.randomizedJobs > 0 && <li>{t('experiment.compliance', { pct: num.format(analysis.complianceRate * 100) })}</li>}
        <li>{days === null ? t('experiment.etaUnknown') : t('experiment.eta', { days: num.format(days) })}</li>
      </ul>
      <p className="mt-3 text-xs text-text-secondary">{t('experiment.local')}</p>
      <p className="mt-2 text-sm"><Link to="/dashboard/assignment-rules/fair-tiebreaking" className="focus-ring font-medium text-accent hover:underline">{t('experiment.link')}</Link></p>
    </Card>
  );
}
