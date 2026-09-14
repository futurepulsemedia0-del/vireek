import { motion } from 'framer-motion';
import { Star } from 'lucide-react';
import { EASE, fadeUpItem, staggerContainer, viewport } from '@/lib/motion';

/**
 * Third-party review-platform badges (G2, Capterra, Trustpilot).
 *
 * IMPORTANT: `rating`, `reviewCount` and `url` below are placeholders.
 * Replace them with the real, current values from each profile before
 * shipping — never display a star rating or review count that isn't
 * pulled from the live listing.
 */
const HAS_VERIFIED_REVIEWS = false; // فقط وقتی پروفایل واقعی روی G2/Capterra/Trustpilot claim و تایید شد → true کن
interface ReviewPlatform {
  name: string;
  rating?: number;
  reviewCount?: number;
  url: string; 
  wordmark: string;
}

const REVIEW_PLATFORMS: ReviewPlatform[] = [
  { name: 'G2', rating: undefined, reviewCount: undefined, url: 'https://www.g2.com/products/vireek/reviews', wordmark: 'G2' },
  { name: 'Capterra', rating: undefined, reviewCount: undefined, url: 'https://www.capterra.com/p/vireek/', wordmark: 'Capterra' },
  { name: 'Trustpilot', rating: undefined, reviewCount: undefined, url: 'https://www.trustpilot.com/review/vireek.com', wordmark: 'Trustpilot' },
];

function StarRow({ rating }: { rating: number }) {
  const rounded = Math.round(rating * 2) / 2;
  return (
    <div className="flex items-center gap-0.5" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, i) => {
        const filled = i + 1 <= rounded;
        const half = !filled && i + 0.5 === rounded;
        return (
          <Star
            key={i}
            size={15}
            className={filled ? 'fill-success text-success' : half ? 'fill-success/50 text-success' : 'fill-transparent text-text-secondary/30'}
          />
        );
      })}
    </div>
  );
}

export function ReviewBadges() {
  if (!HAS_VERIFIED_REVIEWS) return null;
  return (
    <section className="border-y border-border/60 bg-bg-secondary/50 py-10 sm:py-12">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="text-center text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-text-secondary/60 sm:text-xs sm:tracking-[0.18em]"
        >
          Verified by independent review platforms
        </motion.p>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-6 grid gap-4 sm:grid-cols-3"
        >
          {REVIEW_PLATFORMS.map((platform) => (
            <motion.a
              key={platform.name}
              href={platform.url}
              target="_blank"
              rel="noopener noreferrer"
              variants={fadeUpItem}
              transition={{ duration: 0.5, ease: EASE }}
              className="focus-ring flex items-center justify-between gap-4 rounded-2xl border border-border bg-bg-primary px-5 py-4 shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:border-accent/25 dark:shadow-card-dark"
            >
              <div>
                <span className="text-sm font-bold tracking-tight text-text-primary">{platform.wordmark}</span>
                {platform.rating ? (
                  <div className="mt-1.5 flex items-center gap-2">
                    <StarRow rating={platform.rating} />
                    <span className="text-xs font-semibold text-text-secondary">
                      {platform.rating.toFixed(1)}{platform.reviewCount ? ` (${platform.reviewCount})` : ''}
                    </span>
                  </div>
                ) : (
                  <p className="mt-1.5 text-xs font-medium text-text-secondary">Read reviews</p>
                )}
              </div>
            </motion.a>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
