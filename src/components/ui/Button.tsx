import { ButtonHTMLAttributes, forwardRef } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const baseStyles =
  'focus-ring inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-all duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50';

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'px-4 py-2.5 text-sm min-h-[40px]',
  md: 'px-5 py-3 text-base min-h-[48px]',
  lg: 'px-7 py-4 text-base min-h-[52px]',
};

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-white shadow-sm hover:brightness-110 hover:shadow-glow-accent active:brightness-90 active:shadow-none',
  secondary:
    'border border-border bg-bg-secondary text-text-primary hover:border-accent/40 hover:bg-bg-tertiary active:brightness-95',
  ghost:
    'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary active:brightness-95',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className = '', children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={`${baseStyles} ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
