# Deprecation and sunset policy

How Vireek retires things: how much notice customers get, what we tell them and when, and how they get their data out before anything disappears. The mechanism that enforces it is in code; this document is the policy that the code follows.

- Registry (single list of everything being retired): [`supabase/functions/_shared/lifecycle/registry.ts`](../../supabase/functions/_shared/lifecycle/registry.ts)
- Rules and validation: [`supabase/functions/_shared/lifecycle/deprecations.ts`](../../supabase/functions/_shared/lifecycle/deprecations.ts), tested in `deprecations.test.ts` next to it
- API headers: `supabase/functions/api-v1/contract.ts` (`deprecationHeaders`) and `index.ts`
- In-app banner: `src/components/DeprecationBanner.tsx`, texts in `src/i18n/lifecycleNamespace.ts`
- Who decides what: [`prioritization.md`](prioritization.md) section 6; area owners: [`../OWNERS.md`](../OWNERS.md)

Items marked **[COUNSEL]** need legal review before they are treated as settled. Items marked **[VERIFY]** are statements about the product that were not confirmed while writing this and must be checked by the owner.

## 1. Scope and definitions

The policy applies to anything a customer can use, see or depend on: API resources and versions, dashboard pages and routes, features, settings, integrations and exports.

- **Deprecated**: still works, will be removed, customers have been told. Starts on `announcedAt`.
- **Sunset date** (`sunsetAt`): the earliest day removal may happen. Nothing is removed before it.
- **Removed**: the day removal actually shipped (`removedAt`). The registry entry stays as history.
- **Stable / Beta**: the labels the product already uses (the public API policy defines both). Stable gets the full notice period; Beta gets the shorter one. A surface that is not labelled counts as Stable.

Out of scope: fixing bugs, changing internal implementation, adding fields or endpoints, and changes that are not breaking (new optional parameters, new error codes, new webhook events). Those follow the normal changelog flow.

## 2. Notice periods

The notice period runs from the day customers are first told (`announcedAt`) to `sunsetAt`. The values below are the ones enforced by `MIN_NOTICE_DAYS` in code: the build fails if an entry is shorter than its class allows.

| Class | Minimum notice | Applies to |
|---|---:|---|
| `stable` | 90 days | Any Stable surface: API resources and versions, dashboard features, routes, settings |
| `integration` | 60 days | A third-party integration we offer (calendar, accounting, messaging, payment connectors) when we are the ones ending it |
| `beta` | 30 days | Anything labelled Beta, and pilots or preview features |
| `forced` | none, with a written reason | The removal is forced by something outside our control or by an urgent risk: a vendor ending its API on a fixed date, a security vulnerability that cannot be fixed in place, a legal requirement. Requires `forcedReason` in the registry. Announce the same day the need is known, and give the longest notice that is still safe |

Rules:

1. **The 90 days for Stable API resources is a published commitment** ("Breaking changes to a Stable endpoint are announced in the changelog at least 90 days before they take effect", Developers page). It can be lengthened, never shortened below the published text. If the published text changes, change `MIN_NOTICE_DAYS.stable` and this table in the same change.
2. **Never shorten, only extend.** Once announced, the sunset date may move later, never earlier, except as a `forced` deprecation with its own registry entry and reason.
3. **Contracts may require more.** Customer agreements, partner terms or enterprise commitments can promise longer or different notice. This document does not state what those say: **[COUNSEL]** confirm before the first deprecation that no contract or the Terms conflict with these periods **[VERIFY]**. If one does, the longer period wins, and the affected entry should use a longer `sunsetAt`.
4. **Notice is calendar days.** Dates are UTC; the sunset day starts at 00:00 UTC.
5. **No silent removals.** Removing something that was never announced is an incident, not a deprecation: treat it with the incident process in `RUNBOOK.md`.

## 3. Lifecycle and communication steps

