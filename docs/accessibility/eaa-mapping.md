# European Accessibility Act (EAA) mapping

**Status:** engineering evidence map, **not** a compliance statement and not legal advice. Nothing here may be published as a conformance claim. TODO(counsel)
**Basis:** repository files only (the uploaded zip). No test, build or assistive-technology session was run for this document. Evidence paths were checked to exist; where a path is marked **[MISSING IN ZIP]** it is referenced elsewhere but absent here.
**Related:** `docs/accessibility/acr-draft.md` (WCAG A/AA row-by-row evidence), `src/components/sections/AccessibilityStatementContent.tsx` (`/accessibility-statement`), `src/pages/AccessibilityConformancePage.tsx` (`/accessibility/conformance`).

## 1. Legal anchors (verify before relying on them) [VERIFY]

| Item | What was found (sources consulted 2026-11-25) |
|---|---|
| Instrument | Directive (EU) 2019/882. Services in scope are those provided **to consumers** after 28 June 2025: electronic communications, access to audiovisual media, consumer banking, e-commerce, e-books, certain transport services (Art. 2(2)). |
| Service requirements | Annex I Section III (all in-scope services: service information, websites/apps, support services) and Section IV (service-specific). Section V = answering 112. |
| Microenterprise exemption | Art. 4(5): microenterprises providing services are exempt from the service requirements. Definition thresholds (staff / turnover / balance sheet) and national detail: TODO(counsel). |
| Technical standard | EN 301 549 **V3.2.1** (2021, WCAG 2.1 AA) is the version harmonised for presumption of conformity. **V4.1.1** (published 2 Sep 2026) moves web content to **WCAG 2.2 AA**. One source expects its harmonisation reference around 16 Dec 2026: [VERIFY] in the Official Journal. Where national law names the standard without a version, a new version may become the benchmark without new legislation. |
| National law | Member-state transposition (penalties, authority, statement format) differs. TODO(counsel): list the member states where Vireek or its customers' consumers are. |

## 2. Is Vireek in scope? (decision for counsel and owner)

Vireek sells to home-service **businesses**. The EAA covers services provided to **consumers**, so the first question is which Vireek surfaces consumers use and whether Vireek or its customer is the "service provider" for them. Candidates found in `src/App.tsx`:

| Consumer-facing surface | Route / location | Possible EAA category | Open question |
|---|---|---|---|
| Online booking | `/book/:slug` | e-commerce (service contract concluded online)? | Is the provider Vireek or the tenant? TODO(counsel) |
| Customer portal | `/portal/:token` (+ `/history`, `/inventory`) | e-commerce / service information? | same |
| Public payment pages | `/pay/:token`, `/pay-share/:token`, `/pay-result` | e-commerce / payment? | same; card payment itself is Stripe-hosted [VERIFY] |
| Document signing | `/sign/:token` | e-commerce? | same |
| AI phone receptionist (callers are consumers) | voice platform, `supabase/functions/` | electronic communications services? total conversation / real-time text? | Likely a counsel question: is the AI answering service an "electronic communications service" under the EECC definition? TODO(counsel) |
| Marketing site, help center, status page | `/`, `/help`, `/status` | none by itself (B2B), but Section III covers support services of in-scope services | TODO(counsel) |
| Notification emails / SMS, PDFs (invoices, estimates, e-sign documents) | `supabase/functions/` | content of in-scope services | not assessed; see gaps G7, G8 |
| Mobile shells | `android/`, `ios/`, `capacitor.config.ts` | mobile device-based services | not assessed (G9) |

Size of Vireek against the microenterprise exemption: TODO(owner) supply headcount and annual turnover / balance sheet; do not assume.

**Decision needed:** TODO(counsel) scope memo: in scope / out of scope / tenant responsibility, per surface. The rest of this document assumes "possibly in scope" and maps effort anyway, because the same work supports enterprise procurement (VPAT/EN 301 549 requests).

## 3. Requirement mapping

Annex I wording is summarised, not quoted. Status vocabulary matches the ACR draft: **Evidence** (a test or code exists whose purpose covers it) / **Partial** / **None found**. "Evidence" is not "conforms"; no test was executed for this document.

### 3a. Section III: services (all in-scope services)

