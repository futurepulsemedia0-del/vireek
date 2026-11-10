# 01 — Brand-surface audit ("Vireek")

READ-ONLY audit. No source file was modified. Scope: the uploaded snapshot `vireek-main.zip` (6,636 files; no `.git`, no `CLAUDE.md`). The zip may be older than the live repo, so **re-run the method (Appendix A) on the real working tree before acting on any count or line number.** Line references are from the snapshot. Nothing here was checked against live DNS, Stripe, Twilio, app-store or OAuth consoles; those items are marked UNVERIFIED. No new name is proposed; no domain or trademark availability is claimed.

## 0. خلاصه (Persian)

نام «Vireek» حدود ۱۵٬۹۹۰ بار در ۲٬۰۳۷ فایل (۱۳٬۳۴۷ خط) دیده شد. حدود نیمی از موارد غیرارسالی است (patchهای ریشه، کامنت، تست). در ۶٬۸۳۱ خط «ارسالی»: A حدود ۳٬۴۰۱ (متن نمایشی)، B حدود ۳٬۱۴۶ (شناسه فنی، تغییرناپذیر)، C حدود ۲۴۴ (متن حقوقی)، D حدود ۴۰ (نام ثبت‌شده نزد شخص ثالث). تنها یک منبع مرکزی (`src/lib/brand/brandConfig.ts`) وجود دارد و فقط ۶ فایل آن را import می‌کنند؛ یعنی بیشتر متن‌ها هاردکد هستند. پیش از هر تغییر نام، مهم‌ترین مسئله‌ها: دامنه و URLهای چاپ‌شده (QR/NFC/پستکارت)، قرارداد API عمومی (`X-Vireek-*`, `vrk_`, `@vireek/*`)، توابع RLS در دیتابیس (`is_vireek_staff`)، شناسهٔ اپ‌های موبایل (`com.vireek.*`)، و متن حقوقی. چندین صفحهٔ رو به مشتریِ مستأجر هنوز بدون کنترل white-label عبارت Vireek را نشان می‌دهند (بخش ۵).

## 1. Executive summary

**Totals** (case-insensitive, text files only, excluding `node_modules`, `.git`, build output, lockfiles): 15,990 occurrences · 13,347 lines · 2,037 files · 41 file/folder names containing "vireek".

| Class | Lines | Meaning |
|---|---:|---|
| A | 3,401 | Human-visible display string (safe to centralize) |
| B | 3,146 | Technical identifier (DO NOT rename; includes 81 file names) |
| C | 244 | Legal / consent text (counsel) |
| D | 40 | Third-party-registered or sender name (≈34 real; ~6 false positives, see §3.D) |
| X | 6,516 | Non-shipping: 4,350 root patch/notes artifacts, 1,407 comments/docs, 759 tests/fixtures |

Shipping total (A+B+C+D) = 6,831 lines.

**Per area** (lines):

| Area | A | B | C | D | X |
|---|---:|---:|---:|---:|---:|
| Web app: UI pages/components | 1,188 | 388 | 171 | 3 | 145 |
| Web app: lib/hooks/other (`src/lib` etc.) | 691 | 259 | 4 | 0 | 677 |
| i18n locales | 83 | 27 | 45 | 0 | 1 |
| Edge functions: emails/notifications | 43 | 25 | 0 | 10 | 26 |
| Edge functions: voice/SMS/agents | 57 | 79 | 0 | 0 | 54 |
| Edge functions: PDF/documents | 7 | 4 | 0 | 0 | 13 |
| Edge functions: other (billing, sync, API, AI core…) | 390 | 1,217 | 22 | 12 | 416 |
| Marketing / public / SEO / knowledge | 323 | 242 | 0 | 5 | 13 |
| Database (migrations/seed) | 280 | 611 | 2 | 1 | 135 |
| Native apps + Chrome extension | 59 | 94 | 0 | 6 | 10 |
| SDK / CLI / worker / services | 44 | 40 | 0 | 0 | 86 |
| Tooling / CI / e2e | 215 | 88 | 0 | 3 | 70 |
| Docs | 5 | 5 | 0 | 0 | 509 |
| Root patch/notes artifacts | 0 | 4 | 0 | 0 | 4,350 |

