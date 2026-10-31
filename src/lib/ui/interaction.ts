// src/lib/ui/interaction.ts
//
// THE interaction-state matrix. Every interactive element in Vireek gets its
// look for default / hover / focus-visible / active / selected / disabled /
// loading / error from here — never from a hand-copied class string.
//
// Rules baked into these recipes:
//  - Tokens only (bg-accent, border-border, text-text-primary, ...). No raw colors.
//  - hover:* is safe to use freely: tailwind.config.js sets
//    future.hoverOnlyWhenSupported, so it only applies on (hover: hover) devices.
//    Touch devices get the active:* press feedback instead.
//  - Selected/loading are driven by data attributes (data-selected="true",
//    data-loading="true"); disabled by :disabled and aria-disabled.
//  - focus-visible comes from the shared `.focus-ring` class (index.css).

export const INTERACTION_STATES = [
  'default',
  'hover',
  'focus-visible',
  'active',
  'selected',
  'disabled',
  'loading',
  'error',
] as const;
export type InteractionState = (typeof INTERACTION_STATES)[number];

export type SurfaceKind =
  | 'solid'
  | 'danger'
  | 'outline'
  | 'ghost'
  | 'link'
  | 'field'
  | 'row'
  | 'menuItem'
  | 'tab'
  | 'card';

export interface SurfaceRecipe {
  rest: string;
  hover: string;
  active: string;
  selected: string;
  error: string;
}

/** Shared motion tokens (durations/easing live in tailwind.config.js). */
export const motionClass =
  'transition-[color,background-color,border-color,box-shadow,opacity,transform,filter] duration-fast ease-out-expo motion-reduce:transition-none';

/** Touch press feedback + no double-tap-zoom delay. */
export const pressable =
  'touch-manipulation select-none active:scale-[0.97] motion-reduce:active:scale-100';

/** Disabled looks identical for native `disabled` and `aria-disabled`. */
export const disabledLook =
  'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

export const SURFACES: Record<SurfaceKind, SurfaceRecipe> = {
  solid: {
    rest: 'bg-accent text-white shadow-sm dark:text-bg-primary',
    hover: 'hover:brightness-110 hover:shadow-glow-accent',
    active: 'active:brightness-90 active:shadow-none',
    selected: 'data-[selected=true]:brightness-90',
    error: '',
  },
  danger: {
    rest: 'bg-danger text-bg-primary shadow-sm',
    hover: 'hover:brightness-110',
    active: 'active:brightness-90 active:shadow-none',
    selected: 'data-[selected=true]:brightness-90',
    error: '',
  },
  outline: {
    rest: 'border border-border bg-bg-secondary text-text-primary',
    hover: 'hover:border-accent/40 hover:bg-bg-tertiary',
    active: 'active:bg-bg-tertiary active:brightness-95',
    selected:
      'data-[selected=true]:border-accent data-[selected=true]:bg-accent/10 data-[selected=true]:text-accent',
    error: 'border-danger',
  },
  ghost: {
    rest: 'text-text-secondary',
    hover: 'hover:bg-bg-tertiary hover:text-text-primary',
    active: 'active:bg-bg-tertiary active:brightness-95',
    selected: 'data-[selected=true]:bg-accent/10 data-[selected=true]:text-accent',
    error: 'text-danger',
  },
  link: {
    rest: 'text-accent underline-offset-4',
    hover: 'hover:underline',
    active: 'active:brightness-90',
    selected: 'data-[selected=true]:font-semibold data-[selected=true]:underline',
    error: 'text-danger',
  },
  field: {
    rest: 'border border-border bg-bg-primary text-text-primary',
    hover: 'hover:border-accent/40',
    active: '',
    selected: '',
    error: 'border-danger hover:border-danger',
  },
  row: {
    rest: '',
    hover: 'hover:bg-bg-tertiary',
    active: 'active:bg-bg-tertiary',
    selected: 'data-[selected=true]:bg-accent/10',
    error: 'bg-danger/5',
  },
  menuItem: {
    rest: 'text-text-primary',
    hover: 'hover:bg-bg-tertiary',
    active: 'active:bg-bg-tertiary',
    selected: 'data-[selected=true]:bg-accent/10 data-[selected=true]:text-accent',
    error: 'text-danger',
  },
  tab: {
    rest: 'border-b-2 border-transparent text-text-secondary',
    hover: 'hover:text-text-primary',
    active: 'active:text-text-primary',
    selected: 'data-[selected=true]:border-accent data-[selected=true]:text-text-primary',
    error: 'text-danger',
  },
  card: {
    rest: 'border border-border/80 bg-bg-secondary',
    hover: 'hover:-translate-y-0.5 hover:border-accent/25 hover:shadow-card-hover dark:hover:shadow-card-hover-dark',
    active: 'active:translate-y-0 active:shadow-card',
    selected: 'data-[selected=true]:border-accent data-[selected=true]:bg-accent/5',
    error: 'border-danger',
  },
};

export interface SurfaceOptions {
  /** Adds the hover + active recipes (false for static, non-interactive surfaces). */
  interactive?: boolean;
  error?: boolean;
}

/** Compose the full recipe for one surface kind. */
export function surfaceClass(kind: SurfaceKind, { interactive = true, error = false }: SurfaceOptions = {}): string {
  const s = SURFACES[kind];
  return [
    s.rest,
    interactive ? s.hover : '',
    interactive ? s.active : '',
    s.selected,
    error ? s.error : '',
  ]
    .filter(Boolean)
    .join(' ');
}
