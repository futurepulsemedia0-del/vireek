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
---

# Sarah — Voice Orb

**Story:** Sarah is the only character in Vireek. One mark, one component, seven states. The orb is the Pulse waveform inside a disc: indigo bars, orange centre bar = "answered". It replaces the sparkle avatar everywhere Sarah speaks.

**Component:** `src/components/sarah/SarahOrb.tsx` (logic in `sarahOrb.logic.ts`, styles in `sarah-orb.css`). SVG + CSS only: no Lottie, no images, no new dependency. Reuses `--accent-primary`, `--accent-secondary`, `--danger`, `--vrk-ease` and the `html[data-vrk-paused]` background-tab pause from the Pulse system.

```tsx
<SarahOrb state="speaking" size={40} amplitudeRef={levelRef} />   // real audio, no re-render per frame
<SarahOrb state="thinking" size={16} decorative />                // inline / next to text that already says it
```

## States
| State | Silhouette (static pose) | Motion | When |
|---|---|---|---|
| `idle` | low dome | slow breathe, 0.25 Hz | ready, waiting |
| `listening` | open "ear" (tall outside, low centre) | ring ripple 0.5 Hz; bars follow mic/call audio if supplied | caller or owner is talking |
| `thinking` | ascending steps | staggered bar wave 0.83 Hz, dotted ring turns | tool call / lookup / booking |
| `speaking` | tall dome | bars follow real amplitude; synthetic ≤1.25 Hz if none | Sarah is talking |
| `handoff` | descending steps | opacity sweep 0.7 Hz, dashed ring turns | transferring to a human |
| `emergency` | flat wall, danger colour, thick ring | ring pulse 1 Hz | emergency flagged and call live |
| `offline` | flat line + diagonal slash, 50% opacity | none | number or service not live |

Every silhouette is different on purpose: state is readable with no colour and no motion (colour-blind users, reduced motion, greyscale print). A unit test enforces it.

## Sizes (16–256 px, one viewBox)
- ≤ 24 px: **3 bars, no ring** (compact). 25–256 px: 5 bars + ring.
- Do not use below 16 px; the component clamps.

## Audio
- Pass `amplitudeRef` (a ref an event handler writes 0–1 into) for real audio. Vapi: `vapi.on('volume-level', v => (ref.current = v))`. Per Vapi's SDK this is the **assistant's output level**, so use it for `speaking`. `listening` has no amplitude unless you feed a mic meter; without a source it uses the ambient motion.
- Smoothing: fast attack (60 ms), slow release (220 ms), noise gate at 0.02, gentle lift (`x^0.6`). The rAF loop runs only while the orb is `listening|speaking`, has a source, motion is allowed and the tab is visible. One CSS variable (`--a`) is written per frame; React never re-renders for audio.

## Reduced motion
`prefers-reduced-motion: reduce` → no animation and no rAF loop; the static pose (silhouette above) is the state. Nothing is hidden or removed.

## Accessibility
- Default: `role="img"`, name "Sarah, listening". Use `decorative` when adjacent text already says it (chat avatar, call card rows) so screen readers don't hear it twice.
- The orb never announces changes. Status text lives in the surrounding `role="status"` region (see First Call and Today).

## Where it is used
Chat widget + site assistant + live demo avatar (`ChatAvatar`, `TypingIndicator`), first-call screen, Today empty state. Planned: loading screens (`RouteFallback` microcopy), live-call cards, notification rows.

## Don't
- Don't recolour per page, don't add states, don't use orange for anything else, don't animate size or position (transform scale on bars only).
- Don't show `emergency` for anything that is not a live flagged emergency.
- Don't fake amplitude with a timer while claiming "listening to you".

## Budget
Target < 3 KB min+gzip. Source-level estimate: ≈ 2.6–3.0 KB (comments/types stripped, separate gzips, no tree-shaking credit). Re-measure with `npm run build` + `npm run check:bundle` before release.