D was tightened after the first pass (see §3.D for the curated list). Area totals are approximate to ±1–2%.

**Method limits (important).** Classification is a path+regex heuristic over every hit, not a human review of 13k lines. A random 14-line sample per class showed roughly: A ≈ 90% correct (misses: SQL advisory-lock key `'vireek:evidence-chain:'` is B), B ≈ 85% (a few display fallbacks and CSV file names are really A), C ≈ 90% (account-deletion copy in `HomePrivacyPage.tsx` is A), D needed manual curation (done in §3.D). Treat counts as planning numbers, not exact.

**Key structural facts**
- `src/lib/brand/brandConfig.ts` is a single source of truth (`BRAND.name`, domain, tagline, `brandMark()`, `PERSONA_LINE`) but only 6 files import it. `src/lib/brandFacts.ts` also exists. Most A strings are hard-coded.
- A white-label system exists (`portal_show_powered_by`, `effectiveShowVireek`, `src/lib/pdfBrand.ts`, `supabase/functions/_shared/branding/brand.ts`, `PortalBrandShell.tsx`). Only 16 files reference it, so coverage is partial (§5).
- Brand is also a *product-name family*: Ask Vireek, Vireek Pay, Vireek Home, Vireek Field, Vireek Tag, Vireek Insights, Vireek Verified/Trusted Service™, Vireek Talent Network, Vireek AI Core, Vireek Academy, etc. (~40 distinct "Vireek X" names found). A rename is a product-architecture decision, not only a find-and-replace.
- A `brand-audit.yml` workflow and `scripts/brand-audit/` already exist (design-token focused); a name-leak check could extend them later.
- The snapshot contains a `.env` (gitignored per `.gitignore`; values not read or printed here). Confirm it is not distributed.

## 2. Class B — technical identifiers (do NOT rename)

Grouped; occurrences are across shipping files.

