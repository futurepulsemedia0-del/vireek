# Analytics tracking plan

Single source of truth in code: `src/lib/analyticsEvents.ts` (`EVENT_REGISTRY`). This page is the human-readable view of it.
`npm run lint:analytics` and `src/lib/analyticsEvents.test.ts` fail when the two disagree, so this file cannot silently go stale.

## Scope

- Covers the browser GA4 integration in `src/lib/analytics.ts` only (`trackEvent`, `trackRegisteredEvent`, `trackPageview`).
- Not covered: Core Web Vitals beacons (`src/lib/perf/webVitals.ts`, own endpoint), first-party `telemetry.ts`, server-side events, and the
  internal domain-event backbone (`business_activity_events`).
- Nothing is sent before analytics consent (`src/lib/consent/engine.ts`). Consent Mode v2, `anonymize_ip` and the disabled ad signals live in `analytics.ts`.

## Rules

1. **Registry first.** Add the event to `EVENT_REGISTRY`, then this table, then the call site. TypeScript rejects unknown events, unknown or mistyped properties and missing required properties.
2. **No PII, ever.** Every property is `pii: false` (a literal type; `true` does not compile). No emails, phone numbers, names, addresses, free text, search queries, call transcripts, tokens, or user/account/contact/tenant ids. Use bucketed or enumerated values (see `ttfc_bucket`).
3. **Runtime guard.** `trackEvent` drops unregistered events and strips unregistered, mistyped or PII-looking values (emails, phone-like digit runs, JWTs, > 100 chars). In development the reason is logged with `console.error("[analytics] ...")`.
4. **GA4 limits.** Event and property names are `snake_case`, start with a letter, max 40 chars, max 25 properties, no `google_`/`ga_`/`firebase_`/`gtag.` prefix.
5. **Dynamic names and uncalled references** (`track: trackEvent`) are not allowed unless the line above carries `// analytics-events: a, b` listing every possible name (the lint checks each one is registered).
6. **Never** call `gtag('event', ...)` directly; the lint fails on it.
7. **Changing or removing** an event: keep the name stable, add properties as optional, and note the change in `CHANGELOG.md`. Removing a property that a GA4 report or audience uses needs the owner's sign-off.

## Owners

Owner values are team areas, not people: `growth`, `product`, `platform`, `onboarding`, `analytics`. [VERIFY] The assignment below was proposed from the code
area each event lives in; confirm it with the actual team leads.

## Events

