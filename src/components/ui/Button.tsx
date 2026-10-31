import { ButtonHTMLAttributes, MouseEvent, forwardRef, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { announce } from '@/lib/a11y/announcer';
import { Tooltip } from '@/components/ui/Tooltip';
import { MiniLoader } from '@/components/ui/MiniLoader';
import { disabledLook, motionClass, pressable, surfaceClass, type SurfaceKind } from '@/lib/ui/interaction';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Keeps the width, shows the brand mini-loader, blocks re-entry, announces status. */
  loading?: boolean;
  loadingLabel?: string;
  /** When disabled, WHY. Button stays focusable (aria-disabled) and shows the reason in a tooltip. */
  disabledReason?: string;
  selected?: boolean;
  iconOnly?: boolean;
  tooltip?: string;
}

const baseStyles = `focus-ring relative inline-flex items-center justify-center gap-2 rounded-xl font-semibold ${motionClass} ${pressable} ${disabledLook}`;

const sizeStyles: Record<ButtonSize, string> = {
  xs: 'px-2.5 py-1.5 text-xs min-h-[32px]',
  sm: 'px-4 py-2.5 text-sm min-h-[40px]',
  md: 'px-5 py-3 text-base min-h-[48px]',
  lg: 'px-7 py-4 text-base min-h-[52px]',
};

const iconSizeStyles: Record<ButtonSize, string> = { xs: 'h-8 w-8', sm: 'h-10 w-10', md: 'h-11 w-11', lg: 'h-12 w-12' };

const surfaceFor: Record<ButtonVariant, SurfaceKind> = { primary: 'solid', secondary: 'outline', ghost: 'ghost', danger: 'danger' };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { variant = 'primary', size = 'md', className = '', children, loading = false, loadingLabel, disabledReason, selected, iconOnly = false, tooltip, disabled, onClick, ...props },
    ref,
  ) => {
    const { t } = useTranslation();
    const reasoned = !!disabled && !!disabledReason;
    const blocked = loading || reasoned;
    const nativeDisabled = !!disabled && !reasoned;

    const mounted = useRef(false);
    useEffect(() => {
      if (mounted.current && loading) announce(loadingLabel ?? t('ui.loading', { defaultValue: 'Loading…' }));
      mounted.current = true;
    }, [loading, loadingLabel, t]);

    const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
      if (blocked) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      onClick?.(e);
    };

    const button = (
      <button
        ref={ref}
        disabled={nativeDisabled}
        aria-disabled={blocked || undefined}
        aria-busy={loading || undefined}
        aria-pressed={selected}
        data-selected={selected || undefined}
        data-loading={loading || undefined}
        onClick={handleClick}
        className={`${baseStyles} ${iconOnly ? iconSizeStyles[size] : sizeStyles[size]} ${surfaceClass(surfaceFor[variant])} ${className}`}
        {...props}
      >
        {/* opacity-0 (not invisible/hidden) so the accessible name survives while loading */}
        <span className={`inline-flex items-center justify-center gap-2 ${loading ? 'opacity-0' : ''}`}>{children}</span>
        {loading && (
          <span className="absolute inset-0 flex items-center justify-center">
            <MiniLoader />
          </span>
        )}
      </button>
    );

    const hint = reasoned ? disabledReason : tooltip;
    return hint ? (
      <Tooltip content={hint} openOnTap={reasoned}>
        {button}
      </Tooltip>
    ) : (
      button
    );
  },
);

Button.displayName = 'Button';
