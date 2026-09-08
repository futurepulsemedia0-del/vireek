import { useRef } from 'react';
import { motion, useScroll, useTransform, useReducedMotion } from 'framer-motion';

type RevealImageProps = {
  /** filename without extension, e.g. "hero" -> looks for /hero.png */
  name: string;
  alt: string;
  /** intensity of the scroll-parallax shift in px (subtle by default) */
  parallax?: number;
  /** rounded corners + border like the rest of the product cards */
  framed?: boolean;
  className?: string;
  priority?: boolean;
  /** CSS object-position — where the interesting part of the image sits when cropped */
  focalPoint?: string;
};

/**
 * Single-source, scroll-revealed, parallaxed, Ken-Burns-polished image.
 * - One file serves every device — a responsive aspect-ratio (taller on
 *   mobile, wider on desktop) reshapes the crop per breakpoint so the same
 *   photo reads as intentional everywhere, not squeezed or letterboxed.
 * - Reveals once on scroll into view (no looping/flashing) with a slow
 *   cinematic zoom-out (Ken Burns) that settles after ~2.4s — this is what
 *   reads as "premium" instead of a flat static image.
 * - A gentle scroll-linked parallax drift on the whole frame.
 * - A very subtle desktop-only cursor tilt for depth (disabled on touch).
 * - Fully respects prefers-reduced-motion — all motion collapses to a plain
 *   fade when the user has that OS setting on.
 */
export function RevealImage({
  name,
  alt,
  parallax = 24,
  framed = true,
  className = '',
  priority = false,
  focalPoint = 'center',
}: RevealImageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = useReducedMotion();

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start end', 'end start'],
  });

  const y = useTransform(
    scrollYProgress,
    [0, 1],
    prefersReducedMotion ? [0, 0] : [parallax, -parallax]
  );

  return (
    <div ref={ref} className={`group relative overflow-hidden [perspective:1200px] ${className}`}>
      <motion.div
        initial={{ opacity: 0, y: 32, scale: 0.98 }}
        whileInView={{ opacity: 1, y: 0, scale: 1 }}
        viewport={{ once: true, margin: '-10% 0px -10% 0px' }}
        transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
        className={
          framed
            ? 'relative overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card transition-transform duration-500 ease-out will-change-transform dark:shadow-card-dark sm:rounded-3xl group-hover:[transform:rotateX(0.5deg)_rotateY(-0.5deg)]'
            : 'relative overflow-hidden'
        }
      >
        {/* Aspect ratio steps per breakpoint — mobile taller, desktop wider */}
        <motion.div
          style={{ y }}
          className="aspect-[4/5] w-full overflow-hidden will-change-transform sm:aspect-[16/10] lg:aspect-[16/9]"
        >
          <motion.img
            src={`/${name}.png`}
            alt={alt}
            loading={priority ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : 'auto'}
            decoding="async"
            style={{ objectPosition: focalPoint }}
            className="h-full w-full object-cover"
            draggable={false}
            initial={{ scale: prefersReducedMotion ? 1.05 : 1.16 }}
            whileInView={{ scale: 1.05 }}
            viewport={{ once: true, margin: '-10% 0px -10% 0px' }}
            transition={{ duration: 2.4, ease: [0.16, 1, 0.3, 1] }}
          />
        </motion.div>

        {/* Brand-tint overlays so the photo blends with the theme instead of looking pasted-on */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bg-primary/40 via-transparent to-transparent" />
        <div className="pointer-events-none absolute inset-0 bg-accent/5 mix-blend-overlay" />
        {/* Top hairline like the rest of the product cards on this site */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
      </motion.div>
    </div>
  );
}