| Event | Owner | Description | Properties | PII |
| --- | --- | --- | --- | --- |
| `page_view` | analytics | Route change. Sent by trackPageview(): wallboard and /audit paths are never sent, only utm_* query parameters are kept, no hash. | `page_path` (string), `page_title` (string), `page_location` (string) | no |
| `palette_open` | product | Command palette opened. Never carries query text. | — | no |
| `palette_select` | product | A palette result was chosen. | `scope` (string), `kind` (string), `position` (number), `search_ms` (number, optional) | no |
| `tour_started` | onboarding | Tour auto-started. | `tour_id` (string), `version` (number), `step_count` (number), `step_index` (number) | no |
| `tour_resumed` | onboarding | Tour resumed after a pause. | `tour_id` (string), `version` (number), `step_count` (number), `step_index` (number) | no |
| `tour_replayed` | onboarding | Tour replayed by the user. | `tour_id` (string), `version` (number), `step_count` (number), `step_index` (number) | no |
| `tour_step_viewed` | onboarding | A tour step was shown. | `tour_id` (string), `step_id` (string, optional), `step_index` (number) | no |
| `tour_completed` | onboarding | Tour finished. | `tour_id` (string), `version` (number), `step_index` (number), `step_count` (number) | no |
| `tour_skipped` | onboarding | Tour dismissed before the end. | `tour_id` (string), `version` (number), `step_index` (number), `step_count` (number) | no |
| `tour_paused` | onboarding | Tour paused. | `tour_id` (string), `step_index` (number) | no |
| `tip_dismissed` | onboarding | Contextual tip dismissed. | `tip_id` (string) | no |
| `tips_reset` | onboarding | User reset all tips. | — | no |
| `first_call_answered` | onboarding | The first test call was answered (once per session). | `channel` (string), `international` (boolean), `ttfc_bucket` (string) | no |
| `sarah_learn_readiness` | onboarding | Sarah-learn readiness scorecard ran. | `passed` (number), `total` (number), `gate` (boolean) | no |
| `sarah_learn_go_live` | onboarding | Sarah-learn went live. | `ms` (number) | no |
| `sarah_learn_first_draft` | onboarding | Sarah-learn produced a first draft. | `ms` (number), `fields` (number) | no |
| `sarah_learn_rerun` | onboarding | Sarah-learn rerun requested. | — | no |
| `experiment_exposure` | growth | User was exposed to an experiment variant (once per session). | `experiment_id` (string), `variant_id` (string) | no |
| `dashboard_viewed` | analytics | Business KPI dashboard viewed. | `range_days` (number), `team_filtered` (boolean) | no |
| `csv_exported` | analytics | KPI CSV exported. | `granularity` (string), `range_days` (number) | no |
| `digest_toggled` | analytics | KPI digest setting changed. | `enabled` (boolean), `cadence` (string) | no |
| `anomaly_alert_opened` | analytics | KPI anomaly alert opened. | `metric` (string), `severity` (string) | no |
| `blog_scroll_depth` | growth | Scroll milestone reached. | `post_slug` (string), `percent` (number) | no |
| `blog_cta_click` | growth | Blog CTA clicked. | `post_slug` (string), `cta_type` (string), `placement` (string) | no |
| `blog_calculator_use` | growth | Blog calculator used. | `post_slug` (string) | no |
| `blog_newsletter_signup` | growth | Newsletter signup from the blog. | `source` (string) | no |
| `blog_share` | growth | Blog post shared. | `post_slug` (string), `channel` (string) | no |
| `sign_up` | growth | Trial signup completed (GA4 recommended event). | `method` (string) | no |
| `generate_lead` | growth | Lead generated (GA4 recommended event). | `lead_source` (string) | no |
| `demo_booked` | growth | Demo booked. | `days_until_demo` (number, optional) | no |

## page_view URL hygiene

`trackPageview` builds its URL fields with `sanitizePageUrl()` (`src/lib/analyticsEvents.ts`):

- the `#hash` and every query parameter except `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` are dropped (campaign attribution keeps working);
- `utm_*` values that look like personal data or exceed 100 chars are dropped;
- path segments that are an email address or a JWT (also when percent-encoded) become `:redacted`;
- `page_title` is clamped to 100 chars; `/wallboard/*` and `/audit/*` are still never sent.

Paths otherwise pass through unchanged: ids in paths (for example a job id) are not treated as personal data by the code.

## Known gaps and open decisions

- **Owners [VERIFY].** `owner` is a functional area (`growth`, `product`, `platform`, `onboarding`, `analytics`), proposed from where each event lives in the code. `.github/CODEOWNERS` still contains only `@OWNER_*` placeholders, so there is no real team list to check it against. Confirm the areas with the maintainers.
- **`page_title` [VERIFY].** It is DOM text. If any page puts a customer name in `document.title`, it would reach GA. Audit page titles on authenticated routes.
- **Personal-data classification [COUNSEL].** Which properties count as personal data in a given jurisdiction, and what the cookie policy must say about GA4, is a legal question. The registry only enforces the technical rule "no PII properties".
- **GA4 custom dimensions [VERIFY].** Not checked: which properties are registered as custom dimensions in the GA4 admin.
- **Indirect calls.** A bare reference such as `track: trackRegisteredEvent` must carry `// analytics-events: a, b`; the lint verifies every listed name is registered. Event names produced inside `buildConversionEvents` are typed (`ConversionEvent`) and covered by a unit test.
- **Out of scope.** `src/lib/perf/webVitals.ts` (own endpoint) and `src/lib/telemetry.ts` (first-party) do not use GA4.

## Adding an event (checklist)

1. Add it to `EVENT_REGISTRY` in `src/lib/analyticsEvents.ts` (owner, description, properties, all `pii: false`).
2. Add a row to the table above (`| \`event_name\` | owner | ...`).
3. Call `trackEvent('event_name', { ... })`.
4. Run `npm run lint:analytics` and `npx vitest run src/lib/analyticsEvents.test.ts src/lib/analytics.test.ts`.
