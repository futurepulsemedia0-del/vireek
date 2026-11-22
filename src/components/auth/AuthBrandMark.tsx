import { VireekMark } from '@/components/brand/VireekMark';
import { useMediaQuery } from '@/hooks/useMediaQuery';

export type AuthMarkMotion = 'animated' | 'still';
type Placement = 'form' | 'panel';

/** Matches Tailwind `lg`: the side panel is `hidden lg:block` in AuthShell. */
const DESKTOP = '(min-width: 1024px)';

/**
 * Brand mark for the auth screens. 'form' = above the form (mobile/tablet), 'panel' = top of the
 * desktop side panel. Only the matching placement is mounted, so there is never more than one
 * mark (and one animation loop) per view. Hidden on very short viewports so nothing clips.
 */
export function AuthBrandMark({ placement, motion = 'still' }: { placement: Placement; motion?: AuthMarkMotion }) {
  const isDesktop = useMediaQuery(DESKTOP);
  if ((placement === 'panel') !== isDesktop) return null;
  const animated = motion === 'animated';

  if (placement === 'form') {
    return (
      <div className={`flex justify-center [@media(max-height:560px)]:hidden ${animated ? 'mb-8' : 'mb-6'}`}>
        <VireekMark
          size={animated ? 220 : 120}
          className={animated ? 'h-auto w-[clamp(150px,52vw,230px)]' : 'h-auto w-[clamp(96px,28vw,128px)]'}
          animated={animated}
          intro="once"
          decorative
        />
      </div>
    );
  }
  return (
    <div className="mb-8 [@media(max-height:560px)]:hidden">
      <VireekMark
        size={240}
        className="h-auto w-[clamp(72px,calc(100vh_-_640px),240px)]"
        animated={animated}
        intro="once"
        interactive={animated}
        decorative
      />
    </div>
  );
}
