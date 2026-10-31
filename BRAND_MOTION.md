# Vireek Pulse — Brand Motion

**Story:** Vireek answers every call. Loading is the moment *before* "Sarah" picks up: the mark wakes as a voice waveform; the orange centre bar is the "call answered" accent.

## Language
| Token | Value | Use |
|---|---|---|
| Easing | `cubic-bezier(0.16, 1, 0.3, 1)` (`--vrk-ease`, same as `EASE` in `src/lib/motion.ts`) | everything |
| `--vrk-d1` | 120ms | press / micro feedback |
| `--vrk-d2` | 240ms | fades, cross-fades, bar fill |
| `--vrk-loop` | 1200ms | waveform loop (0.83 Hz, far below the 3 Hz flash limit) |

Signature **answer pulse**: indigo bars wave in a 90ms stagger; the orange centre bar + ripple ring mark the answer.

## Timing rules (single source: `delayedVisibility.ts`)
1. Under **150ms**: show nothing.
2. Once shown: stay at least **400ms**.
3. A new load during a pending hide cancels the hide.
4. Route fallback stages: bar 150ms → mark 700ms (slow chunk only) → microcopy 1.5s (app/portal only, rotates every 2.4s).
5. One loader per wait. Never stack a spinner inside a skeleton or overlay.

## Do
- Animate only `transform` and `opacity`.
- Use brand tokens (`--accent-primary`, `--accent-secondary`); never hard-code colours in components.
- Pair the decorative mark with real status text (`role="status"`, `aria-live="polite"`).
- Show real progress values only; use indeterminate when unknown.

## Don't
- No fake percentages, no looping text faster than ~2s, no flashing above 3 Hz.
- No second spinner system; use `PulseMark` / `Skeleton`.
- No orange as a CTA; it stays the "live / answered" signal.

## Reduced motion
`prefers-reduced-motion: reduce` → bars static, ripple hidden, bar becomes a slow opacity pulse (≤0.6 Hz).

## i18n / RTL
Microcopy keys: `loading.route`, `loading.pickingUp`, `loading.connecting` (namespace `common`, all 9 locales). The top bar mirrors under `[dir="rtl"]`.

## Components (`src/components/loading/`)
| Need | Use |
|---|---|
| Suspense fallback | `<RouteFallback variant="marketing\|app\|portal" />` |
| Inline / button | `<Spinner size={14} />`, `<Button loading loadingLabel="Saving">` |
| Section data | `<LoadingBoundary isLoading error isEmpty onRetry skeleton={…}>` |
| Skeleton shapes | `CardSkeleton KpiSkeleton ChartSkeleton ListRowSkeleton TableSkeleton FormSkeleton TranscriptSkeleton` (fixed heights = zero layout shift) |
| Progress | `<Progress value={real%} label="…" />` (omit `value` = indeterminate) |
| Blocking / background | `<BlockingOverlay open label progress />`, `<BackgroundTask open label />` |
| Async state | `const { isLoading, error, run } = useLoading()` |
| Mobile | `<PullToRefresh onRefresh={…}>` |
| Never two loaders | Overlay wraps its content in `LoadingScope`; nested Button/Boundary stay quiet |

Known limit: a Suspense fallback is unmounted by React the moment the chunk arrives, so the 400ms minimum cannot apply to `RouteFallback`; it applies to Boundary, Button, Overlay and PullToRefresh.
