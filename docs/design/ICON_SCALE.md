# Icon scale & touch targets

| Token | CSS class | px | Use |
|---|---|---|---|
| micro | `icon-micro` | 12 | inline micro-icons only (badges, dense meta rows) |
| sm | `icon-sm` | 16 | default: buttons, inputs, list rows, nav |
| md | `icon-md` | 20 | emphasized actions, tab bars, 44px icon buttons |
| lg | `icon-lg` | 24 | headers, cards, mobile primary actions |
| display | (none) | >24 | illustrations / empty states; exempt from the scale |

Stroke is constant (`--icon-stroke: 2`) and enforced by the `icon-*` classes. There is no 3.5 half-step.
Use `<Icon icon={X} size="sm" label?>` (decorative = aria-hidden; meaningful = `label`) or the class directly on a lucide icon.

## Targets
- WCAG 2.2 SC 2.5.8: >= 24x24 CSS px (or the spacing exception). Mobile goal: >= 44x44.
- `<IconButton label icon />` is the primitive: `label` is required; below 44px visual size it adds `hit-area` (44px hit box, same visual box).
- Dense desktop tables: `density="dense"` = 32px visual, no expansion, >= 8px between targets, never below 24.
- Native `<button>/<a>` icon-only elements get `hit-area` (+`relative`) from `codemod-icons.mjs --targets`.

## Intentionally small targets
List in `e2e/a11y/touch-target-allowlist.json` with a reason. Currently: none.

## Guards
`npm run a11y:targets:check` (ratchet), ESLint `vireek-a11y/*`, Playwright `e2e/a11y/touch-targets.spec.ts`.
