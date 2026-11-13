// Recreated: verify against original intent (recovered verbatim from homepage-redesign.patch)
import { Link } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { HOME_FAQS } from '@/lib/homeContent';
import { container, eyebrow, h2, panel, sectionY, textLink } from './sectionStyles';

/** Native <details> keeps this accessible, keyboard-operable and JS-free. Same HOME_FAQS feed the FAQPage JSON-LD. */
export function HomeFaq() {
  return (
    <section id="faq" aria-labelledby="faq-heading" className={`${sectionY} border-t border-border`}>
      <div className="mx-auto w-full max-w-3xl px-5 sm:px-6">
        <p className={eyebrow}>FAQ</p>
        <h2 id="faq-heading" className={h2}>Straight answers</h2>
        <div className="mt-8 space-y-3">
          {HOME_FAQS.map((f) => (
            <details key={f.q} className={`${panel} group`}>
              <summary className="focus-ring flex min-h-[56px] cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-3 text-start [&::-webkit-details-marker]:hidden">
                <span className="text-base font-semibold text-text-primary">{f.q}</span>
                <ChevronDown size={18} aria-hidden="true" className="shrink-0 text-text-secondary transition-transform motion-reduce:transition-none group-open:rotate-180" />
              </summary>
              <p className="px-5 pb-5 text-sm leading-relaxed text-text-secondary sm:text-base">{f.a}</p>
            </details>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap gap-x-6">
          <Link to="/faq" className={textLink}>More questions</Link>
          <Link to="/security" className={textLink}>Security</Link>
          <Link to="/privacy" className={textLink}>Privacy</Link>
        </div>
      </div>
    </section>
  );
}