| Family | Occ. / files | Examples (path:line) | Note |
|---|---|---|---|
| DB RLS helper `is_vireek_staff()` | 268 / 52 | `supabase/migrations/20271021000000_enterprise_trust_pack.sql:585` | Used in RLS policies; renaming is security-critical. Add alias only if ever needed. |
| DB columns `vireek_id`, `vireek_number`, `vireek_phone_key` | 427 / 36 | `supabase/functions/xero-sync-run/index.ts:832`, `voice-front-door/index.ts:169` | Integration link tables (QBO/Xero/NetSuite/Intacct). |
| DB tables/policies `ask_vireek_*` | 63 / 4 | migration `…_ask_vireek…` | Tables, RLS policies, RPC `ask_vireek_consume_rate_limit`. |
| DB session settings `vireek.*` | 205 / 30 | `set_config('vireek.rr_internal'…)` (21), `ico_internal`, `co_internal`, `protection_rpc`, `clearing_actor` | Trigger/RPC bypass flags. Note `vireek.co_internal` is not a domain. |
| Migration file names | 6 | `20271102000000_vireek_tag.sql`, `…_vireek_pay_core.sql`, `…_vireek_insights.sql`, `…_vireek_home.sql` | Never rename applied migrations. |
| Env vars `VIREEK_*` | 168 / 48 | `VIREEK_API_KEY` (33), `VIREEK_PDF_BRAND`, `VIREEK_WEBHOOK_SECRET`, `VIREEK_BASE_URL`, `VIREEK_API_URL`, `VIREEK_APP` (`capacitor.config.ts:21`) | Some are customer-side (CLI/SDK/quickstarts). |
| HTTP headers `X-Vireek-*` | 50 / 20 | `X-Vireek-Signature` (15), `-Token`, `-Timestamp`, `-Delivery-Id`, `-Api-Version`, `-Mode` | Webhook/API contract used by customers' verification code (`api-v1/contract.ts:926`). |
| API key prefix `vrk_live_/vrk_test_/vrk_agent_/vrk_app_` | 45+ | `supabase/functions/api-v1/quickstarts.ts:26` | Derived form, not literally "vireek"; still customer-visible. |
| npm scope / CLI / bundle IDs | 67 / 36 | `@vireek/sdk`, `@vireek/cli` (`packages/*/package.json:2`), bin `vireek` (`packages/cli/bin/vireek.js`), `com.vireek.field`, `com.vireek.home` | Published/store identity. Root package `vireek-dashboard` (`package.json`), `wrangler.jsonc:3 "name": "vireek"`. |
| Browser storage / cache / SW tags | 278 / 143 | `vireek-theme` (`index.html:6,37`), `vireek-visitor-id`, `vireek-experiment-assignments`, `vireek-consent-v3`, `vireek-shell-v1`, `vireek-sync` (`public/sw.js:64,124`), `vireek.app_lock` | Renaming resets consent, theme, experiments, offline cache. Cookie/storage names are also listed in consent text (class C). |
| Embed globals | — | `window.__vireekChatWidget`, `#vireek-chat-root` (`public/chat-widget.js:4,66`), `window.__vireekWW` (`website-widgets.js:8`), `meta[name="vireek-api"]` (`public/embed/analytics.js:8`) | Live on customer sites. |
| User-Agent strings | 8 | `Vireek-Webhooks/1` (`_shared/webhooks/outbound.ts:97`), `Vireek-SIEM/1.0`, `Vireek-Agent-Runtime/1.0`, `Vireek Emergency Network (support@vireek.com)`, `Vireek Dashboard (voice-brief…)`, robots tokens `VireekSarahBot`, `VireekAgentReadinessBot` | Customers/sites may allow-list these. |
| ICS identifiers | 7 / 6 | `PRODID:-//Vireek//Calendar Feed 1.0//EN` and `UID_DOMAIN = "feeds.vireek.com"` (`_shared/calendar-feed/engine.ts:35-36`), `CATEGORIES:Vireek` (`:173`), others in `src/lib/{maintenanceWindow:157,enterpriseDemoBooking:156,contentCalendar:694,events:254,homeInventory:508}.ts` | UIDs persist in subscribers' calendars. |
| Code identifiers | 918 / 151 | `askVireekAi` (130), `getLinkByVireek`, `VireekAccountType`, `VireekPaymentMethod`, `toVireek`, `VIREEK_FIELDS` | Internal; rename only via tooling and never in public contracts. |
| URL slugs / routes | — | `/ask-vireek`, `src/pages/AskVireekPage.tsx`, `functions/ask-vireek`, `/t/:token` (Tag), `/m/{code}` (postcards, `_shared/direct-mail/engine.ts:6,68`) | SEO and physical-media impact. |
| Domains & URLs | `vireek.com` 664 / 318 files; `app.vireek.com` 55 / 48 | `src/lib/resources.ts:11 SITE_ORIGIN`, `index.html:13,49,52,69-100` (canonical, OG, JSON-LD), `public/sitemap.xml` (115), `public/robots.txt`, `llms.txt`/`llms-full.txt` | Others: `in.vireek.com` (inbound email), `feeds.vireek.com`, `status.vireek.com`, `mail.vireek.com`, `api.vireek.com`, `www.`, `command.vireek.ai`, `vireek.app` (reserved custom-domain suffix: `src/lib/branding.ts:176`, `verify-custom-domain/index.ts:25`). |
| Storage buckets | 0 branded | `voice-briefs`, `card-receipts` | Good: no bucket carries the brand. (Other bucket creation paths not exhaustively verified.) |
| Staff email constants | 107+ | `ali@vireek.com` in `Footer.tsx:214`, legal content components, `public/.well-known/security.txt`, `knowledge/*` | Shown to humans *and* used as contact of record. Also `support@vireek.com` (14), `jobs@vireek.com`, `system@vireek…`. |
| File/folder names | 41 | `ios/VireekWidgets/`, `android/…/com/vireek/field/Vireek*.java`, `packages/cli/bin/vireek.js`, `vireek-a11y/`, `vireek-docs-phase1/`, `src/lib/vireekTag.ts`, `src/lib/askVireek.ts`, `bin` | |