| # | Requirement (summary) | Existing work (paths) | Status | Gap |
|---|---|---|---|---|
| III-a | Information about the service's use and accessibility features is provided in accessible modes | `src/pages/AccessibilityPage.tsx`, `src/components/sections/AccessibilityStatementContent.tsx`, `src/pages/AccessibilityConformancePage.tsx` | Partial | G1, G2 |
| III-b | Websites are perceivable, operable, understandable, robust | axe: `e2e/accessibility.spec.ts`, `e2e/blog.a11y.spec.ts`, `e2e/a11y-contrast.spec.ts`; see ACR rows | Partial | G3, G4 |
| III-c | Mobile-app-based services are accessible | `capacitor.config.ts`, `android/`, `ios/` (shells) | None found | G9 |
| III-d | Electronic identification, security and payment methods are accessible | passkeys / one-time-code fields referenced in ACR 3.3.8 (`src/pages/LoginPage.tsx`, `src/components/auth/OtpEntry.tsx`); payment pages | Partial | G6 |
| III-e | Support services (help desk, relay, training) give accessibility info and compatibility with assistive tech, in accessible modes | `/help` (`HelpCenterPage`), `docs/support/` (internal process) | None found for accessibility-specific info | G5 |
| III-f | Information is provided by more than one sensory channel; text is readable; user interface is predictable | `src/contexts/AccessibilityContext.tsx`, `src/components/AccessibilityWidget.tsx` (text size, contrast, motion, reading preferences) | Partial | G3 |
| III-g | Electronic documents and e-commerce information are accessible (e.g. documents generated by the service) | none found for PDFs / emails | None found | G7, G8 |

### 3b. Functional performance (Annex I Section VI-style criteria, summarised)

| Need | Existing work | Status |
|---|---|---|
| Usage without vision / with limited vision / colour perception | axe contrast `e2e/a11y-contrast.spec.ts`; `scripts/audit-text-contrast.mjs`; screen-reader announcer `src/lib/a11y/announcer.tsx` (+ test) | Partial |
| Usage without hearing / limited hearing | no media inventory (ACR 1.2.x Not Evaluated); voice features not assessed for text alternatives | None found (G10) |
| Usage without vocal capability | not assessed for the voice platform | None found (G10) |
| Limited manipulation or strength | target size `e2e/a11y/touch-targets.spec.ts`, `scripts/a11y/audit-targets.mjs`; keyboard widget move `src/components/overview/OverviewGrid.tsx` | Partial |
| Limited reach / photosensitive seizures | motion pause + reduced motion `e2e/reduced-motion.spec.ts`, `src/components/ui/MotionPauseButton.tsx`; flashes (2.3.1) not reviewed | Partial |
| Limited cognition | reading mode and presets in `AccessibilityContext.tsx`; error handling `e2e/forms.spec.ts`, `src/components/a11y/AccessibleField.tsx` | Partial |
| Privacy when using accessibility features | settings stored locally / synced: not reviewed for privacy | None found (G11) |

### 3c. Section IV (service-specific) and Section V

| Category | Applies if | Status |
|---|---|---|
| Electronic communications (incl. total conversation, real-time text, emergency) | counsel decides the AI receptionist is such a service | Not assessed (G10) |
| E-commerce | booking / pay / sign flows are provided by Vireek to consumers | Not assessed; form evidence only `e2e/forms.spec.ts` (G4) |
| Consumer banking, audiovisual, e-books, transport, 112 | not applicable on the facts found | n/a |

### 3d. Technical standard mapping (EN 301 549)

| Clause | Content | Vireek evidence |
|---|---|---|
| 9 (web) | WCAG 2.1 AA now; WCAG 2.2 AA in V4.1.1 | `docs/accessibility/acr-draft.md` targets WCAG 2.2 A/AA; its tally is 1 Supports / 24 Partial / 30 Not Evaluated of 55. **The published conformance page says WCAG 2.1** (G2). |
| 10 (non-web documents) | accessible PDFs / documents | none found (G7) |
| 11 (software, incl. mobile apps) | | none found (G9) |
| 5/6/7/8/12 (generic, two-way voice, video, hardware, support documentation) | | not assessed; clause 6 matters if the voice product is in scope (G10) |

