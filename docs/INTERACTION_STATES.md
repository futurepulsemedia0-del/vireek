# Interaction states & feedback levels

Single source of truth: `src/lib/ui/interaction.ts` (state matrix) + `.focus-ring` in `src/index.css`.
Live catalog of every state: `/dev/states` (dev builds, or `VITE_ENABLE_DEV_STATES=true`).

## States
default · hover (hover-capable devices only) · focus-visible · active/pressed · selected (`data-selected`) ·
disabled (`disabled` or `aria-disabled`) · loading (`aria-busy`) · error (`aria-invalid`).

## Feedback levels — pick the lowest one that works
| Level | Use when | Component |
|---|---|---|
| 1. Inline check | The user is looking at the control that did the work (copy, toggle, inline save) | `CopyButton`, `Switch loading`, `Button loading` |
| 2. Toast | A background/finished result the user may no longer be looking at (saved, sent, failed) | `useToast()` |
| 3. Banner | A persistent page-level condition (payment failed, offline, plan limit) | page banner |
| 4. Full success state | A completed multi-step flow with a next action (job closed, onboarding done) | page/section |

Toast severity rules (see `toastReducer.ts`): success 4s · info 5s · warning 8s · error 10s (+50ms/char past 40, max +6s);
an error that has an action never auto-dismisses; max 3 visible, the rest queue (errors first);
identical toasts merge into one card with ×N; hover/focus/hidden-tab pauses the timer.

## Rules
- Disabled controls say why: `<Button disabled disabledReason="…">` (stays focusable) or inline text for Switch/Checkbox.
- Anything that sends money, data or messages uses `useAction` (in-flight lock + idempotency key) and `<Button loading>`.
- Announce results through `announce()` (toasts and CopyButton do it already) — never add a second `aria-live` region.
