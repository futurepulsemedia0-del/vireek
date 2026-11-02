# Vireek brand governance

Living document. If a rule here and the code disagree, fix one of them in the same PR.
Related: `docs/voice-and-tone.md`, `BRAND_MOTION.md`, `docs/INTERACTION_STATES.md`, `/brand` (public brand page), `/trademark-policy`.

## 1. Ownership

Assign a named person (and a backup) to every role below. Until a name is filled in, the **Brand owner** is accountable.

| Area | Role | Owner | Approves changes to |
|---|---|---|---|
| Visual identity, logo, naming, trademark use | Brand owner | _assign_ | `src/components/brand/`, `public/` brand assets, `config.mjs → NAMING` |
| Tokens, components, motion | Design-system owner | _assign_ | `src/index.css` tokens, `tailwind.config.js`, `src/components/ui/`, `BRAND_MOTION.md`, `config.mjs → TOKEN_EXEMPT` |
| Accessibility | Accessibility owner | _assign_ | axe rules, `/accessibility-statement`, `/accessibility/conformance` |
| Copy, voice, translations | Content/i18n owner | _assign_ | `docs/voice-and-tone.md`, `src/locales/**`, native-speaker reviews |
| Claims, certifications, testimonials | Trust owner (legal sign-off) | _assign_ | `docs/claims-register.json`, `/trust`, `/security`, case studies |
| Audit tooling and CI gates | Engineering owner | _assign_ | `scripts/brand-audit/**`, `.github/workflows/brand-audit.yml` |

Changing a **floor, weight, exemption, or baseline** (`config.mjs`, `baselines/*.json`) needs approval from the owner of that area **and** the Engineering owner. Never loosen one to make a PR pass.

## 2. The audit

```bash
npm run lint:tokens               # fails if raw colors/sizes GROW (ratchet) — runs on every PR
npm run brand:audit:static        # static checks + gate, no browser (~15 s)
npm run brand:audit -- --base-url http://localhost:4173 --depth standard   # + crawl (needs a build + Chromium)
npm run brand:audit:selftest      # proves the crawler against a fixture with known defects
```

Output: `reports/brand-audit.html` (scores, regressions vs the previous run, prioritized fix list, screenshots) and `reports/brand-audit.json`.

**Scoring rules (do not weaken):**
- A category is **NOT RUN** (not 0, not 100) when nothing measured it. NOT RUN categories are excluded from the overall score and the report states the rubric coverage.
- A component that needs a tool that is missing (for example axe) is **BLOCKED/NOT RUN**, never a pass.
- Anything that needs real-world proof is listed under **Needs real-world evidence** and **never changes a score** (section 6).
- Static results are heuristics where marked ("heuristic"). They create a review queue, not a verdict.

**CI:** PRs run the static job. Nightly runs add crawl + Lighthouse + axe. A published release runs `depth=full` and *requires* a11y, performance, SEO, states and mobile to have been measured.
**Floors:** `scripts/brand-audit/baselines/scores.json` holds the recorded scores; the gate fails a category that drops more than 2 points below its baseline or regresses vs the previous run. Raise the baseline after a reviewed improvement with `node scripts/brand-audit/run.mjs --static-only --write-baseline-scores` (or from a crawl run).
**Authenticated crawl:** uses `E2E_TEST_EMAIL` / `E2E_TEST_PASSWORD` (and optional `BRAND_AUDIT_STAFF_EMAIL/PASSWORD`) of a **sandbox tenant**. The crawler only navigates, blocks non-GET requests (except auth and RPC reads) and keeps credentials in memory. It reports how many writes it blocked.

## 3. How to add things

### Colors
1. Never write a hex/`rgb()`/Tailwind palette class (`bg-slate-500`) in a component. Use semantic tokens: `bg-bg-primary|secondary|tertiary`, `text-text-primary|secondary`, `border-border`, `text-accent`, `text-success|danger|warning-500`. Copper (`cta`/`ai`) means "live / urgent", never a CTA.
2. Need a new color? Add a CSS variable (light **and** dark values, AA contrast checked) in `src/index.css`, expose it in `tailwind.config.js`, document it on `/brand`, then use the class. Get Design-system owner approval.
3. Data-visualization palettes go through tokens too. If a library needs literal values, read them from CSS variables at runtime.
4. Truly unavoidable raw values (tenant-chosen colors, brand artwork) use `// brand-audit-allow raw-hex: <reason>` on the line, or an entry in `TOKEN_EXEMPT` with a reason. A missing reason is ignored by the audit.
5. The PWA `theme_color`, `index.html` theme-color and native splash colors must equal the tokens (audit: *PWA/theme colors match the brand accent token*).

### Components
Use `@/components/ui` (`Button`, `Card`, `Input`), `EmptyState`, `Skeleton`, `ErrorBoundary`, `useToast`. Do not copy their class recipes (`npm run lint:design`). New shared component: put it in `src/components/ui/`, cover all states in `/dev/states`, add a test, add it to `/brand`.

### Sizes and type
Use the Tailwind scale. `min-h-11` is the 44 px touch target. Type sizes: `text-xs … text-4xl`, `text-eyebrow`. If a size is truly missing, add a named size to `tailwind.config.js` rather than `text-[11px]`. Only `lucide-react` icons. Motion: `EASE` from `@/lib/motion` and the durations in `BRAND_MOTION.md`; animate `transform`/`opacity` only; respect reduced motion.

### Logo and names
Use `<Logo>`; never a raw `<img>`. Write "Vireek" (not "VIREEK" or "vireek") in prose. Canonical domain: `vireek.com`. Approved sub-brands live in `config.mjs → NAMING.productNames` (Vireek Field, Vireek Home, …); anything else (for example "Vireek AI" as a product name, `vireek.ai` domains) needs Brand-owner approval first.