## 4. Gap list

Severity = effort and exposure estimate, not a legal rating. Owner column left for assignment: TODO(owner).

| ID | Gap | Why it matters | Proposed next step | Size |
|---|---|---|---|---|
| G1 | Public statement over-claims versus evidence (full keyboard operability, "every page" claims, NVDA/VoiceOver testing before release, CI on every change). See section 5 | A false accessibility claim is a legal and trust risk | Apply the section 5 edit now | S |
| G2 | Two public pages disagree: statement says WCAG 2.2 AA (aim); conformance page says partially conformant with WCAG 2.1 and lists 1.4.13 as open while tests exist (`src/components/ui/Tooltip.test.tsx`) | Inconsistent claims | Pick one standard and date; reconcile after `wcag-gaps` is run. TODO(counsel) | S |
| G3 | 30 of 55 ACR criteria Not Evaluated; many "Partial" rest on 4 sampled public pages and mocked dashboard data | Cannot support a conformance claim | Run `e2e/a11y/wcag-gaps.spec.ts`, triage, then extend to dashboard and consumer flows | L |
| G4 | No assessment of the consumer flows (`/book`, `/portal`, `/pay`, `/sign`) | These are the most plausible EAA surfaces | Add them to axe + keyboard + zoom/reflow specs; manual screen-reader pass | M |
| G5 | No accessibility information in the support/help channel (how to get help in an accessible way, supported assistive tech) | Section III support-services requirement | TODO(owner) support contact and hours; TODO(counsel) wording; add to help center and statement | S |
| G6 | Authentication and payment accessibility reviewed only by code references (3.3.8 NOT RUN) | Section III identification/payment methods | Run the 3.3.8 test; manual check of OTP, passkey, Stripe-hosted pages [VERIFY] | M |
| G7 | Generated PDFs (invoices, estimates, e-sign) not assessed for tagging/reading order | EN 301 549 clause 10 | Inventory generators in `supabase/functions/`; test with an accessibility checker; decide on tagged output | M |
| G8 | Transactional emails/SMS templates not assessed (structure, link text, plain-text alternative, contrast) | Content of in-scope services | Review templates once; add to checklist | S |
| G9 | Native shells (`android/`, `ios/`) and Chrome extension not assessed | Mobile services clause | Decide scope; TalkBack/VoiceOver pass; Capacitor orientation lock check (ACR 1.3.4) | M |
| G10 | Voice receptionist: no assessment of alternatives for deaf/hard-of-hearing/speech-impaired callers (text channel, relay, total conversation) | Possible electronic-communications scope | TODO(counsel) scope first; then product decision | L |
| G11 | Accessibility settings sync (Supabase) not reviewed for privacy | "Privacy" functional criterion; GDPR | Include in the privacy review. TODO(counsel) | S |
| G12 | No manual assistive-technology testing evidenced anywhere in the repo | Automated tools find only part of the issues | Record sessions (tool, browser, tester, date, findings) in `docs/accessibility/at-test-log.md`; start with login, dashboard overview, booking, payment | M |
| G13 | Statement lacks: date of last review, feedback mechanism with response commitment, escalation / enforcement procedure, scope, known limitations list in plain language | Typical national statement requirements [VERIFY per member state] | Fill the skeleton in section 6; TODO(owner) / TODO(counsel) | S |
| G14 | CI references `npm run a11y:acr` and `npm run test:scripts:acr` but this zip has **no such scripts and no `scripts/a11y/acr-evidence.mjs`** | The CI step would fail on this tree, or the zip is outdated vs the live repo | [VERIFY] in the live repo; if missing, add or remove the step | S |
| G15 | WCAG 2.2 / EN 301 549 V4.1.1 transition not planned | Benchmark may change without new legislation | Plan: finish WCAG 2.2 AA evidence (already the ACR target), then map EN 301 549 clauses 5-12 | M |
| G16 | `e2e/sensitive-access.a11y.spec.ts` is skipped without owner credentials; dashboard specs use mocked empty-state data | Authenticated areas under-tested | Provide test credentials in CI secrets; add realistic fixtures | M |

## 5. Accessibility statement: verified-facts-only changes

