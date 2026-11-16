import { ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useHomeFaqs, useHomeT } from '@/i18n/homeNamespace';
import { eyebrow, h2, panel, sectionY, textLink } from './sectionStyles';

/** Native <details>/<summary>: keyboard-operable, announced correctly by screen readers, and JS-free. */
export function FaqSection() {
  const { t } = useHomeT();
  const faqs = useHomeFaqs();

  return (
    <section id="faq" aria-labelledby="faq-heading" className={`${sectionY} border-t border-border`}>
      <div className="mx-auto w-full max-w-3xl px-5 sm:px-6">
        <p className={eyebrow}>{t('faq.eyebrow')}</p>
        <h2 id="faq-heading" className={h2}>{t('faq.title')}</h2>
        <div className="mt-8 space-y-3">
          {faqs.map((f) => (
            <details key={f.q} className={`${panel} group`}>
              <summary className="focus-ring flex min-h-[56px] cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-3 text-start [&::-webkit-details-marker]:hidden">
                <span className="text-base font-semibold text-text-primary">{f.q}</span>
                <ChevronDown
                  size={18}
                  aria-hidden="true"
                  className="shrink-0 text-text-secondary transition-transform motion-reduce:transition-none group-open:rotate-180"
                />
              </summary>
              <p className="px-5 pb-5 text-sm leading-relaxed text-text-secondary sm:text-base">{f.a}</p>
            </details>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap gap-x-6">
          <Link to="/faq" className={textLink}>{t('faq.more')}</Link>
          <Link to="/security" className={textLink}>{t('faq.security')}</Link>
          <Link to="/privacy" className={textLink}>{t('faq.privacy')}</Link>
        </div>
      </div>
    </section>
  );
}
