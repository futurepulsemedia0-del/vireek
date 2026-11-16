import { ArrowRight, Bot, CreditCard, Lock, ScrollText, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ButtonLink } from '@/components/ui/ButtonLink';
import { HOME_VARS, asRecords, useHomeT } from '@/i18n/homeNamespace';
import { trackHomeCta } from '@/lib/homeAnalytics';
import { FOUNDING_OFFER, TESTIMONIALS } from '@/lib/homeContent';
import { container, eyebrow, h2, lead, panel, sectionY, textLink } from './sectionStyles';

const ICONS = [ShieldCheck, Lock, ScrollText, CreditCard, Bot] as const;

/**
 * Proof section. It renders only what is real:
 *  - TESTIMONIALS is empty until the owner supplies a quote they have permission to publish;
 *  - FOUNDING_OFFER is null until a real offer exists;
 *  - every security item maps to something implemented in this repo (RLS, TLS/at-rest, audit log, Stripe, AI disclosure).
 * No certification (SOC 2, PCI, ISO) and no uptime figure is claimed: src/lib/trust/claims.ts marks them as not held.
 */
export function TrustProof() {
  const { t } = useHomeT();
  const items = asRecords(t('proof.securityItems', { returnObjects: true }), ['title', 'body'] as const);

  return (
    <section id="trust" aria-labelledby="trust-proof-heading" className={`${sectionY} border-t border-border`}>
      <div className={container}>
        <div className={`${panel} grid gap-8 p-6 sm:p-10 md:grid-cols-[1.2fr_0.8fr] md:items-center`}>
          <div>
            <p className={eyebrow}>{t('proof.eyebrow')}</p>
            <h2 id="trust-proof-heading" className={h2}>{t('proof.title')}</h2>
            <p className={lead}>{t('proof.lead')}</p>
            {FOUNDING_OFFER && (
              <p className="mt-4 text-sm text-text-primary">
                <strong>{FOUNDING_OFFER.title}.</strong> {FOUNDING_OFFER.terms}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-3">
            <ButtonLink to="/signup" size="lg" className="w-full" onClick={() => trackHomeCta('founding_primary')}>
              {t('common.startTrial')}
              <ArrowRight size={18} aria-hidden="true" className="rtl:-scale-x-100" />
            </ButtonLink>
            <p className="text-sm text-text-secondary">{t('common.trial', HOME_VARS)}</p>
          </div>
        </div>

        {TESTIMONIALS.length > 0 && (
          <div className="mt-8 grid gap-5 md:grid-cols-2" role="list" aria-label={t('proof.quoteLabel')}>
            {TESTIMONIALS.map((q) => (
              <figure key={q.name} role="listitem" className={`${panel} p-6`}>
                <blockquote className="text-base leading-relaxed text-text-primary">{q.quote}</blockquote>
                <figcaption className="mt-3 text-sm text-text-secondary">{q.name}, {q.role}, {q.business}</figcaption>
              </figure>
            ))}
          </div>
        )}

        <h3 className="mt-12 font-display text-xl font-semibold text-text-primary">{t('proof.securityTitle')}</h3>
        <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item, i) => {
            const Icon = ICONS[i] ?? ICONS[0];
            return (
              <li key={item.title} className="flex gap-3 rounded-2xl border border-border p-5">
                <Icon size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-text-secondary" />
                <div>
                  <p className="text-sm font-semibold text-text-primary">{item.title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-text-secondary">{item.body}</p>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="mt-6">
          <Link to="/security" className={textLink}>{t('proof.securityLink')}</Link>
        </div>
      </div>
    </section>
  );
}