## 3. Class A / C / D

### 3.A Display strings (safe to centralize) — grouped by area

| Area | Lines | Where (top files) | Note |
|---|---:|---|---|
| Web UI | ~1,188 | `src/pages/*`, `src/components/sections/*`, `Footer.tsx`, `LiveDemo.tsx`, `AskVireekPage.tsx` | Headlines, CTAs, empty states, "Built by Vireek" (`MarketplacePage.tsx:111`). |
| Web lib | ~675 | `src/lib/competitors.ts`, `integrations.ts`, `leakRepair.ts`, `brandFacts.ts` | Copy tables, FAQ, competitor comparisons. |
| i18n | 83 | `src/locales/{en,es,fa,…}/*.json`; chrome `_locales/{en,es}/messages.json` | `fa` has 19, `es` 15; 9 languages for consent. |
| Marketing/SEO | ~323 | `index.html` (title, description, OG, Twitter, JSON-LD `:10-100`), `public/site.webmanifest:3-5`, `public/offline.html:8,58`, `llms*.txt`, `sitemap.xml` | Generated: `knowledge/site-chunks.generated.json` (320), `eval/site-assistant.generated.json`, `_shared/ai-core/coreFacts.generated.ts`. Regenerate, do not hand-edit. |
| Edge: emails | 43 | `send-team-invite/index.ts:142`, `blog-newsletter/index.ts:67`, `_shared/email-kit/{layout:49,158; securityTemplates:43-44}`, `_shared/reports/email.ts:143` | Subjects, bodies, footers. |
| Edge: voice/SMS | 57 | `voice-brief/index.ts:260,302-303`, `voice-account/index.ts:73`, `auth-send-sms-hook/index.ts:55`, `weather-surge-check:205`, `outbound-queue-builder:71,108`, `escalate-emergency:276`, `first-call-start:165`, `franchise-royalty-issue:79`, `commitment-monitor-tick:115`, `_shared/voice-resilience/incidentCopy.ts:33` | SMS prefix "Vireek:"; owner-facing. Phone/IVR: `voice-front-door/index.ts:128` ("Vireek forwarding test successful"), `voice-resilience-admin:123`, `browser-extension/index.ts:258` (whisper "Vireek is connecting your call"). |
| Edge: PDFs/docs | 7 | `_shared/win-cards/render.ts:128`, `src/lib/pdf.ts`, `pdfBrand.ts:25-56` | See §5. |
| Native | 59 | `ios/App/App/Info.plist` (13; e.g. `:93` location text), `AndroidManifest.xml`, `res/xml/shortcuts.xml`, widgets, notification channels | OS permission strings are user-visible and store-reviewed. |
| DB seed/migration text | 280 | `…_vireek_tag.sql:265` inserts `'Service request (Vireek Tag)'` into tenants' customer rows; `…_lien_waivers.sql:956` comment-as-data | **Persisted data**: a code change will not fix already-written rows. |
| SDK/CLI | 44 | `packages/cli/src/help.ts` (21), `cli.ts` (23), `api-v1/contract.ts`, `public/openapi.json:4-35` ("Vireek API") | API docs and webhook docs. |
| AI prompts | — | `_shared/ai-core/index.ts:309` ("you are Vireek's AI Field Scientist"), `ai-core/knowledge.ts:85` | Model-facing text; changes behavior, needs eval re-run. |

### 3.C Legal text (needs counsel)

