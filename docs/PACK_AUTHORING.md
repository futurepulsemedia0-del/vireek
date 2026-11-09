# Authoring a Trade Pack

A pack is **versioned data**. A new trade is a new manifest — no new tables, pages or branches.
Pack code lives in `src/lib/packs/`. (Not to be confused with `src/lib/tradePacks/`, the older
pest-control / pool-service compliance packs, which this framework does not touch.)

## 1. Write the manifest

Copy `src/lib/packs/sample.ts` (shows every section). Fields:

| Section | Artifact kind | What it holds |
|---|---|---|
| `jobTypes` | `job_type` | label, default duration, optional checklist form, price template, ticket range |
| `customFields` | `custom_field` | entity (`customer`/`job`/`equipment`), type, options |
| `forms` | `form` | forms and checklists (`items`; `critical` marks safety-critical steps) |
| `statuses` / `workflowRules` | `status` / `workflow_rule` | job statuses and allowed transitions (+ required forms / photo) |
| `pricingTemplates` | `pricing_template` | price lines, **integer cents** |
| `terminology` | `term` | relabel platform words (`job` → "Service call") |
| `documentTemplates` | `document_template` | plain text with `{{placeholders}}` (no HTML) |
| `recurringRules` | `recurring_rule` | recurring-contract cadence |
| `reports` | `report` | metric + grouping from a fixed list |
| `onboardingPresets` | `onboarding_preset` | setup steps (in-app routes) |

Rules: `id` is `^[a-z][a-z0-9_]{1,40}$`; every `key` is `^[a-z][a-z0-9_]{1,60}$` and unique per section;
`version` is `MAJOR.MINOR.PATCH`; unknown properties are rejected (typos get a "did you mean");
references (`checklistFormKey`, `from`/`to`, `jobTypeKey` …) must exist in the same pack.
Regulatory or legal text is **not** asserted by packs — mark such content REQUIRES COUNSEL.

## 2. Register it

Add the manifest to `PACK_VERSIONS` in `src/lib/packs/registry.ts`. `registry.test` fails CI listing every
problem (`path: message`) if a pack is invalid. **Never edit a published version** — add a new one
(`1.1.0`). Version bumps: patch = wording/price fix, minor = additions, major = removals/renames.

## 3. Release

1. Merge. 2. Staff open `/staff/packs` and **Publish** versions in ascending order (immutable afterwards).
3. Grant the entitlement `packs:<id>` per account (same page). 4. Turn on flag `trade_pack_framework`
(Staff → Feature flags) per tenant / rollout %. Accounts then see **Dashboard → Trade pack library**.

## 4. How upgrades treat accounts (three-way merge)

For each artifact: *base* = pack content last applied, *live* = what the account uses, *next* = new version.

| Situation | Result |
|---|---|
| live = base (not customized), pack changed | updated |
| customized, pack did **not** change it | untouched |
| customized **and** pack changed it | account's version kept, listed in the preview |
| artifact is new in the pack | added |
| pack dropped it, account never changed it | removed |
| pack dropped it, account customized it | kept, becomes account-owned |

"Reset to pack" (per artifact) is the only way a customization is replaced, and only on request.
Every install / upgrade / rollback shows a preview diff first, is applied atomically, can be retried safely
(idempotency key), and is recorded in the append-only `pack_events` log. Rollback reverts only what is still exactly
as the change left it; later customizations are kept.

## 5. Checklist before shipping a pack
`npx vitest run src/lib/packs` · `npm run typecheck` · `npm run lint` · `npm run lint:migrations` · publish to staging first.