Each public sentence below was checked against the zip. Removed or reworded sentences are listed with the reason; the edit itself is in the delivery notes (`AccessibilityStatementContent.tsx`).

| Current sentence | Finding | Action |
|---|---|---|
| "Full keyboard operability across the dashboard, including modals, menus, and data tables." | ACR draft rates 2.1.1 Partial; no site-wide keyboard test | Reword to what is tested: dialog focus handling (`src/lib/a11y/focusTrap.test.tsx`) and keyboard move/resize of dashboard widgets (`src/components/overview/OverviewGrid.test.tsx`) |
| "Visible, high-contrast focus indicators on every interactive element." | A shared `.focus-ring` style and an optional strong-focus mode exist (`src/styles/a11y.css`, `AccessibilityContext.tsx`); "every element" unverified, and the conformance page itself lists third-party iframes | Reword: shared focus style + optional stronger mode |
| "Semantic landmarks, headings, and a skip to main content link on every page." | `SkipLinks` is rendered by `AccessibilityProvider` (mounted in `src/main.tsx`), target `#main-content` appears in 12 files; per-page presence untested; landmarks/headings only axe-sampled | Reword: skip link at the start of pages |
| "Screen-reader announcements for async actions (saves, errors, loading states)." | `AriaLiveRegion` is rendered in `src/App.tsx`; unit test exists; no screen-reader verification | Keep, soften: "status messages are announced to screen readers through a live region" (code fact) |
| "A built-in accessibility toolbar (text size, contrast, motion, and reading preferences)" | `AccessibilityContext.tsx` defines text size, contrast, reduce motion, reading mode, dyslexia font, line height | Keep |
| "Color contrast checked against WCAG AA thresholds ... across our design tokens." | `scripts/audit-text-contrast.mjs` exists but is **not** wired into CI workflows; axe contrast spec covers sampled routes | Reword to automated contrast checks on sampled pages and a contrast audit script |
| "We test new features with keyboard navigation and screen readers (NVDA and VoiceOver) before release" | **No evidence in the repo** of any such testing (the strings occur only in the two public pages and the ACR draft) | Remove |
| "we run automated WCAG checks in our CI pipeline on every change" | `ci.yml` runs Playwright (axe specs) on pull requests and main; sampled pages only; some specs skip without credentials | Reword: axe-core checks on sampled pages for pull requests |

Not changed (needs owner / counsel, not a fact check): the contact address `ali@vireek.com` (the ACR draft asks to confirm the official accessibility contact), the WCAG 2.1 vs 2.2 wording on the conformance page (G2), and any EAA claim. **Do not add "compliant with the EAA".**

## 6. Statement skeleton for the next revision (fill in; publish only after counsel review)

```
Scope:            TODO(counsel) surfaces covered (see section 2)
Standard aimed at: WCAG 2.2 Level AA / EN 301 549 V3.2.1 now, V4.1.1 planned.  TODO(counsel)
Conformance:      TODO(owner) state only what an executed evaluation supports. [VERIFY]
Evaluation:       TODO(owner) who, when, method (self-assessment / third party), tools, assistive technology
Known limitations: TODO(owner) plain-language list from the evaluation (start from ACR "Not Evaluated" and "Partial" rows)
Feedback:         TODO(owner) address, phone if any, response time you can actually meet
Alternative help: TODO(owner) how a person who cannot use a feature gets the service another way
Enforcement:      TODO(counsel) competent authority and procedure per member state
Last reviewed:    TODO(owner) date; next review date
```

## 7. Fill-in checklist (what only you can supply)

- [ ] TODO(owner) Headcount, annual turnover / balance sheet (microenterprise test)
- [ ] TODO(owner) Which consumer-facing surfaces Vireek itself provides (vs. tenants)
- [ ] TODO(owner) Official accessibility contact and response time
- [ ] TODO(owner) Who will run manual AT sessions and when
- [ ] TODO(counsel) Scope memo (section 2), national transposition list, statement wording, enforcement information
- [ ] [VERIFY] Whether `a11y:acr` scripts exist in the live repo (G14)
- [ ] [VERIFY] EN 301 549 V4.1.1 harmonisation status in the Official Journal
