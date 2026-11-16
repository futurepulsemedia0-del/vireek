// src/components/support/SupportAgentIcon.tsx
//
// The Vireek Support Agent mark: a speech bubble whose inside is a "V" (Vireek) and
// whose corner carries a live "spark" node — the agent's pulse. One glyph, three states:
//   idle      spark breathes slowly
//   thinking  an orbit ring spins around the spark (fast)
//   healing   the orbit ring turns slowly while a fix is being applied
// Uses currentColor only (the host decides the colour → works on gradient, light, dark and
// forced-colors). Animations are SMIL and are skipped entirely under prefers-reduced-motion.

import { usePrefersReducedMotion } from '@/lib/usePrefersReducedMotion';

export type SupportAgentIconState = 'idle' | 'thinking' | 'healing';

const SIZES = { sm: 20, md: 24, lg: 32, xl: 48 } as const;

interface Props {
  size?: keyof typeof SIZES;
  state?: SupportAgentIconState;
  /** Provide when the icon stands alone (no visible text next to it). */
  title?: string;
  className?: string;
}

export function SupportAgentIcon({ size = 'md', state = 'idle', title, className }: Props) {
  const reduced = usePrefersReducedMotion();
  const px = SIZES[size];
  const animate = !reduced;
  const ringDur = state === 'thinking' ? '0.9s' : '2.6s';

  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {/* Bubble with a tail at the lower-left */}
      <path
        d="M6.5 8.5A4.5 4.5 0 0 1 11 4h10a4.5 4.5 0 0 1 4.5 4.5v9A4.5 4.5 0 0 1 21 22h-6.6l-4.9 4.3a.8.8 0 0 1-1.3-.6V22.1A4.5 4.5 0 0 1 6.5 17.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      {/* The V */}
      <path d="m11.2 11.3 4.3 6.2 4.3-6.2" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
      {/* Agent spark */}
      <circle cx="24.5" cy="6" r="2.4" fill="currentColor">
        {animate && state === 'idle' ? (
          <animate attributeName="r" values="2.1;2.8;2.1" dur="2.8s" repeatCount="indefinite" />
        ) : null}
      </circle>
      {state !== 'idle' ? (
        <circle cx="24.5" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.2" strokeDasharray="5 4.4" strokeLinecap="round">
          {animate ? (
            <animateTransform attributeName="transform" type="rotate" from="0 24.5 6" to="360 24.5 6" dur={ringDur} repeatCount="indefinite" />
          ) : null}
        </circle>
      ) : null}
    </svg>
  );
}
