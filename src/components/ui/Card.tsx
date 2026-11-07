import { HTMLAttributes, KeyboardEvent, forwardRef } from 'react';
import { motion } from 'framer-motion';
import { motionClass, surfaceClass } from '@/lib/ui/interaction';

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

const PADDING: Record<CardPadding, string> = { none: '', sm: 'p-4', md: 'p-6', lg: 'p-8' };
interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Hover lift + press feedback (default true = existing behavior). Use false for static cards. */
  interactive?: boolean;
  selected?: boolean;
  error?: boolean;
  /** Inner padding. Default 'lg' (p-8) preserves the previous behaviour. */
  padding?: CardPadding;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className = '', children, interactive = true, selected, error = false, padding = 'lg', onClick, onKeyDown, role, tabIndex, ...props }, ref) => {
    const clickable = !!onClick;
    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(e);
      if (clickable && !e.defaultPrevented && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        e.currentTarget.click();
      }
    };
    return (
      <div
        ref={ref}
        role={role ?? (clickable ? 'button' : undefined)}
        tabIndex={tabIndex ?? (clickable ? 0 : undefined)}
        aria-pressed={clickable && selected !== undefined ? selected : undefined}
        data-selected={selected || undefined}
        onClick={onClick}
        onKeyDown={clickable ? handleKeyDown : onKeyDown}
        className={`${clickable ? 'focus-ring cursor-pointer' : ''} rounded-2xl ${PADDING[padding]} shadow-card ${motionClass} dark:bg-bg-secondary/95 dark:shadow-card-dark ${surfaceClass('card', { interactive, error })} ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  },
);

Card.displayName = 'Card';

/** Card that accepts framer-motion props (initial/animate/whileHover…). */
export const MotionCard = motion.create(Card);
