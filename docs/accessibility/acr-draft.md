# Vireek Accessibility Conformance Report (ACR) — DRAFT

**Format:** VPAT® 2.5 (WCAG edition) · **Standard:** WCAG 2.2, Level A and AA · **Product:** Vireek web application (public site and dashboard) · **Status:** internal draft, not reviewed, not published

> **Do not publish or send to customers as-is.** [COUNSEL] Publication of any conformance claim, the product description, the contact details and the report date need legal and accessibility-lead review. [VERIFY] Every status below is derived from tests and code that exist in the repository. The tests were **not executed** while writing this draft (no installed dependencies, no app server, no browser in the authoring environment).

## 1. Scope and method

| Item | Value |
|---|---|
| Product name and version | Vireek, web application (`vireek-dashboard` 0.0.0 in `package.json`). [VERIFY] release version for the final report |
| Report date | [VERIFY] set on review |
| Contact | [VERIFY] the repo uses `ali@vireek.com` on the conformance page; confirm the official accessibility contact |
| Evaluation methods | Static review of the repository (tests, lint rules, source); no manual assistive-technology testing is evidenced here |
| Related documents | `src/pages/AccessibilityStatementPage.tsx`, `src/pages/AccessibilityConformancePage.tsx` (this page says WCAG 2.1 AA and lists AT combinations; reconcile with this report) |
| Not covered | Native mobile shells (`android/`, `capacitor.config.ts`), the Chrome extension, embedded third-party widgets, PDFs and generated documents |

### Evidence sources

| Short name | File | What it covers |
|---|---|---|
| axe public | `e2e/accessibility.spec.ts` | axe-core, tags wcag2a / wcag2aa / wcag22aa, on `/`, `/pricing`, `/login`, `/accessibility-statement` |
| axe blog | `e2e/blog.a11y.spec.ts` | axe A/AA on 3 blog URLs plus h1, TOC and JSON-LD checks |
| axe results plan | `e2e/results-plan.a11y.spec.ts` | axe on `/how-we-verify`, keyboard use of the pricing tab |
| axe sensitive access | `e2e/sensitive-access.a11y.spec.ts` | axe in light, dark, LTR and RTL plus keyboard reach; skipped without `E2E_OWNER_EMAIL` / `E2E_OWNER_PASSWORD` |
| axe voice resilience | `e2e/voice-resilience.a11y.spec.ts` | axe on 3 tabs in light and dark, arrow-key tabs, live-region result; the file header says it was not run when authored |
| contrast | `e2e/a11y-contrast.spec.ts` | axe `color-contrast`, 12 public and 13 dashboard routes, light and dark; dashboard uses mocked empty-state data |
| touch targets | `e2e/a11y/touch-targets.spec.ts` | 24 px minimum and name checks at 375 px on 25 dashboard routes, plus axe `target-size`, `button-name`, `link-name` |
| reduced motion | `e2e/reduced-motion.spec.ts` | OS and Accessibility Center motion settings, pause/play control |
| forms | `e2e/forms.spec.ts` | axe on one form, focus on first invalid field, dirty-tab guard |
| wcag gaps | `e2e/a11y/wcag-gaps.spec.ts` | heuristics for 1.4.10, 1.4.12, 2.4.1, 2.4.7, 2.4.11, 3.1.1, 3.3.8, 4.1.3; NOT RUN |
| unit tests | `src/**/*.test.tsx` cited per row | component behaviour (Vitest) |

Other Playwright specs also import `AxeBuilder` (for example `e2e/homepage.spec.ts`, `e2e/states.spec.ts`, `e2e/loading.spec.ts`). They were not read for this draft and are not cited. Reviewing them may upgrade rows.

## 2. Status rules used in this draft

| Status | Meaning here |
|---|---|
| Supports | At least one test or review whose stated purpose is this criterion, plus code evidence, and no known gap recorded in the repository. Never used without a linked test. |
| Partially Supports | Some evidence exists (a test on a sample of pages, or code without a test) but coverage is incomplete or a known issue exists. |
| Not Evaluated | No test, review or code evidence found. This is not a claim of non-conformance. |

Summary: **1** Supports · **24** Partially Supports · **30** Not Evaluated (of 55) · **27** criteria have no linked test. Regenerate the gap list with `node scripts/a11y/acr-evidence.mjs`.

## 3. Findings to fix before this report is relied on