Let T0 be `announcedAt` and S the sunset date. Steps are owned by the area owner (`../OWNERS.md`); the product owner approves the start (prioritization.md, section 6).

| When | Step | Where it happens |
|---|---|---|
| Before T0 | **Decide and prepare.** Confirm the replacement or the reason there is none; confirm the export path (section 4); write the migration guide; brief support with a short FAQ; check contracts **[COUNSEL]** | Ticket, docs |
| T0 | **Announce** (all of these on the same day) | |
| | 1. Add the registry entry (this starts the API headers and the banner) | `registry.ts` |
| | 2. Developer changelog entry of type `breaking` for anything API or webhook related | `src/lib/developerChangelog.ts` |
| | 3. Product changelog entry for anything customers see in the dashboard | `src/lib/changelog.ts` |
| | 4. Email to the account owners of affected accounts, and to the holders of API keys that used the resource in the last 90 days. Say what changes, the sunset date, what to do, and where to get help | Existing email channel **[VERIFY: confirm the channel and how affected accounts are selected]** |
| | 5. Update public text that says otherwise (for the API, the sentence on the Developers page that says nothing is deprecated) and publish the migration guide | `src/components/developers/ApiPolicies.tsx`, docs |
| S minus 30 days | **Reminder** to accounts still using it (skip when the whole notice is shorter than 30 days) | Email, banner |
| S minus 14 days | **Final reminder.** The banner becomes non-dismissible (`URGENT_DAYS`). Support and success contact the heaviest remaining users directly | Email, banner, support |
| S minus 7 days | Confirm the export path still works; check remaining usage; decide go / extend. If many customers are blocked, extend (section 2, rule 2) rather than removing | Owner |
| S | **Sunset.** The thing may be removed from this day. Headers and banner stay on until removal ships | |
| After S | **Remove** in a normal release. Set `removedAt` in the registry the same day. API removals also need a major `API_VERSION` bump (the contract test fails on a removed operation otherwise) | Release |
| After removal | Remove dead code and flags (see `config/flags.registry.json` cleanup notes), keep the registry entry, keep the changelog entries, close the ticket | Owner |

A removal that cannot meet its reminder steps (very short `forced` notice) still does steps 1 to 5 on T0 and adds direct contact for every affected account.

## 4. Data export before sunset

Customers must be able to take their data with them. For every entry the registry records an explicit answer in `dataExport`:

- `holdsCustomerData: false`: nothing customer-owned is lost (for example a pure UI rearrangement). Say so; the build requires the decision.
- `holdsCustomerData: true`: the entry must give either `exportRoute` (an in-app path; the banner shows "Export your data" with that link) or a `note` that explains how customers get their data out.

Requirements for the export itself:

1. **Available from T0, not from the last week.** The route or process must work on the day of the announcement.
2. **Complete and documented.** It covers everything the customer entered or Vireek recorded for them in that feature, in an open format (CSV or JSON), with the field meanings documented. The dashboard has a general exports page at `/dashboard/exports` and an account data module (`src/lib/accountData.ts`); **[VERIFY]** that they actually cover the data of the feature being retired, and extend them first if not.
3. **Tested** with a real, large account before T0, including size limits and time-outs.
4. **Access control.** Exports follow the same permission and tenant scoping as the feature itself; a retired feature is never a way around them.
5. **After removal.** Keep the data exportable and read-only for at least 30 days after the sunset unless that conflicts with a retention or deletion duty, then delete it under the normal retention rules. The 30 days and the deletion step are a proposal: **[COUNSEL]** confirm against the privacy and retention obligations that apply. Never delete customer data earlier than the period announced.
6. **API consumers** can pull the same records with the read endpoints that still exist; say in the migration guide which ones.

## 5. API specifics

Implemented in `supabase/functions/api-v1`. For a registry entry with `api` set:

