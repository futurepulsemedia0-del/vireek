// src/components/ui/Icon.tsx
//
// The icon wrapper. Enforces the scale (micro 12 / sm 16 / md 20 / lg 24), the constant stroke, and the a11y contract:
//   - decorative (default): aria-hidden, not focusable
//   - meaningful: pass `label` -> role="img" + aria-label (already-translated string)
// Existing JSX that uses a lucide icon directly keeps working via the `icon-*` classes (see src/index.css); this
// component is the typed path for new code and for any icon that carries meaning on its own.
import { forwardRef } from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import { ICON_SIZE_PX, iconClass, type IconSize } from '@/lib/ui/iconScale';

export interface IconProps extends Omit<LucideProps, 'size' | 'strokeWidth' | 'absoluteStrokeWidth' | 'aria-hidden' | 'aria-label' | 'role'> {
  icon: LucideIcon;
  size?: IconSize;
  /** Makes the icon meaningful (it is then the accessible name of whatever contains it). Pass a translated string. */
  label?: string;
}

export const Icon = forwardRef<SVGSVGElement, IconProps>(({ icon: Glyph, size = 'sm', label, className = '', ...rest }, ref) => {
  const a11y = label ? ({ role: 'img', 'aria-label': label } as const) : ({ 'aria-hidden': true, focusable: false } as const);
  return <Glyph ref={ref} size={ICON_SIZE_PX[size]} className={`${iconClass(size)} ${className}`.trim()} {...a11y} {...rest} />;
});
Icon.displayName = 'Icon';
