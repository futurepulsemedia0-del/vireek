import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ButtonLink } from '@/components/ui/ButtonLink';
import { HOME_VARS, useHomeT } from '@/i18n/homeNamespace';
import { trackHomeCta } from '@/lib/homeAnalytics';
import { SARAH_PHONE } from '@/lib/site';
import { container, h2, panel, sectionY, textLink } from './sectionStyles';

export function HomeFinalCta() {
  const { t } = useHomeT();

  return (
    <section id="contact" aria-labelledby="final-heading" className={`${sectionY} border-t border-border`}>
      <div className={container}>
        <div className={`${panel} flex flex-col items-center px-6 py-14 text-center sm:px-12 sm:py-20`}>
          <h2 id="final-heading" className={`${h2} mt-0 max-w-2xl`}>{t('final.title')}</h2>
          <ButtonLink to="/signup" size="lg" className="mt-8" onClick={() => trackHomeCta('final_primary')}>
            {t('common.startTrial')}
            <ArrowRight size={18} aria-hidden="true" className="rtl:-scale-x-100" />
          </ButtonLink>
          <p className="mt-3 text-sm text-text-secondary">{t('common.trial', HOME_VARS)}</p>
          <a href={SARAH_PHONE} className={`${textLink} mt-2`} onClick={() => trackHomeCta('final_call')}>
            {t('final.call')}
          </a>
          <p className="mt-6 text-xs text-text-secondary">
            {t('final.aiNote')}{' '}
            <Link to="/security" className="underline underline-offset-2">{t('final.security')}</Link> ·{' '}
            <Link to="/refund-policy" className="underline underline-offset-2">{t('final.cancellation')}</Link>
          </p>
        </div>
      </div>
    </section>
  );
}
