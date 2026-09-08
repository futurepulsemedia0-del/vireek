import { useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { motion } from 'framer-motion';

export interface BackButtonProps {
  label?: string;
  fallback?: string;
  className?: string;
}

/**
 * Sitewide "go back" control.
 *
 * Rests as a quiet circular icon — a chevron, not a full arrow, for a
 * lighter, more precise mark — and only expands to reveal its label on
 * hover/focus. The reveal is a pure CSS max-width transition (no layout
 * measurement needed), so it's cheap and has no first-render flash.
 * Idle state has no animation of its own — motion here only answers a
 * person's hover/focus, never plays on its own.
 */
export function BackButton({
  label = 'Back',
  fallback = '/',
  className = '',
}: BackButtonProps) {
  const navigate = useNavigate();

  const handleClick = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate(fallback);
    }
  };

  return (
    <motion.button
      type="button"
      onClick={handleClick}
      aria-label={label}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      whileTap={{ scale: 0.94, transition: { duration: 0.1 } }}
      className={`focus-ring group inline-flex h-10 items-center rounded-full border border-border bg-bg-secondary/80 pl-2.5 pr-2.5 text-sm font-medium text-text-secondary shadow-sm backdrop-blur transition-all duration-300 ease-out hover:border-accent/30 hover:bg-bg-secondary hover:pr-4 hover:text-accent ${className}`}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        <ChevronLeft
          aria-hidden="true"
          size={18}
          strokeWidth={2.25}
          className="transition-transform duration-300 ease-out group-hover:-translate-x-0.5"
        />
      </span>
      <span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-all duration-300 ease-out group-hover:ml-1.5 group-hover:max-w-[8rem] group-hover:opacity-100 group-focus-visible:ml-1.5 group-focus-visible:max-w-[8rem] group-focus-visible:opacity-100">
        {label}
      </span>
    </motion.button>
  );
}