### Copy and translations
Follow `docs/voice-and-tone.md` (sentence case, no "Oops", every error has a next step, no raw codes). All user-facing strings go through `t()`; no hard-coded JSX copy in new code (`node scripts/i18n-audit.mjs <file>` must report 0). Every new key goes into **English and all shipped locales** in the same PR (`npm run i18n:keys` fails otherwise). Machine-drafted translations are marked in the PR and queued for native-speaker review (ar, fa, hi, ja, zh first). Use `@/lib/format` for numbers/dates (`npm run lint:locale`). Use logical utilities (`ms-/me-/ps-/pe-/start-/end-/text-start`) so Arabic and Persian mirror correctly.

### Icons and illustration
Add icons from `lucide-react`. Custom SVG only in `src/components/brand/` or with an `aria-hidden`/title and the brand colors via `currentColor`.

### Emails and documents
PDFs: build on `@/lib/pdfBrand` (`getPdfBrand()`), so logo, colors and white-label apply. Emails: send through `supabase/functions/email-send` so tenant brand and footer rules apply; do not call the mail provider directly unless the message is operational and the PR says why.

### Claims and evidence
Any certification, uptime/rating number, customer count, testimonial or superlative needs an entry in `docs/claims-register.json` **only when the proof exists**:
```json
{ "id": "cert:soc2", "claim": "SOC 2 Type II", "evidence": { "type": "report", "url": "https://…", "owner": "name", "issuedAt": "YYYY-MM-DD", "expiresAt": "YYYY-MM-DD" } }
```
Ids are the audit's pattern ids (`cert:soc2`, `cert:iso27001`, `cert:hipaa`, `cert:pci`, `cert:gdpr`, `cert:wcag`, `stat:uptime`, `stat:rating`, `stat:customers`). No proof, no entry: reword the claim or remove it. Absolutes ("never miss a call", "bank-grade", "#1") are copy problems, not evidence problems — qualify them with scope, date and source, or drop them.

## 4. PR review checklist

- [ ] No new raw colors/px/type sizes (`npm run lint:tokens` green); no palette classes
- [ ] Shared components used; no copied class recipes (`npm run lint:design`)
- [ ] All user-facing strings in `t()` with keys in EN + every shipped locale; `npm run i18n:keys`, `lint:voice`, `lint:locale` green
- [ ] Logical (RTL-safe) utilities; checked in Persian at 375 px if layout changed
- [ ] Loading, empty, error, success, disabled and offline states exist (section 5)
- [ ] axe: 0 critical/serious; keyboard path works; focus visible; targets ≥ 24 px (44 px preferred)
- [ ] Page sets title, description, canonical and one `<h1>` (`useSEO`); public pages are in `scripts/seo/routes.mjs`
- [ ] No new claim without register evidence; naming follows section 3
- [ ] Documents/emails go through the brand layers
- [ ] No secrets, no `.env` in the PR; security headers untouched or reviewed (`vercel.json` must stay valid JSON — `src/lib/vercelHeaders.test.ts`)
- [ ] `npm run brand:audit:static` shows no regression

## 5. Definition of done for any new screen

A screen is done only when all of these are true:
1. **States:** loading (Skeleton), empty (`EmptyState` with a next action), error (visible, says what happened and what to do), success (toast/inline per `INTERACTION_STATES.md`), disabled (with reason), offline (banner or graceful message).
2. **Accessibility:** one `<h1>`, landmarks, labelled controls, visible focus, keyboard-operable, AA contrast in light **and** dark, no color-only meaning, reduced-motion respected, axe clean at 375 and 1280 px.
3. **i18n:** zero hard-coded copy, keys in all shipped locales, `@/lib/format` for numbers/dates, RTL verified, long German/Persian strings do not break layout (`min-w-0`, `TruncatedText`).
4. **Tokens:** zero raw colors, zero arbitrary px/type sizes, shared components only.
5. **Tests:** unit test for logic, a test for each state, and an e2e or crawl-matrix entry in `KEY_ROUTES` if the route is key (`config.mjs`). Authorization and tenant isolation tests for anything reading tenant data.
6. **Performance:** route is lazy-loaded, within the bundle budget, no layout shift on load.
7. **SEO (public pages):** title, description, canonical, OG, in the sitemap list; private pages `noindex`/disallowed.
8. **Brand:** names, claims, imagery and motion follow this document; screenshots (light/dark, 375/768/1280) attached to the PR.

## 6. Needs real-world evidence (never faked)

These cannot be reached by code. The audit lists them separately and never counts them:
third-party certifications cited in copy (SOC 2, ISO 27001, HIPAA, PCI attestations); real customer references and permission for every testimonial/case study; real third-party reviews or ratings; measured uptime history; independent accessibility audit / VPAT and manual screen-reader testing; independent penetration test; real-device mobile testing and store review outcomes; real-user (field) performance data; Search Console data; native-speaker review of machine-drafted translations; trademark registration status; rendering tests in real email clients and live DKIM/SPF/DMARC deliverability.

## 7. Known open items needing an owner decision

Tracked in the latest `reports/brand-audit.html`. At the time this document was written they included: `theme_color` `#4F46E5` vs accent `#203AD8`; `og:image` declared 1200×630 but the file is 1424×752; the `command.vireek.ai` mock domain and "Vireek AI" naming; 21 of 23 PDF generators outside the shared PDF brand layer; 31 routes not classified in `scripts/seo/routes.mjs` (the repo's own `routes.test.mjs` fails on them); the orphan `AccountPage`; stray `.patch` files at the repository root.
