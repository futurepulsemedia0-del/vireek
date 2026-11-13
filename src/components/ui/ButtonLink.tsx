// Recreated: verify against original intent (recovered verbatim from homepage-redesign.patch)
import { AnchorHTMLAttributes, forwardRef } from 'react';
import { Link, LinkProps } from 'react-router-dom';
import { disabledLook, motionClass, pressable, surfaceClass, type SurfaceKind } from '@/lib/ui/interaction';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

// TODO(vireek): the original patch exported `buttonClassName` from ui/Button.tsx. That file has since been
// reworked and is not modified here, so the same class recipe is mirrored locally. If Button.tsx later exports
// a shared class builder, replace this block with that import.
const baseStyles = `focus-ring relative inline-flex items-center justify-center gap-2 rounded-xl font-semibold ${motionClass} ${pressable} ${disabledLook}`;
const sizeStyles: Record<Size, string> = {
  sm: 'px-4 py-2.5 text-sm min-h-[40px]',
  md: 'px-5 py-3 text-base min-h-[48px]',
  lg: 'px-7 py-4 text-base min-h-[52px]',
};
const surfaceFor: Record<Variant, SurfaceKind> = { primary: 'solid', secondary: 'outline', ghost: 'ghost' };

function buttonClassName({ variant = 'primary', size = 'md', className = '' }: { variant?: Variant; size?: Size; className?: string }): string {
  return `${baseStyles} ${sizeStyles[size]} ${surfaceClass(surfaceFor[variant])} ${className}`.trim();
}

interface CommonProps {
  variant?: Variant;
  size?: Size;
}

type RouterProps = CommonProps & Omit<LinkProps, 'className'> & { className?: string };
type AnchorProps = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className'> & { className?: string; href: string };

/**
 * Button styling on a real link. Using <Link><Button/></Link> nests a <button> inside an <a>,
 * which axe flags (nested-interactive) and which breaks keyboard/screen-reader semantics.
 */
export const ButtonLink = forwardRef<HTMLAnchorElement, RouterProps>(
  ({ variant, size, className, ...props }, ref) => (
    <Link ref={ref} className={buttonClassName({ variant, size, className })} {...props} />
  ),
);
ButtonLink.displayName = 'ButtonLink';

/** Same styling for external / tel: / in-page (#hash) anchors. */
export const ButtonAnchor = forwardRef<HTMLAnchorElement, AnchorProps>(
  ({ variant, size, className, ...props }, ref) => (
    <a ref={ref} className={buttonClassName({ variant, size, className })} {...props} />
  ),
);
ButtonAnchor.displayName = 'ButtonAnchor';