1. **Status messages were silent (fixed in the working tree, not yet verified).** `AriaLiveRegion` (`src/lib/a11y/announcer.tsx`) was imported in `src/App.tsx` but never rendered, while toasts and buttons call `announce()` (4.1.3). It is now mounted once in `App()`. Verify with a screen reader and run `src/lib/a11y/announcer.test.tsx`.
2. **Dead skip-link import (fixed).** The unused `SkipToContent` import was removed from `src/App.tsx`; `SkipLinks` in `AccessibilityContext` is what ships (2.4.1). `SkipToContent.tsx` itself is now unreferenced: delete it or keep it deliberately.
3. **Published statement disagrees with the code.** The conformance page lists 1.4.13 as an open issue while `Tooltip` tests show hoverable and dismissible behaviour, and it states WCAG 2.1 while this report targets 2.2.
4. **New tests are unexecuted.** `e2e/a11y/wcag-gaps.spec.ts` covers 1.4.10, 1.4.12, 2.4.1, 2.4.7, 2.4.11, 3.1.1, 3.3.8 and 4.1.3 with heuristics. Run it, triage failures, and only then change statuses. Because `npm run test:e2e` runs every spec, a real failure will fail CI.

## 4. Table 1: Success criteria, Level A and AA

Columns: criterion, name, level, conformance level, automated tests, code evidence, remarks. Test paths are relative to the repository root.

