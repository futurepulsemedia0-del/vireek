import { asRecords, useHomeT } from '@/i18n/homeNamespace';
import { MockWindow, mockChip, mockRow } from './MockWindow';
import { container, eyebrow, h2, panel, sectionY } from './sectionStyles';

function StepVisual({ index }: { index: number }) {
  const { t } = useHomeT();
  const base = { exampleLabel: t('common.example'), ariaLabel: t('common.example') };

  if (index === 0) {
    return (
      <MockWindow title={t('how.mockForward')} {...base}>
        <div className={mockRow}>
          <span>{t('how.mockLine')}</span>
          <strong className="text-text-primary" dir="ltr">(555) 010-0123</strong>
        </div>
      </MockWindow>
    );
  }
  if (index === 1) {
    return (
      <MockWindow title={t('how.mockCall')} {...base}>
        <div className={mockRow}><span className="text-text-primary">{t('hero.callerLine')}</span></div>
      </MockWindow>
    );
  }
  return (
    <MockWindow title={t('how.mockBooked')} {...base}>
      <div className={mockRow}>
        <span className="text-text-primary">{t('hero.booked')}</span>
        <span className={mockChip}>{t('hero.texted')}</span>
      </div>
    </MockWindow>
  );
}

export function HowItWorksSteps() {
  const { t } = useHomeT();
  const steps = asRecords(t('how.steps', { returnObjects: true }), ['title', 'body'] as const);

  return (
    <section id="how-it-works" aria-labelledby="how-heading" className={`${sectionY} border-t border-border`}>
      <div className={container}>
        <p className={eyebrow}>{t('how.eyebrow')}</p>
        <h2 id="how-heading" className={h2}>{t('how.title')}</h2>
        <ol className="mt-10 grid gap-6 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title} className={`${panel} flex flex-col gap-5 p-5`}>
              <div>
                <p className="font-display text-sm font-semibold text-text-secondary">{t('how.stepLabel', { n: i + 1 })}</p>
                <h3 className="mt-1 text-lg font-semibold text-text-primary">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{s.body}</p>
              </div>
              <div className="mt-auto"><StepVisual index={i} /></div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