58 files, 244 lines:
`src/components/sections/DpaContent.tsx` (22), `TermsContent.tsx` (21), `TrademarkPolicyContent.tsx` (20; also states trademark usage rules), `PrivacyContent.tsx` (14), `AiDisclosureContent.tsx` (9), `SmsTermsContent.tsx` (8), `AcceptableUseContent.tsx` (7), `GdprDpaContent.tsx` (6), `VulnerabilityDisclosureContent.tsx` (6), `CookiePolicyContent.tsx` (3), `src/pages/SubprocessorsPage.tsx` (4), consent locale files `src/locales/consent/{ar,de,en,es,fa,fr,hi,ja,zh}.json` (5 each, plus storage-key names), `_shared/audit/consentText.ts:25` (marketing-email consent wording), `_shared/compliance-rules/{seedRules,fmSeedRules}.ts` (19), recording-notice language in `TermsContent.tsx:330`, `public/.well-known/security.txt`. Also `src/lib/regionalPacks/packPrivacy.ts`. `brandConfig.ts` records the mark as **unregistered (TM, not ®)**; `registered: false`.
Counsel questions: controller/processor identity in the DPA, existing consent records that name Vireek (versioned key `vireek-consent-v3`), SMS opt-in language that names "a business that uses Vireek", the Trademark Policy and approved-badge rules, subprocessor list, effective-date/notice obligations to existing customers.

### 3.D Third-party-registered / sender names (curated)

| Item | Path:line | Registered where (UNVERIFIED unless noted) |
|---|---|---|
| Email From defaults `"Vireek …<…@resend.dev>"` (Vireek, Vireek Billing, Vireek Sales, Vireek Status) in 17 places | `_shared/notify/deliver.ts:54`, `_shared/email-kit` callers, `stripe-webhook:138`, `contact-sales:67`, `send-team-invite:132`, `blog-newsletter:59`, `shadow-digest:23`, `value-scoreboard-run:126`, `talent-network:49`, `money-recovered-run:168`, `scheduled-reports-run:148`, `_shared/{executive-report/email:16,autoReply/runtime:198,lead-marketplace/runtime:91,email-campaigns/engine:45}`, `email-send:59` | Resend account + sending-domain SPF/DKIM/DMARC (actual domain not in repo). Real sender is whatever `RESEND_FROM_EMAIL` is set to in secrets. |
| Plaid Link `client_name: "Vireek"` | `_shared/bank/plaid.ts:69`, `bank-intelligence/index.ts:48` | Plaid dashboard application name shown to end users. |
| Stripe customer-visible descriptions `"Vireek instant payout"`, `"Vireek earned wage advance"`, `"Vireek Results …"` | `pay-transfer-request/index.ts:150`, `results-plan-bill/index.ts:102` | Stripe statement descriptor / product names / Connect branding are **not in the repo** → UNVERIFIED. |
| Microsoft Teams / Slack bot name `"Vireek"`, "run /invite @Vireek" | `_shared/chat-notify/delivery.ts:26,27,153,163` | Slack/Teams app registrations installed in tenant workspaces. |
| Mobile app identity | `capacitor.config.ts:4-5,26-27` (`com.vireek.field` "Vireek Field", `com.vireek.home` "Vireek Home"), `ios/App/App/Info.plist` (`CFBundleDisplayName`), `.github/workflows/play-rollout.yml:54`, `public/.well-known/apple-app-site-association:5` (placeholder TeamID), `assetlinks.json:6` | App Store Connect / Google Play listings; bundle/package IDs are permanent once published. |
| Chrome extension `short_name: "Vireek"` + `_locales` | `chrome-extension/manifest.json:4` | Chrome Web Store listing. |
| PWA / OS names | `index.html:24` (apple title), `public/site.webmanifest:3-4` | Installed home-screen names on users' devices. |
| Social profiles | `Footer.tsx:55-56` (Facebook page id, Instagram `vireek.ai`), `scripts/brand-audit/config.mjs:77` | Handles are third-party-registered. |
| OAuth / integration app consent screens | referenced in `src/lib/integrations.ts` (QuickBooks, Xero, NetSuite, Intacct, Gusto, Google/Microsoft calendar) | App names live in provider consoles → UNVERIFIED. |
| Twilio / telephony: caller-name/CNAM, friendly names, A2P brand registration | not in repo | UNVERIFIED. |
| Apple Wallet / push (APNs/FCM), VAPID subject | `public/sw.js:15,18,23` (title "Vireek", tag `vireek-notification`) | Push default title is display (A); VAPID contact UNVERIFIED. |

