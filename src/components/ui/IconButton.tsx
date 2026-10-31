// src/components/ui/IconButton.tsx
import { forwardRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/Button';

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'aria-label' | 'tooltip' | 'iconOnly'> {
  /** Required: it is the accessible name AND the tooltip. */
  label: string;
  icon: LucideIcon;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, icon: Icon, size = 'md', variant = 'ghost', ...props }, ref) => (
    <Button ref={ref} iconOnly aria-label={label} tooltip={label} size={size} variant={variant} {...props}>
      <Icon size={size === 'xs' || size === 'sm' ? 16 : 20} aria-hidden="true" />
    </Button>
  ),
);
IconButton.displayName = 'IconButton';
