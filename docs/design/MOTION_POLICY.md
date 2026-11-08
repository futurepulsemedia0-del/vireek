# Motion policy

One decision, one signal. `src/lib/motionPolicy.ts` collapses **both** sources into `<html data-motion="full|reduce|stop">`:

1. the operating system (`prefers-reduced-motion: reduce`), and
2. the Accessibility Center (`html.a11y-reduce-motion` / `html.a11y-stop-animations`).

Either source triggers identical behaviour. `public/a11y-boot.js` sets the attribute before first paint; `installMotionRuntime()`
(called in `src/main.tsx`) keeps it live and sets `data-tab-hidden` while the tab is hidden. `src/styles/motion.css` is the **only**
place with reduced-motion CSS; `MotionConfig reducedMotion` (AccessibilityContext) covers framer-motion.

## Decision table (the rule)

| Kind | Class | `reduce` (OS or Reduce Motion) | `stop` (Stop Animations) |
|---|---|---|---|
| Indeterminate spinner / loader (animate-spin, .vrk-mini, .vrk-spin) | **essential** | Non-rotating opacity fade, 1.8s period (vk-essential-fade) | Static |
| Determinate progress bar / step indicator | **essential** | Width/position updates instantly (state stays visible) | Instant |
| Hover / focus / selected colour, opacity, border changes | **informative** | Kept, shortened to 120ms (opacity, colour, border only) | Instant |
| Toast / dialog / popover enter and exit | **informative** | Opacity only (framer-motion reducedMotion strips transforms) | Instant |
| Marquee, ticker, live activity stream, auto-scrolling banner | **informative** | No auto-motion; content stays reachable (scroll / drag / keys) | No auto-motion |
| Auto-advancing carousel, autoplaying media | **informative** | Does not auto-advance / autoplay; manual controls only | Does not auto-advance / autoplay |
| Skeleton shimmer / pulse | **decorative** | Static placeholder | Static placeholder |
| Ping / pulse status dot rings | **decorative** | Ring hidden, dot stays | Ring hidden, dot stays |
| Reveal-on-scroll, parallax, hero visuals, ambient glow | **decorative** | Final state shown immediately (opacity at most) | Final state immediately |
| hover/active scale, translate, lift | **decorative** | Transform removed; colour feedback remains | Removed |
| Smooth scrolling (CSS and scrollIntoView / scrollTo) | **decorative** | Instant (scrollBehavior() returns "auto") | Instant |

* **Essential** = removing it would hide state the user needs. It is never deleted: it becomes non-rotating, opacity-only, slower than 1 Hz
  (`vk-essential-fade`, `vrk-soft`). These are the only animations allowed to *run* under reduced motion (`ALLOWED_REDUCED_ANIMATIONS`).
* **Informative** = carries information; keep the information, drop the movement.
* **Decorative** = static.

## Rules for contributors

1. New loops: do nothing special for `animate-pulse|spin|ping|bounce`; the layer handles them. A *custom* keyframe that loops must be
   opacity-only for essential feedback and marked `data-motion-essential`, otherwise the layer ends it instantly.
2. Anything auto-moving for more than 5 seconds or auto-updating (marquee, ticker, auto-scroll, live stream) **must** use
   `useMotionLoop()` + `<MotionPauseButton>` (WCAG 2.2.2) and provide a static reduced alternative.
3. Never write `transition-all`. Use `transition-interactive` (colour, opacity, shadow, transform) or `transition-layout`
   (adds size/spacing) — or an explicit `transition-[...]` list.
4. Never write `behavior: 'smooth'`. Use `scrollBehavior()`.
5. framer-motion loops (`repeat: Infinity`) need `usePrefersReducedMotion()` (it is true for both sources).
6. Autoplaying media that the user explicitly started (camera preview, video call) is essential and exempt; decorative video must not autoplay when reduced.

## Guards

* `npm run lint:motion` — ratchet baseline (`scripts/motion/baseline.json`) + policy-integrity checks; CI fails on any new violation.
* `npm run test:motion` — codemod unit tests + Playwright (`e2e/reduced-motion.spec.ts`).
* `node scripts/codemod-motion.mjs [--write]` — migrates `transition-all` and `behavior: 'smooth'`.

## Known limits

Third-party widgets/iframes and framer-motion's JS-driven (non-WAAPI) tweens cannot be inspected through `document.getAnimations()`;
they rely on `MotionConfig`. `scripts/check-motion.mjs` cannot see animations created imperatively at runtime.