Script flagged 40 D lines; ~6 are contact-fact strings (`brandFacts.ts:188`, `ai-core/knowledge.ts:85`, `knowledge/site-chunks.generated.json:63`) or a false match (`VireekWidgets.java:59`), counted under D in the totals but really A/B.

## 4. Top 10 highest-risk places if the name changed

Cost: S = hours, M = days, L = weeks or multi-party.

| # | Place | Cost | Why |
|---|---|:-:|---|
| 1 | **Domains** `vireek.com`, `app.`, `in.`, `feeds.`, `status.`, `mail.`, `api.` (664+55 occurrences / ~320 files; canonical, OG, JSON-LD, sitemap 115 entries, robots, llms) | L | SEO equity, email auth (SPF/DKIM/DMARC), OAuth redirect URIs, webhooks, inbound email address `in.vireek.com`, TLS, 301s must live indefinitely. Domain strategy is a founder/legal decision. |
| 2 | **Public API contract**: `X-Vireek-*` headers, signature scheme, `vrk_` keys, `@vireek/sdk`, `@vireek/cli` + `vireek` binary, `VIREEK_*` env, `openapi.json` | L | Customer code verifies signatures and reads headers; breaking change for integrators. Needs dual-header period and versioned deprecation. |
| 3 | **Native app identity** `com.vireek.field` / `com.vireek.home`, AASA/assetlinks, Play rollout, widgets, notification channels | L | Bundle/package IDs cannot change for a published app without shipping a new app and losing installs/reviews. Only display names are cheaply changeable (S–M). |
| 4 | **DB identifiers** `is_vireek_staff()` (268 uses in RLS), `vireek_id` columns (427), `ask_vireek_*`, `vireek.*` GUCs (205) | L (and risky) | Tenant isolation depends on these. No user benefit in renaming; leave as-is. |
| 5 | **Legal text + stored consent** (58 files, 9 languages, DPA/ToS/Privacy/SMS/AI disclosure/Trademark Policy) | L | Counsel, customer notice, re-consent, contract party naming. |
| 6 | **Physical/printed media**: Vireek Tag QR/NFC `/t/:token`, postcard QR `/m/{code}` on the vireek.com origin | L | Already-printed stickers/mail cannot be recalled; old URLs must keep resolving and the page copy says "issued by Vireek" (`PublicTagPage.tsx:157,256`). |
| 7 | **Embeds on customer sites**: `public/chat-widget.js`, `website-widgets.js`, `dni.js`, `embed/analytics.js`, trust-badge "Powered by" links (`trustBadge/core.ts:118,236`) | M–L | Script URLs, globals and element ids are pasted into tenants' sites; badge text is localized in many languages. |
| 8 | **Third-party registrations**: Plaid `client_name`, Stripe descriptors/Connect branding, Teams/Slack apps, OAuth consent screens, Twilio/CNAM/A2P, app-store listings, social handles | L | Many require review/approval with lead time; consoles are outside the repo (UNVERIFIED). |
| 9 | **Email sending identity**: 17 `RESEND_FROM_EMAIL` defaults, `ali@`/`support@` contact addresses (125+), `security.txt`, deliverability warm-up | M | Reputation reset risk; inbound replies to old addresses must keep working. |
| 10 | **Calendar feeds & persisted keys**: ICS `UID_DOMAIN`/`PRODID`/`CATEGORIES` and `X-WR-CALNAME "(Vireek)"` (`calendar-feed/engine.ts:35-36,145,173,209,220-221`); browser keys `vireek-consent-v3`, `vireek-theme`, `vireek-visitor-id` | M | Changing UID domain duplicates events in subscribers' calendars; changing storage keys resets consent and experiments. Also persisted display text in DB rows (`'Service request (Vireek Tag)'`). |

Also notable: AI/voice persona text ("Hi, this is Sarah from Vireek", `voice-brief/index.ts:302-303`; `LiveDemo.tsx:29`), generated knowledge files used by the site assistant, and ~40 "Vireek X" product names.

## 5. Tenant-facing documents: confirm tenant branding is never overridden

