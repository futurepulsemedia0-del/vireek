// Recreated: verify against original intent (recovered verbatim from homepage-redesign.patch)
import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ButtonLink } from '@/components/ui/ButtonLink';
import { SARAH_PHONE } from '@/lib/site';
import { TRIAL } from '@/lib/homeContent';
import { trackHomeCta } from '@/lib/homeAnalytics';
import { container, h2, sectionY, textLink } from './sectionStyles';

export function FinalCta() {
  return (
    <section id="contact" aria-labelledby="final-heading" className={`${sectionY} border-t border-border text-center`}>
      <div className={`${container} flex flex-col items-center`}>
        <h2 id="final-heading" className={`${h2} max-w-2xl`}>Stop sending your customers to voicemail</h2>
        <ButtonLink to="/signup" size="lg" className="mt-8" onClick={() => trackHomeCta('final_primary')}>
          Start free trial
          <ArrowRight size={18} aria-hidden="true" className="rtl:-scale-x-100" />
        </ButtonLink>
        <p className="mt-3 text-sm text-text-secondary">{TRIAL.short}</p>
        <a href={SARAH_PHONE} className={`${textLink} mt-2`} onClick={() => trackHomeCta('final_call')}>
          Or call Sarah and hear her first
        </a>
        <p className="mt-6 text-xs text-text-secondary">
          Sarah is an AI and tells callers so. <Link to="/security" className="underline underline-offset-2">Security</Link> ·{' '}
          <Link to="/refund-policy" className="underline underline-offset-2">Cancellation policy</Link>
        </p>
      </div>
    </section>
  );
}
