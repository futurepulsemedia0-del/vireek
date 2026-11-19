# Sub-processor reconciliation

Reconciles the public sub-processor list (`src/lib/subprocessors.ts`, rendered on `/subprocessors`, the Trust Center and the Security Portal) with the providers the code actually uses.

**Scope and limits.** This is a static scan of the checked-out source tree. It shows what the code references, not what is configured in production, what contracts exist, or where data is really processed. Items marked **[VERIFY]** are unverified facts. Items marked **[COUNSEL]** are legal decisions this document does not make. Nothing here is legal advice, and nothing here has been sent to a customer.

## How this is kept honest

| Command | What it does |
| --- | --- |
| `npm run subprocessors:reconcile` | Rewrites the generated table below. |
| `npm run subprocessors:check` | CI gate. Fails when a provider env var, domain, CSP host or SDK is found in code but its provider is neither on the public list nor exempt in `scripts/compliance/subprocessor-exempt.json`; also fails on an unclassified outbound host, a stale table, or drift in the by-region data map. |
| `npm run test:scripts:subprocessors` | Unit tests for the scanner, including failing fixtures. |
| `node scripts/compliance/subprocessor-reconcile.mjs --explain <id>` | Prints the evidence (hosts, env names, packages, files) behind one provider id. |

Sources scanned: `supabase/functions`, `src`, `api`, `worker`, `index.html`, the Content-Security-Policy in `vercel.json`, `package.json` dependencies, and env-var **names** in `ENVIRONMENT.md` and `.env.example` (values are never read). The provider catalog is shared with `scripts/compliance/gen-vendor-exit.mjs`; browser-side providers it does not know are in `EXTRA_CATALOG` inside the reconcile script. To add a provider: list it in `src/lib/subprocessors.ts`, classify it in `src/lib/trustPack/subprocessorResidency.ts`, and map its id in `SLUG_TO_LISTED`.

## Initial reconciliation (18 Nov 2026)

- The published list held **15** processors. The scan found **57** provider groups in code. **42** processors were added to the list; **7** groups are exempt with a written reason (see below).
- The most significant gaps were providers that receive personal data: telephony and messaging (Twilio, Telnyx, Sinch, Meta, Telegram, Slack, Microsoft), further AI providers (Anthropic, Cohere, ElevenLabs), website form handlers (Formspark at `submit-form.com` and Formspree), background screening (Checkr), consumer financing (Wisetack), bank linking (Plaid), direct mail (Lob), property data (RentCast, ATTOM) and the customer-connected accounting, CRM, field-service and property-management integrations.
- Before this change, `gen-subprocessors-by-region.mjs --check` already failed, reporting 13 providers called from code but absent from the list. That gate is green again.
- **Every location of an added processor is marked [VERIFY].** Vendor headquarters are not processing locations. Confirm each against the vendor's own documentation or contract before publishing.

## Generated table

<!-- BEGIN GENERATED:reconciliation -->
<!-- END GENERATED:reconciliation -->

## Exempt from the public list (needs a decision)

These are seen in code but deliberately not listed. The reason for each lives in `scripts/compliance/subprocessor-exempt.json`.

- `public-data-apis` — public endpoints (weather, census geocoding, OSM Nominatim/OSRM, ipwho.is, FX…). Some receive addresses, coordinates or IP addresses. **[COUNSEL]** whether they are sub-processors or a documented exception; **[VERIFY]** which endpoints receive end-customer data.
- `embedded-video` — YouTube-nocookie and Vimeo embeds in help-center content. **[COUNSEL]**.
- `package-cdns` — esm.sh / jsDelivr serve code to edge functions. **[VERIFY]** no customer data in requests.
- `google-fonts`, `glitchtip`, `banuba`, `pluot` — present only in the CSP allowlist, no code reference. **[VERIFY]** and remove from the CSP if unused; list the vendor if it is used.

## Observations outside this task (not changed)

- `formspree.io` is called from `PodcastPage.tsx` and `ReportPage.tsx` but is not in the CSP `connect-src` of `vercel.json`. **[VERIFY]** whether those forms work in production.
- "Zapier, Inc." is listed but the code contains no outbound call to Zapier (comments and inbound webhooks only). **[VERIFY]** and keep or remove.
- Datadog and Snowflake have catalog patterns in `gen-vendor-exit.mjs` but no host or env evidence in code, so they are not listed. **[VERIFY]**.
- `SUBPROCESSORS_LAST_UPDATED` was intentionally not changed: set it when the list goes live.

## Go-live checklist

1. Resolve every `[VERIFY]` location in `src/lib/subprocessors.ts`. The public page prints the string as written, so do not publish with the marker still in place.
2. **[COUNSEL]** Decide how the expanded list interacts with the notice process in `DpaContent.tsx` section 5 and signed DPAs, including any objection window.
3. Update `SUBPROCESSORS_LAST_UPDATED` on the day the list goes live.
4. Re-run `npm run subprocessors:reconcile` and `node scripts/compliance/gen-subprocessors-by-region.mjs`.

## Draft customer notice wording **[COUNSEL]**

Draft only. Not reviewed, not sent. Notice period, objection mechanism, recipients and channel are for counsel to set.

> **Subject: Update to Vireek's sub-processor list**
>
> We have updated our public sub-processor list at `<URL>`. The update adds providers that were already part of how the service operates but were not previously listed, including providers for telephony and messaging, additional AI model providers, website forms, and optional integrations that you can connect to your account.
>
> The updated list takes effect on `<DATE>`. If you have a data processing agreement with us and wish to object to a change, you can do so by `<MECHANISM>` within `<PERIOD>`, as described in section 5 of the agreement. `<COUNSEL: describe the consequence of an objection and any remedy>`
>
> Questions can be sent to `<CONTACT>`.