Legend: GATED = code reads the white-label/"show Vireek" setting; NOT GATED = Vireek text is hard-coded in what a tenant's customer sees; UNVERIFIED = needs a per-file check.

| Surface | Path:line | Status |
|---|---|---|
| Tenant PDF header/footer ("Generated with Vireek") | `src/lib/pdfBrand.ts:25-56`; used by `pdf.ts:70,127`, `invoicePdf`, `leakReportPdf`, `repairReplaceProposalPdf`, `installCloseoutPdf`, `jobEvidenceChainPdf` | GATED (tenant name/colors/logo; attribution only if `effectiveShowVireek`). **Risk:** `loadPdfBrand` returns the Vireek default on error or no settings (`:85,95`), i.e. fails open to Vireek branding. |
| Other PDF builders | `quotePdf.ts`, `receiptPdf.ts`, `documentTemplatePdf.ts` (2 hits), `approvalToCashPdf.ts` (1), `inspectionReportPdf.ts`, `tagLabelSheet.ts` (4) | UNVERIFIED: they do not reference `pdfBrand` directly (may inherit via `pdf.ts`); confirm each. |
| Transactional email layout (customer-addressed) | `_shared/email-kit/layout.ts:49,130,158` (`brandName ?? "Vireek"`, footer "your Vireek account") | PARTIAL: tenant name param exists; default is Vireek; footer text hard-coded. |
| Tenant-branded send identity | `_shared/branding/brand.ts:43-73` ("Sent via Vireek", display-name guard "never leaves a Vireek display name on a white-labeled send") | GATED |
| Scheduled report emails | `_shared/reports/email.ts:143` "Sent by Vireek on behalf of {company}" | NOT GATED (intentional disclosure? founder to decide). |
| Invoice / split-invoice / lien-waiver / preview emails | `invoice-email`, `invoice-split-email`, `lien-waiver-email`, `email-preview-send` (1 hit each, `SITE_URL` fallback `https://vireek.com`) | UNVERIFIED (no brand-awareness found; check whether they go through email-kit with `brandName`). |
| Customer portal | `src/components/portal/PortalBrandShell.tsx:9-11,129-130`; `CustomerPortalPage.tsx` | GATED (no Vireek until server says badge required). |
| Public landing page for a tenant | `src/pages/PublicLandingPage.tsx:523` "Powered by Vireek" | NOT GATED. |
| Public Vireek Tag page | `PublicTagPage.tsx:2,157,256` ("Verified Vireek Tag · {business}") | NOT GATED (Tag is also a Vireek product). |
| Public equipment/home/technician passports | `PublicEquipmentPassportPage.tsx:67,84,90`, `PublicHomePassportPage.tsx:26,90` ("Verified by Vireek"), `PublicTechnicianPassportPage.tsx:27,94` | NOT GATED. |
| Service guarantee / verified service | `ServiceGuaranteePublicPage.tsx:31`, `VerifiedServicePage.tsx:123` ("Vireek Trusted Service™"), `service-guarantee-tick/index.ts:62` (customer SMS "is now Vireek Verified … Reply STOP") | NOT GATED. SMS goes to the tenant's customer. |
| Trust badge / win cards | `trustBadge/core.ts:118+` (localized "Answered by Vireek"), `core.ts:236` powered-by link; `_shared/win-cards/render.ts:33,128` | Win cards GATED (`whiteLabel` option); badge gated by `show_powered_by` in settings (`TrustBadgeSettingsPage.tsx:219`). |
| Calendar feeds subscribed by tenant staff | `_shared/calendar-feed/engine.ts:145,168,173,209,220-221` ("Vireek job", "(Vireek)") | NOT GATED. |
| Direct-mail postcards / QR landing | `_shared/direct-mail/engine.ts:6,68` (`{SITE_URL}/m/{code}`) | URL on Vireek origin is unavoidable unless custom domain applies: UNVERIFIED. |
| Caller-facing voice | `_shared/speed-to-lead/core.ts:546` ("this is Sarah, an AI assistant calling on behalf of {businessName}") | Good: business name, no Vireek. Staff-only lines (`voice-brief`) do say Vireek. |
| Embed widgets on tenant sites | `public/chat-widget.js:1`, `website-widgets.js:1`, `PublicLandingPage` | UNVERIFIED for visible text; globals/ids carry the name. |
| Reserved custom-domain suffixes | `src/lib/branding.ts:176`, `verify-custom-domain/index.ts:25` | Technical guard (B). |

