import { ArrowDown, CalendarDays, PhoneMissed, Receipt } from 'lucide-react';
import { asRecords, useHomeT } from '@/i18n/homeNamespace';
import { container, eyebrow, h2, lead, panel, sectionY, textLink } from './sectionStyles';

const ICONS = [PhoneMissed, CalendarDays, Receipt] as const;

export function ProblemSolution() {
  const { t } = useHomeT();
  const items = asRecords(t('problem.items', { returnObjects: true }), ['pain', 'fix'] as const);

  return (
    <section id="problem" aria-labelledby="problem-heading" className={sectionY}>
      <div className={container}>
        <p className={eyebrow}>{t('problem.eyebrow')}</p>
        <h2 id="problem-heading" className={h2}>{t('problem.title')}</h2>
        <p className={lead}>{t('problem.lead')}</p>

        <ul className="mt-10 grid gap-5 md:grid-cols-3">
          {items.map((item, i) => {
            const Icon = ICONS[i] ?? ICONS[0];
            return (
              <li key={item.pain} className={`${panel} flex flex-col p-6`}>
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
                  <Icon size={18} aria-hidden="true" />
                </span>
                <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-text-secondary rtl:normal-case rtl:tracking-normal">
                  {t('problem.problemLabel')}
                </p>
                <p className="mt-1.5 text-base leading-relaxed text-text-secondary">{item.pain}</p>
                <ArrowDown size={16} aria-hidden="true" className="my-4 text-text-secondary" />
                <p className="text-xs font-semibold uppercase tracking-wide text-text-primary rtl:normal-case rtl:tracking-normal">
                  {t('problem.solutionLabel')}
                </p>
                <p className="mt-1.5 text-base font-medium leading-relaxed text-text-primary">{item.fix}</p>
              </li>
            );
          })}
        </ul>
        <div className="mt-6">
          <a href="#calculator" className={textLink}>{t('calculatorCta')}</a>
        </div>
      </div>
    </section>
  );
}
