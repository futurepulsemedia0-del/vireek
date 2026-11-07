// src/components/ui/IconButton.tsx
//
// THE icon-only button. Extends <Button> (no parallel system) and adds the touch-target contract:
//   - `label` is REQUIRED (typed): it is the accessible name AND the tooltip. No name -> does not compile.
//   - the visual size stays on the Button scale (xs 32 / sm 40 / md 44 / lg 48); below 44px the hit area is expanded to
//     44x44 with the `hit-area` pseudo-element (src/index.css) WITHOUT changing the visual box, focus ring, or layout.
//   - density="dense" is the one documented exception for dense desktop tables: 32px, no expansion, never below 24.
//     Keep >= 8px between dense targets (docs/design/ICON_SCALE.md).
import { forwardRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { IconSize } from '@/lib/ui/iconScale';

export type IconButtonDensity = 'comfortable' | 'dense';

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'aria-label' | 'aria-labelledby' | 'tooltip' | 'iconOnly'> {
  /** Required: it is the accessible name AND the tooltip. Pass an already-translated, non-empty string. */
  label: string;
  icon: LucideIcon;
  /** Overrides the icon token. Default: sm for xs/sm buttons, md for md/lg buttons. */
  iconSize?: IconSize;
  /** "dense" = 32px visual, no hit-area expansion. Only for dense desktop tables/toolbars. */
  density?: IconButtonDensity;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, icon, size = 'md', iconSize, density = 'comfortable', variant = 'ghost', className = '', ...props }, ref) => {
    if (import.meta.env?.DEV && !label.trim()) console.error('IconButton: `label` must be a non-empty accessible name.');
    const dense = density === 'dense';
    const visual = dense ? 'xs' : size;
    const smallerThanComfortable = visual === 'xs' || visual === 'sm';
    const hit = smallerThanComfortable && !dense ? 'hit-area' : '';
    const glyph: IconSize = iconSize ?? (smallerThanComfortable ? 'sm' : 'md');
    return (
      <Button ref={ref} iconOnly aria-label={label} tooltip={label} size={visual} variant={variant} data-density={density} className={`${hit} ${className}`.trim()} {...props}>
        <Icon icon={icon} size={glyph} />
      </Button>
    );
  },
);
IconButton.displayName = 'IconButton';
