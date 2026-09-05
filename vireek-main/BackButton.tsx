import { MouseEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { motion } from 'framer-motion';

export interface BackButtonProps {
  variant?: 'pill' | 'text';
  label?: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

const baseStyles =
  'group inline-flex shrink-0 items-center justify-center rounded-full text-text-secondary outline-none transition-colors duration-200 ease-out focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40';

const variantStyles: Record<NonNullable<BackButtonProps['variant']>, string> = {
  pill: 'h-10 w-10 border border-border bg-white shadow-sm hover:border-accent/30 hover:bg-accent-light disabled:hover:border-border disabled:hover:bg-white',
  text: 'gap-2 bg-transparent text-sm font-medium hover:text-accent disabled:hover:text-text-secondary',
};

const iconStyles =
  'transition-transform duration-200 ease-out group-hover:-translate-x-[3px] group-hover:text-accent group-disabled:group-hover:translate-x-0 group-disabled:group-hover:text-text-secondary';

export function BackButton({
  variant = 'pill',
  label = 'Back',
  href,
  onClick,
  disabled = false,
  className = '',
  'aria-label': ariaLabel,
}: BackButtonProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (disabled) {
      event.preventDefault();
      return;
    }

    if (onClick) {
      onClick();
      return;
    }

    if (href) {
      window.location.assign(href);
      return;
    }

    window.history.back();
  };

  return (
    <motion.button
      type="button"
      aria-label={ariaLabel ?? 'Go back'}
      disabled={disabled}
      onClick={handleClick}
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      whileTap={disabled ? undefined : { scale: 0.96, transition: { duration: 0.1 } }}
      className={`${baseStyles} ${variantStyles[variant]} ${className}`}
    >
      <ArrowLeft aria-hidden="true" className={iconStyles} size={variant === 'pill' ? 20 : 18} strokeWidth={2} />
      {variant === 'text' ? <span className="transition-colors duration-200 ease-out">{label}</span> : null}
    </motion.button>
  );
}