Gaps to confirm before any change: the NOT GATED rows above plus the fail-open PDF default.

## 6. Open questions only the founder can answer

1. Is the goal a full rename, an endorsed/"by" brand, or only a new product-family name? Which of the ~40 "Vireek X" names survive?
2. Which domains are owned and which DNS/email-auth setup (SPF/DKIM/DMARC) is live for `vireek.com`, `in.`, `mail.`, `feeds.`, and is `vireek.ai`/`vireek.app` owned? (UNVERIFIED here.)
3. Is a trademark filing in progress or planned? (`registered: false` today.) Any existing customer contract that names "Vireek"?
4. How many QR/NFC tags and postcards are already in the field, and what is the required lifetime of their URLs?
5. How many external integrators use `X-Vireek-*`, `vrk_` keys, `@vireek/sdk` or the CLI? Required deprecation window?
6. Are the iOS/Android apps published? Under which publisher accounts? (Bundle IDs are permanent.)
7. What are the current Stripe statement descriptor, Twilio A2P/CNAM brand, Plaid/Google/Microsoft/Intuit/Xero app names, Slack/Teams apps? Who owns those accounts?
8. Should "Powered by/Sent via/Verified by Vireek" appear on white-labeled tenants at all (e.g. Trusted Service seal, passports, scheduled-report footer)? Is the plan entitlement (`planAllowsWhiteLabel`) the rule?
9. Is `ali@vireek.com` intended to remain the public contact and security contact?
10. Is `.env` in this snapshot intentionally included, and has any value ever left your machine?
11. Is the snapshot current? (No `.git`; latest migration timestamps run into 2028.) Provide the live tree or `git ls-files` if counts must be exact.

## Appendix A — method and commands (reproducible)

- Walk all files; exclude `node_modules`, `.git`, `dist`, `build`, `.next`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`; skip binary files except to record file names.
- Match `vireek` case-insensitively; classify each hit line:
  X (non-shipping: root `*.patch`/`*.diff`/`*.txt` artifacts, tests/fixtures, comments, `.md`) → C (legal path or consent text, no identifier shape) → D (From-name/client_name/appId/bundle/bot/social/AASA patterns) → B (identifier shapes: `vireek_`, camelCase, `VIREEK_`, `vireek-…`, `X-Vireek`, `com.vireek`, `@vireek/`, URLs/domains) → A (everything else).
- Additional manual inspection: `index.html`, manifest, `sw.js`, `offline.html`, `capacitor.config.ts`, ICS code, User-Agent strings, email From defaults, SMS/voice/IVR strings, PDF builders, direct-mail, white-label code, storage buckets, packages, OpenAPI.
- Cross-checks: `grep -rIio vireek` total = 15,990; files containing = 2,037; file names = 41.

## Appendix B — Final report

- **Files added:** `docs/brand/01-brand-surface-audit.md` (this file). **Files changed:** none (source read-only; extraction was done in a scratch copy outside the repo).
- **Commands run:** `unzip`; `grep`/`find` counts; a Python classifier over all text files; random sampling for accuracy. Results are above.
- **Lint / typecheck / full test suite:** NOT RUN. This task modified no source, the snapshot has no `node_modules`, and the sandbox has no network access.
- **Risks / limits:** snapshot may be stale; heuristic classification (see §1 accuracy notes); third-party consoles and DNS unverified; some tenant-facing surfaces marked UNVERIFIED pending per-file reading.
- **Follow-ups:** (1) re-run on the live tree; (2) per-file check of UNVERIFIED rows in §5; (3) decide whether to extend `brandConfig.ts` adoption (A-class centralization) before any naming decision; (4) add a CI "name-leak" check to `scripts/brand-audit` once the policy is decided.