| Header | Value | Standard |
|---|---|---|
| `Deprecation` | `@<unix seconds>` of `announcedAt` (00:00 UTC) | RFC 9745 |
| `Sunset` | HTTP-date of `sunsetAt` (00:00 UTC) | RFC 8594 |
| `Link` | `<migrationUrl>; rel="deprecation"` | RFC 8288 |

- Sent on authenticated responses for the affected resource, including its error responses. The response body does not change.
- `api.resource` is a resource name (`calls`, `leads`, `jobs`) or `*` to deprecate the whole API version. A resource entry wins over `*`.
- Malformed data never produces malformed headers: a bad date yields no headers, an unsafe link is dropped (the dates are still sent). The registry test catches both before release.
- All three headers are exposed to browser clients (CORS `Access-Control-Expose-Headers`).
- **After the sunset date** the headers keep being sent until removal ships. We do not switch a resource off automatically on the date; removal is a deliberate release.
- Beta features follow the `beta` class and say so in the changelog entry.
- Not done yet (see section 9): the OpenAPI document does not mark deprecated operations and does not list the `Link` header.

## 6. In-app banner

Driven only by the registry entry's `banner` block (`enabled`, `showFromDaysBeforeSunset`, `routePrefixes`, `audience`).

- Shows when: `enabled`, announced, not removed, inside the display window, on a matching route, for the right audience (`all` or account `owner`). At most two at once, most urgent first.
- Text: the entry's English `title` and `summary`, with optional per-language `messages`; labels come from the `lifecycle` i18n namespace. Dates are ISO (`2027-03-01`) so they read the same in every language and in right-to-left layouts.
- Links: the export route (when data is held), the replacement and the migration guide. Only in-app paths and plain https URLs are ever rendered.
- Dismissal: per entry, on this device only, and not possible in the last 14 days. A dismissal never replaces the email and changelog steps.
- API-only entries normally set `banner.enabled: false`: dashboard users do not see API changes, integrators do through headers, changelog and email.

## 7. Registry rules

One entry per thing retired (`DeprecationEntry`). The test suite fails the build when:

- an id is not kebab-case or is reused; a date is not a real `YYYY-MM-DD` date; `announcedAt` is in the future;
- the notice is shorter than the class allows, or a `forced` entry has no `forcedReason`;
- `removedAt` is before `sunsetAt` or in the future;
- a link is not plain https, or an in-app route does not start with a single `/`;
- `dataExport` is missing, or customer data is held with no route and no note;
- an API entry has an unknown resource, no migration URL, or two live entries target the same resource;
- `api-v1/index.ts` stops passing the registry to `deprecationHeaders`.

Entries are never deleted. To add one: copy the commented example in `registry.ts`, fill it, run the tests, and do the T0 steps in the same change.

## 8. Readiness checklist (copy into the ticket)

```
Item:                         id:
Owner (area):                 Approved by (prioritization.md section 6):
Class and notice:             announcedAt:        sunsetAt:        days:
Replacement / reason none:    Migration guide URL:
Holds customer data?          Export route or note:        Tested on a large account? [ ]
Contracts / Terms checked [COUNSEL]: [ ]
Support FAQ ready [ ]   Email drafted and audience selected [VERIFY] [ ]
Registry entry added [ ]   Developer changelog [ ]   Product changelog [ ]
Public text updated (Developers page "nothing is deprecated") [ ]
Reminders scheduled (S-30, S-14, S-7) [ ]
After sunset: removal release [ ]   removedAt set [ ]   code and flags cleaned up [ ]
```

## 9. Known gaps

- The OpenAPI document (`public/openapi.json`) does not yet mark deprecated operations (`deprecated: true`) and does not list `Link` among the response headers. The contract file must stay import-free, so this needs the registry passed into the spec builder and the published spec regenerated.
- There is no customer-facing page listing all current deprecations; the banner and emails are the channels today.
- Email audience selection ("accounts that used it", "API keys used in the last 90 days") is a manual step until it is automated **[VERIFY]**.
- Contract and retention questions in sections 2 and 4 are open **[COUNSEL]**.
