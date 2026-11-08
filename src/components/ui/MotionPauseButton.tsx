import { Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MotionLoop } from '@/hooks/useMotionLoop';

interface Props {
  loop: Pick<MotionLoop<HTMLElement>, 'reduced' | 'userPaused' | 'toggle'>;
  className?: string;
}

/** WCAG 2.2.2 Pause, Stop, Hide control. Renders nothing when motion is already reduced (nothing moves). */
export function MotionPauseButton({ loop, className = '' }: Props) {
  const { t } = useTranslation();
  if (loop.reduced) return null;
  const label = loop.userPaused ? t('motion.play') : t('motion.pause');
  const Icon = loop.userPaused ? Play : Pause;
  return (
    <button
      type="button"
      onClick={loop.toggle}
      className={`focus-ring inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-border bg-bg-secondary px-4 text-xs font-medium text-text-secondary transition-[color,background-color,border-color] hover:text-text-primary ${className}`}
    >
      <Icon size={14} strokeWidth={2.25} aria-hidden="true" />
      {label}
    </button>
  );
}