| SC | Name | Level | Status | Automated tests | Code evidence | Remarks |
|---|---|---|---|---|---|---|
| 1.1.1 | Non-text Content | A | Partially Supports | `e2e/accessibility.spec.ts`<br>`e2e/blog.a11y.spec.ts`<br>`src/components/ui/Img.test.tsx` | `eslint.config.js`<br>`src/components/ui/Img.tsx` | axe detects missing alt text on 4 + 3 sampled pages; it cannot judge alt-text quality. Lint rule `jsx-a11y/alt-text` is configured for `Img`/`RevealImage`. |
| 1.2.1 | Audio-only and Video-only (Prerecorded) | A | Not Evaluated | — | — | No inventory of audio/video content has been made. [VERIFY] whether any product or marketing page ships prerecorded media. |
| 1.2.2 | Captions (Prerecorded) | A | Not Evaluated | — | — | See 1.2.1. |
| 1.2.3 | Audio Description or Media Alternative (Prerecorded) | A | Not Evaluated | — | — | See 1.2.1. |
| 1.2.4 | Captions (Live) | AA | Not Evaluated | — | — | See 1.2.1. Live voice-call features are not treated as web media here. [VERIFY] |
| 1.2.5 | Audio Description (Prerecorded) | AA | Not Evaluated | — | — | See 1.2.1. |
| 1.3.1 | Info and Relationships | A | Partially Supports | `e2e/accessibility.spec.ts`<br>`e2e/blog.a11y.spec.ts` | `src/components/a11y/AccessibleTable.tsx`<br>`src/components/a11y/AccessibleField.tsx` | axe structural rules plus the blog heading/TOC assertions cover sampled public pages only. Dashboard data tables and forms are not tested. |
| 1.3.2 | Meaningful Sequence | A | Not Evaluated | — | — | No test or review recorded. RTL/LTR reading order is only exercised by `e2e/sensitive-access.a11y.spec.ts` for axe, not for sequence. |
| 1.3.3 | Sensory Characteristics | A | Not Evaluated | — | — | Needs a content review of instructions; not automatable. |
| 1.3.4 | Orientation | AA | Not Evaluated | — | — | No test asserts that content works in both orientations. [VERIFY] native shell orientation lock in `capacitor.config.ts` and `android/`. |
| 1.3.5 | Identify Input Purpose | AA | Partially Supports | `e2e/accessibility.spec.ts` | `src/pages/LoginPage.tsx`<br>`src/components/auth/OtpEntry.tsx` | `autoComplete` is set on the login fields and the OTP field; 110 source files use `autoComplete`. Only the login page is axe-scanned (axe rule `autocomplete-valid`). Other forms are unverified. |
| 1.4.1 | Use of Color | A | Partially Supports | `e2e/accessibility.spec.ts` | — | Only axe `link-in-text-block` on 4 sampled pages. Status chips, charts and dashboard indicators are unverified. |
| 1.4.2 | Audio Control | A | Not Evaluated | — | — | See 1.2.1. |
| 1.4.3 | Contrast (Minimum) | AA | Partially Supports | `e2e/a11y-contrast.spec.ts`<br>`e2e/accessibility.spec.ts` | `scripts/audit-text-contrast.mjs` | axe `color-contrast` on 12 public + 13 dashboard routes in light and dark. The spec itself states that dashboard routes run against mocked empty-state data, so real rows/tables are not covered, and axe `incomplete` nodes (gradients, overlays) need manual review. |
| 1.4.4 | Resize Text | AA | Partially Supports | `e2e/accessibility.spec.ts` | `index.html` | Viewport meta does not disable zoom, and axe `meta-viewport` runs on 4 pages. No test resizes text to 200 percent. |
| 1.4.5 | Images of Text | AA | Not Evaluated | — | — | No review recorded. |
| 1.4.10 | Reflow | AA | Not Evaluated | `e2e/a11y/wcag-gaps.spec.ts` | — | `wcag-gaps.spec.ts` asserts no horizontal scroll at 320 px on 4 public routes. Test added in `e2e/a11y/wcag-gaps.spec.ts`, NOT RUN; the status stays until it passes in CI. Dashboard routes are not covered. |
| 1.4.11 | Non-text Contrast | AA | Not Evaluated | — | — | axe does not test this. No manual audit recorded. |
| 1.4.12 | Text Spacing | AA | Not Evaluated | `e2e/a11y/wcag-gaps.spec.ts` | — | `wcag-gaps.spec.ts` applies the WCAG text-spacing overrides and looks for clipped text on 4 public routes (heuristic). Test added in `e2e/a11y/wcag-gaps.spec.ts`, NOT RUN; the status stays until it passes in CI. |
| 1.4.13 | Content on Hover or Focus | AA | Partially Supports | `src/components/ui/Tooltip.test.tsx` | `src/components/ui/Tooltip.tsx` | Unit tests cover dismiss with Escape, hoverable bubble and keyboard-focus open for `Tooltip`. The published conformance page (`src/pages/AccessibilityConformancePage.tsx`) still lists this criterion as an in-progress known issue: reconcile the two. Other hover/focus popovers are not inventoried. |
| 2.1.1 | Keyboard | A | Partially Supports | `e2e/sensitive-access.a11y.spec.ts`<br>`e2e/voice-resilience.a11y.spec.ts`<br>`e2e/results-plan.a11y.spec.ts`<br>`src/components/overview/OverviewGrid.test.tsx` | — | Keyboard checks exist for access-history, voice-resilience tabs, the pricing tab and dashboard widget move/resize. `sensitive-access` is skipped without `E2E_OWNER_*` credentials. No site-wide keyboard sweep. |
| 2.1.2 | No Keyboard Trap | A | Partially Supports | `src/lib/a11y/focusTrap.test.tsx`<br>`src/components/ConfirmDialog.test.tsx`<br>`src/components/KeyboardShortcutsModal.test.tsx`<br>`src/components/jobs/JobHoldDialog.test.tsx` | `src/lib/a11y/focusTrap.ts` | `useFocusTrap` is unit-tested (focus moves in, Tab cycles inside, focus returns to the trigger) and Escape closes three dialogs. Not every dialog was checked to use the hook. |
| 2.1.4 | Character Key Shortcuts | A | Partially Supports | `src/components/KeyboardShortcutsModal.test.tsx` | `src/components/KeyboardShortcutsModal.tsx` | The shortcuts modal has a key-recording flow, which suggests remapping. [VERIFY] whether single-key shortcuts can be turned off or are only active on focus. |
| 2.2.1 | Timing Adjustable | A | Not Evaluated | — | — | Session and idle timeouts are not reviewed. Toast auto-dismiss pauses on hover (`src/contexts/ToastContext.test.tsx`), which is not a 2.2.1 test. |
| 2.2.2 | Pause, Stop, Hide | A | Supports | `e2e/reduced-motion.spec.ts`<br>`src/hooks/useMotionLoop.test.tsx` | `src/components/ui/MotionPauseButton.tsx`<br>`src/hooks/useMotionLoop.ts`<br>`src/styles/a11y.css` | `e2e/reduced-motion.spec.ts` has a block named for WCAG 2.2.2 (pause/play freezes and resumes the marquee, hidden tab freezes animation) and checks decorative animation on public and dashboard routes. No recorded gap. [VERIFY] by re-running the spec before publishing. |
| 2.3.1 | Three Flashes or Below Threshold | A | Not Evaluated | — | — | No review recorded. |
| 2.4.1 | Bypass Blocks | A | Partially Supports | `e2e/accessibility.spec.ts`<br>`e2e/a11y/wcag-gaps.spec.ts` | `src/components/a11y/SkipLinks.tsx`<br>`src/contexts/AccessibilityContext.tsx`<br>`src/components/nav/RouteEffects.tsx` | The mounted skip link is `SkipLinks` (rendered by `AccessibilityContext`); the unused `SkipToContent` import was removed from `src/App.tsx`. `wcag-gaps.spec.ts` (NOT RUN) asserts that the first Tab shows it and that activating it moves focus into `#main-content`. axe `bypass` covers 4 pages. |
| 2.4.2 | Page Titled | A | Partially Supports | `e2e/accessibility.spec.ts`<br>`e2e/blog.a11y.spec.ts` | `src/lib/seo.ts` | axe `document-title` on sampled pages. Titles are set through `useSEO` or ad-hoc effects; no route-wide check. |
| 2.4.3 | Focus Order | A | Partially Supports | `e2e/voice-resilience.a11y.spec.ts`<br>`e2e/sensitive-access.a11y.spec.ts`<br>`src/lib/a11y/focusTrap.test.tsx` | `src/components/nav/RouteEffects.tsx` | Roving tabindex and focus-after-navigation are implemented for some pages. axe cannot judge logical order and no site-wide test exists. |
| 2.4.4 | Link Purpose (In Context) | A | Partially Supports | `e2e/a11y/touch-targets.spec.ts`<br>`e2e/accessibility.spec.ts` | — | axe `link-name` runs on 25 dashboard routes at 375 px and on 4 public pages. Link purpose in context is not judged. |
| 2.4.5 | Multiple Ways | AA | Not Evaluated | — | — | No review recorded. |
| 2.4.6 | Headings and Labels | AA | Partially Supports | `e2e/accessibility.spec.ts`<br>`e2e/blog.a11y.spec.ts` | — | axe heading and label rules on sampled pages; descriptiveness is not judged. |
| 2.4.7 | Focus Visible | AA | Partially Supports | `e2e/a11y/wcag-gaps.spec.ts` | `src/index.css`<br>`src/styles/a11y.css` | A `.focus-ring` utility (with forced-colors handling) and an opt-in strong-focus mode exist. `wcag-gaps.spec.ts` checks that focus changes the computed appearance of the first 20 tab stops on 4 public routes (heuristic, NOT RUN). The conformance page lists third-party iframes as an open issue. |
| 2.4.11 | Focus Not Obscured (Minimum) | AA | Not Evaluated | `e2e/a11y/wcag-gaps.spec.ts` | — | `wcag-gaps.spec.ts` checks that the centre of each focused control (first 20 tab stops, 4 public routes) is not covered by unrelated content. Test added in `e2e/a11y/wcag-gaps.spec.ts`, NOT RUN; the status stays until it passes in CI. [VERIFY] sticky headers and the cookie banner. |
| 2.5.1 | Pointer Gestures | A | Not Evaluated | — | — | No review recorded. |
| 2.5.2 | Pointer Cancellation | A | Not Evaluated | — | — | No review recorded. |
| 2.5.3 | Label in Name | A | Not Evaluated | — | — | axe `label-content-name-mismatch` is experimental and is not enabled by the repo specs. |
| 2.5.4 | Motion Actuation | A | Not Evaluated | — | — | No review recorded. |
| 2.5.7 | Dragging Movements | AA | Partially Supports | `src/components/overview/OverviewGrid.test.tsx` | `src/components/overview/OverviewGrid.tsx` | Dashboard widgets can be moved and resized by keyboard (tested). Other drag interfaces, for example the Gantt scheduler, are not inventoried. |
| 2.5.8 | Target Size (Minimum) | AA | Partially Supports | `e2e/a11y/touch-targets.spec.ts`<br>`src/components/ui/IconButton.test.tsx` | `src/index.css`<br>`scripts/a11y/audit-targets.mjs` | Dedicated spec on 25 dashboard routes at 375 px with mocked data (fails under 24 px unless the spacing exception applies), plus axe `target-size`. Public pages are not covered, and the allowlist in `e2e/a11y/touch-target-allowlist.json` needs a review. |
| 3.1.1 | Language of Page | A | Partially Supports | `e2e/accessibility.spec.ts`<br>`e2e/a11y/wcag-gaps.spec.ts` | `index.html` | `index.html` sets `lang="en"` and axe `html-has-lang` passes on 4 pages. The UI offers fa/ar/es/fr/de. `wcag-gaps.spec.ts` (NOT RUN) validates the tag format only. [VERIFY] that `<html lang>` and `dir` update at runtime. |
| 3.1.2 | Language of Parts | AA | Not Evaluated | — | — | No review recorded. |
| 3.2.1 | On Focus | A | Not Evaluated | — | — | No review recorded. |
| 3.2.2 | On Input | A | Not Evaluated | — | — | No review recorded. |
| 3.2.3 | Consistent Navigation | AA | Not Evaluated | — | — | No review recorded. |
| 3.2.4 | Consistent Identification | AA | Not Evaluated | — | — | No review recorded. |
| 3.2.6 | Consistent Help | A | Not Evaluated | — | — | A live chat widget and support routes exist, but their placement consistency is not evaluated. |
| 3.3.1 | Error Identification | A | Partially Supports | `e2e/forms.spec.ts` | `src/components/a11y/AccessibleField.tsx` | `e2e/forms.spec.ts` checks that an empty submit focuses the first invalid field with `aria-invalid`. One form only. |
| 3.3.2 | Labels or Instructions | A | Partially Supports | `e2e/forms.spec.ts`<br>`e2e/accessibility.spec.ts` | `src/components/a11y/AccessibleField.tsx` | axe label rules on sampled pages and one form. Other forms are unverified. |
| 3.3.3 | Error Suggestion | AA | Not Evaluated | — | — | No review recorded. |
| 3.3.4 | Error Prevention (Legal, Financial, Data) | AA | Not Evaluated | — | — | `e2e/forms.spec.ts` tests a dirty-tab guard, which is data-loss prevention but not a review of legal/financial submissions. [VERIFY] |
| 3.3.7 | Redundant Entry | A | Not Evaluated | — | — | No review recorded. |
| 3.3.8 | Accessible Authentication (Minimum) | AA | Partially Supports | `e2e/a11y/wcag-gaps.spec.ts` | `src/pages/LoginPage.tsx`<br>`src/components/auth/OtpEntry.tsx` | Passkeys (`webauthn` autofill) and a `one-time-code` field exist in code. `wcag-gaps.spec.ts` (NOT RUN) asserts that the password field does not cancel paste. [VERIFY] that the OTP flow has no cognitive test. |
| 4.1.2 | Name, Role, Value | A | Partially Supports | `e2e/accessibility.spec.ts`<br>`e2e/a11y/touch-targets.spec.ts`<br>`e2e/voice-resilience.a11y.spec.ts`<br>`e2e/results-plan.a11y.spec.ts`<br>`src/components/ui/IconButton.test.tsx`<br>`src/components/ui/Button.states.test.tsx` | `scripts/a11y/audit-targets.mjs` | axe name/role rules, `button-name`/`link-name` on 25 dashboard routes, an icon-only-without-name check and a static AST ratchet. Custom widgets outside these routes are unverified. |
| 4.1.3 | Status Messages | AA | Partially Supports | `e2e/voice-resilience.a11y.spec.ts`<br>`src/lib/a11y/announcer.test.tsx`<br>`e2e/a11y/wcag-gaps.spec.ts`<br>`src/contexts/ToastContext.test.tsx`<br>`src/components/ui/Button.states.test.tsx` | `src/lib/a11y/announcer.tsx`<br>`src/contexts/UndoContext.tsx`<br>`src/App.tsx` | Toasts and buttons call `announce()`. `AriaLiveRegion` was imported in `src/App.tsx` but never rendered; it is now mounted once at the app root. Unit tests cover the region, and `wcag-gaps.spec.ts` (NOT RUN) checks it is mounted exactly once. Stays Partially until verified with NVDA or VoiceOver. `UndoContext` renders its own `role="status"` region. |

## 5. Table 2: Revised Section 508 and EN 301 549

Not produced in this draft. [COUNSEL] Mapping to Section 508 chapters 3 to 6 and EN 301 549 clauses 9, 10 and 11 needs a separate review and must not be inferred from the WCAG table.

## 6. Legal disclaimer

[COUNSEL] This draft is an engineering evidence map, not a certification and not a legal statement of conformance. VPAT® is a registered service mark of the Information Technology Industry Council (ITI).
