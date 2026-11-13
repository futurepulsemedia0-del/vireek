// Recreated: verify against original intent (recovered verbatim from homepage-redesign.patch)
import { Link } from 'react-router-dom';
import { PRODUCT_SHOTS, type RealAsset } from '@/lib/homeContent';
import { DispatchExample, RecoverExample, CallExample } from './ExampleUi';
import { container, eyebrow, h2, lead, panel, sectionY, textLink } from './sectionStyles';

function Shot({ asset, fallback }: { asset: RealAsset | null; fallback: React.ReactNode }) {
  if (!asset) return <>{fallback}</>;
  return (
    <img
      src={asset.src}
      alt={asset.alt}
      width={asset.width}
      height={asset.height}
      loading="lazy"
      decoding="async"
      className="h-auto w-full rounded-xl border border-border"
    />
  );
}

// Bullets are limited to features listed in src/lib/pricing.ts.
const BLOCKS = [
  {
    key: 'answer',
    title: 'Answer every call',
    body: 'No voicemail, no hold music. Sarah picks up day or night and handles the common questions.',
    bullets: ['24/7 AI call answering', 'Emergency detection', 'Warm transfer to on-call staff (Professional and up)'],
    visual: <Shot asset={PRODUCT_SHOTS.answer} fallback={<CallExample />} />,
  },
  {
    key: 'dispatch',
    title: 'Book and dispatch',
    body: 'Jobs go straight onto your calendar and the customer gets a text confirmation.',
    bullets: ['Smart calendar booking', 'SMS appointment confirmations', 'Custom after-hours routing (Professional and up)'],
    visual: <Shot asset={PRODUCT_SHOTS.dispatch} fallback={<DispatchExample />} />,
  },
  {
    key: 'recover',
    title: 'Follow up and recover revenue',
    body: 'A missed call gets a text back, so the customer is not lost to the next company.',
    bullets: ['Missed-call text-back', 'Call summaries by email', 'Automated review requests (Professional and up)'],
    visual: <Shot asset={PRODUCT_SHOTS.recover} fallback={<RecoverExample />} />,
  },
] as const;

export function ProductProof() {
  return (
    <section id="product" aria-labelledby="product-heading" className={`${sectionY} border-t border-border`}>
      <div className={container}>
        <p className={eyebrow}>What you get</p>
        <h2 id="product-heading" className={h2}>More than a receptionist</h2>
        <p className={lead}>
          Vireek is a full operations platform for service businesses. Calls are where it starts.
        </p>
        <div className="mt-10 grid gap-6 lg:grid-cols-3">
          {BLOCKS.map((b) => (
            <article key={b.key} className={`${panel} flex flex-col gap-5 p-5`}>
              <div>
                <h3 className="text-lg font-semibold text-text-primary">{b.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{b.body}</p>
                <ul className="mt-3 space-y-1.5 text-sm text-text-primary">
                  {b.bullets.map((x) => (
                    <li key={x} className="flex gap-2"><span aria-hidden="true">·</span>{x}</li>
                  ))}
                </ul>
              </div>
              <div className="mt-auto">{b.visual}</div>
            </article>
          ))}
        </div>
        <div className="mt-6">
          <Link to="/platform" className={textLink}>See the full platform</Link>
        </div>
      </div>
    </section>
  );
}
