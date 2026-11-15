# Component catalogue (Storybook)

Interactive catalogue of the `src/components/ui` primitives. It renders the real components with the real
Tailwind tokens, so it is the place to check a primitive in every state, in dark mode, and in RTL.

## Run

```bash
npm run storybook            # dev server on http://localhost:6006
npm run build-storybook      # static build into storybook-static/
npm run typecheck:storybook  # type-checks .storybook (stories + config)
```

## Toolbar

- **Theme**: Light / Dark. Toggles `class="dark"` on `<html>`, the same switch `ThemeContext` uses.
- **Direction**: LTR · English / RTL · فارسی. Calls `applyDocumentLanguage()` from `src/lib/languageSync.ts`
  (sets `lang`, `dir` and the `a11y-rtl` class) and swaps the demo copy to Persian.
- **Accessibility panel** (`@storybook/addon-a11y`): axe results per story. The addon runs in `test: 'todo'` mode,
  so violations are shown but do not fail anything. Switch to `'error'` in `.storybook/preview.tsx` once the list is clean.

## What is covered

Button, IconButton, Card, Checkbox, Input, Select, Switch, Tooltip, Stat, StatusDot. Each has a Playground-style
story plus one story per documented state (loading, disabled with reason, error, dense, and so on).

## Conventions

- Stories live in `.storybook/stories/ui/`, **not** next to the components. Several repo gates walk `src/`
  (`lint:colors`, `lint:locale`, `lint:design`, `lint:voice`, `a11y:targets`) and exempt only `*.test.*` files.
- Demo text lives in `.storybook/demoText.ts` (English + Persian). It is demo data, not product copy; product
  strings stay in `src/locales`.
- Layout helpers use inline styles (`.storybook/layout.tsx`) so the catalogue adds no Tailwind classes or colours.
- Adding a story: copy an existing file, keep `title: 'UI/<Name>'`, and use `demo(globals)` for any visible text.
- Storybook uses `vite.config.ts` (alias `@`, PostCSS/Tailwind). The `vireek-blog` plugin is removed in `.storybook/main.ts`.

## Not covered / open

- Stories are not part of `npm test` and no interaction or visual-regression tests exist yet.
- `ci.yml` is unchanged; `.github/workflows/storybook.yml` is a separate, optional check.
- Other primitives in `src/components/ui` (Panel, PageHeader, EmptyNote, Select-like fields, loaders) have no stories yet.
