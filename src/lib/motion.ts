import { Variants } from 'framer-motion';

export const EASE = [0.16, 1, 0.3, 1] as const;

export const fadeUp: Variants = {
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
};

export const fadeUpItem: Variants = {
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
};

export const viewport = { once: true, margin: '-80px' } as const;

export const staggerContainer: Variants = {
  initial: {},
  whileInView: { transition: { staggerChildren: 0.05 } },
};

export function sectionHeadingClass() {
  return 'mt-3 font-display text-3xl font-semibold leading-[1.15] tracking-tight text-text-primary md:text-5xl';
}

export function eyebrowClass() {
  return 'text-eyebrow font-semibold uppercase tracking-[0.16em] text-accent';
}

export function bodyClass() {
  return 'mt-5 text-base leading-relaxed text-text-secondary md:text-lg';
}
