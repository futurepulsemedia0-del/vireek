# Dashboard design principles

Reference quality: Linear, Stripe Dashboard, Attio, Mercury (quality bar only; no copied assets or layouts).
Brand: "Signal" palette — warm graphite neutrals, one cobalt accent, copper (`cta`) only for live/urgent.

Measure first: `node scripts/design/ai-tells.mjs` (table) · `--json` · `--check` (CI ratchet) · `--update` (lowers baseline).

## Rules

| Area | Do | Don't |
|---|---|---|
| Surfaces | `<Panel>`: 1px `border-border`, no shadow | Shadow on static surfaces; shadow only on popovers, menus, modals |
| Radius | Controls 6px, inputs 6–8px, containers 8–12px (`rounded-lg`), modals 12–16px | `rounded-2xl/3xl` on anything but modals; large radii on small elements |
| Icons | 16px, 1.5 stroke, only in nav, status and actions | Icon in a tinted square on every row; Sparkles/Bot/Brain as ornament |
| AI marker | Small neutral label where it states provenance: "Drafted by Sarah" | Sparkles next to every AI-touched thing |
| Effects | None on the dashboard | Gradients, glow, blur, glassmorphism outside true overlays |
| Type | 13–14px base, 12px meta, weights 400/500/600, `tabular-nums`, mono for IDs/phones | Blanket `font-bold`; proportional digits in columns |
| Lists | Rows with hairline dividers, sticky header, hover actions | Grids of 10+ equal cards |
| Status | `<StatusDot>` (dot + text) | Pill badges everywhere; colour as only signal |
| KPIs | `<Stat>`: label, value, tiny delta, sparkline, definition on hover; no icon | Hero-number cards with an icon each |
| Charts | Axes, gridlines, direct labels, exact-value tooltips, table fallback | Smooth gradient-filled curves without axes |
| Motion | 120–180ms, functional; skeleton only if load >300ms and shaped like the real layout | Entrance animation on tables, pulse as decoration |
| Copy | "3 emergency calls waiting"; sentence case; owner vocabulary (jobs, techs, calls, estimates) | "Unlock AI insights", "Supercharge…", emoji, exclamation marks |
| Empty state | One sentence, one action, left-aligned, small | Centered big icon + paragraph |

## Review checklist (paste into the PR template)

- [ ] Squint test: the one most important thing is still visible when the page is blurred.
- [ ] 5-second test: a new owner can say what needs attention now.
- [ ] Remove-one-element test: delete any element; if nothing is lost, it stays deleted.
- [ ] `node scripts/design/ai-tells.mjs --check` passes; migrated files are listed in `ai-tells.baseline.json` → `migrated`.
- [ ] Light + dark, RTL, 3 widths (390 / 768 / 1280), `prefers-reduced-motion`.
- [ ] axe clean; keyboard path complete; no capability removed without a replacement path.

## Suggested 3-owner usability check (30 min each)

1. Task: "Find the emergency call that hasn't been called back and start the callback." Success = under 20 s, no hints.
2. Task: "Which quotes expire this week and what would you do about them?"
3. Ask them to point at anything they would never use; record, don't defend.
Compare against the old Overview on the same tasks (swap order between owners).
