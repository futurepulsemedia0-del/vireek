import { Link } from 'react-router-dom';
import { Img } from '@/components/ui/Img';
import { FOUNDER_BIO, FOUNDER_LINKEDIN_URL, FOUNDER_NAME, FOUNDER_TITLE } from '@/lib/founder';
import { container, eyebrow, h2, panel, sectionY, textLink } from './sectionStyles';

/** Compressed portrait (320×430 WebP, ~6 KB). The 1.6 MB original stays at /founder.jpg for the media kit. */
const PHOTO = { src: '/founder-320.webp', width: 320, height: 430 } as const;

/**
 * Short "who is behind this" block. Renders nothing while FOUNDER_NAME in src/lib/founder.ts is still the
 * placeholder (equal to the title), so a card reading "Founder & CEO / Founder & CEO" can never ship.
 */
export function FounderNote() {
  const name = FOUNDER_NAME.trim();
  if (!name || name === FOUNDER_TITLE) return null;

  return (
    <section id="founder" aria-labelledby="founder-heading" className={`${sectionY} border-t border-border`}>
      <div className={container}>
        <div className={`${panel} grid gap-6 p-6 sm:grid-cols-[auto_1fr] sm:gap-10 sm:p-10`}>
          <Img
            src={PHOTO.src}
            width={PHOTO.width}
            height={PHOTO.height}
            alt={`${name}, ${FOUNDER_TITLE} of Vireek`}
            className="h-auto w-28 rounded-xl border border-border object-cover sm:w-36"
          />
          <div>
            <p className={eyebrow}>Who is behind Vireek</p>
            <h2 id="founder-heading" className={h2}>{name}</h2>
            <p className="mt-1 text-sm font-medium text-text-secondary">{FOUNDER_TITLE}</p>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-text-secondary">{FOUNDER_BIO}</p>
            <div className="mt-4 flex flex-wrap gap-x-6">
              <Link to="/leadership" className={textLink}>About the team</Link>
              <a href={FOUNDER_LINKEDIN_URL} target="_blank" rel="noopener noreferrer" className={textLink}>
                LinkedIn
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
