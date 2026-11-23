# New-vertical playbook

How to add a trade to Vireek (HVAC, plumbing and electrical are shipped; everything else is new) without breaking the trades that already work.

- **Scope:** product and content work for a new trade: price book, intents, safety content, compliance, localization, data model, entry points, release.
- **Out of scope:** the decision to enter a market (commercial), pricing of Vireek itself, and anything a lawyer must decide. Those are marked `[COUNSEL]` and left to counsel.
- **Machine-readable twin:** `src/lib/newTradeChecklist.ts` generates the checklist for a specific trade and lints a draft playbook. This document explains the reasoning; the generator is the list you work through. Run `npm run product:new-trade -- <input.json> --verify-evidence` to confirm that every repository claim below still holds.

Tags used throughout: `[COUNSEL]` needs legal review before anyone relies on it. `[VERIFY]` is a fact nobody has confirmed against a primary source. Nothing in this document certifies compliance with any law, standard or licensing scheme.

## 1. Pick the mechanism first

Vireek has four things that sound alike. Using the wrong one is the most expensive mistake in a new-trade project.

| Mechanism | Where | Use it for | Not for |
|---|---|---|---|
| **Trade playbook catalog** | `src/lib/tradePlaybookCatalog.ts` | Job types, price seeds, diagnostic triage, checklists, dispatch rules, benchmarks. Installed into a tenant by `src/lib/tradePlaybooks.ts`. | Regulated-product ledgers, new tables |
| **Baseline pack** | `src/lib/packs/baseline.ts` | Nothing to write: it is `TRADE_PLAYBOOKS.map(playbookToPack)`, version `${catalogVersion}.0.0`. | Hand-authored content |
| **Trade Pack framework (legacy)** | `src/lib/tradePacks/` | Compliance log types and a regulated-product register (pest control, pool). Gated packs such as landscaping (`docs/LANDSCAPING_PACK.md`). | Operating knowledge |
| **Weather / seasonal ops playbooks** | `supabase/functions/_shared/playbooks/` | Seasonal campaigns. **Not a trade mechanism.** | Anything trade-specific |

Rule of thumb: if the trade only needs job types, prices, triage and dispatch rules, add a catalog entry and nothing else. If technicians must keep a legally relevant ledger (refrigerants, pesticides), that part belongs in the Trade Pack framework `[COUNSEL]`. `docs/PACK_AUTHORING.md` documents manifests and the publish flow.

## 2. What a catalog entry does once it exists

1. `TradePlaybooksPage` lists every entry of `TRADE_PLAYBOOKS` automatically (no page edit).
2. Install writes price-book rows and AI knowledge articles for the tenant. Prices are scaled by a multiplier and rounded to whole dollars. A service the tenant already owns (case-insensitive name) is skipped. The install never overwrites tenant-owned rows.
3. `BASELINE_PACKS` derives a pack from the entry, and `src/lib/packs/packs.test.ts` already asserts that every playbook is mirrored exactly (jobs, critical checklist items, prices).
4. Job outcomes are stored per `playbook_slug`. `outcomeLearning.ts` turns them into suggestions (price, duration, root-cause article, critical checklist item). Cause keys are therefore permanent identifiers.
5. `firstTimeFixAutopilot.ts` and `serviceIntelligenceLoop.ts` read `TRADE_PLAYBOOKS` for priors and vocabulary.

## 3. Where a trade is hard-coded (verified in this repository)

Adding a catalog entry does not reach the places below. Each is an explicit enumeration, and each has a consequence if forgotten. The generator's `evidence` check fails when one of these claims stops being true.

| # | Place | Enumerates | If you forget it |
|---|---|---|---|
| 1 | `tradePlaybookCatalog.ts` `TradeSlug` | `hvac`, `plumbing`, `electrical` | The entry does not type-check |
| 2 | `onboardingTradeDefaults.ts` `SUPPORTED_TRADES` | same three | `tradeSlugFor()` returns `null`; onboarding shows no preview |
| 3 | `onboarding/types.ts` `INDUSTRY_OPTIONS`, `signupQualificationCore.ts` | hvac, plumbing, electrical, roofing, general_home_services, other | Tenants cannot pick the trade |
| 4 | `20290306000000_signup_qualification.sql` `CHECK (trade IN (...))` | same six values | Inserts with the new value fail. Needs a new idempotent migration |
| 5 | `TradePlaybooksPage.tsx` default selection | `p.slug === primaryIndustry`, else first playbook | An industry with no playbook (roofing today) preselects HVAC |
| 6 | `outcomeNetwork.ts` `OinTrade`, `tradeFromIndustry()` | hvac, plumbing, electrical | New trade maps to `other`; no network benchmarks |
| 7 | `20270205000000_outcome_intelligence_network.sql` CHECKs and RPC guard `p_trade NOT IN (...)` | the same three | RPC rejects the trade. Needs a migration plus taxonomy seeds |
| 8 | `emergencyCore.ts` `Trade`, `emergencyNetwork.ts`, `skillMarket.ts` `TRADE_OPTIONS`, `required_trade` CHECK in `20270111000000_autonomous_emergency_network.sql` | hvac, plumbing, electrical, roofing, restoration, locksmith, general | Map to `general` or extend all four together |
| 9 | `technicianSimulator.ts` `SimTrade` | hvac, plumbing, electrical, appliance | `tradeForServiceType()` returns `null` |
| 10 | `emergencyCore.ts` `SAFETY_LINES` | gas, smoke, electric, water | A hazard outside these four has no fixed instruction |
| 11 | `emergencyFastPath.ts` `LIFE_SAFETY` regexes | English and Spanish phrases | The call is not recognised as an emergency |

Related naming source: `src/lib/talentNetwork.ts` already keys trades such as `garage_door`, `appliance_repair` and `pest_control`. Reuse those keys when they exist so labels stay consistent.

## 4. Phases

The generator numbers every item (S1, P1, I1 ...). This section says what "done" means for each area.

### Phase 1: Scope (S1-S4)

Choose the mechanism (section 1), pick a snake_case slug, record who asked for the trade and who owns it afterwards, and score any new vendor with [`docs/governance/build-buy-partner.md`](../governance/build-buy-partner.md). The repository holds no demand data, so demand evidence is `[VERIFY]` by definition.

The slug has five jobs at once: `TradeSlug`, pack id (`^[a-z][a-z0-9_]{1,40}$`, so no hyphens), `playbook_slug` in tenant tables, the onboarding industry value, and the preselection key on the playbook page. Choose it once.

### Phase 2: Price book (P1-P5)

- 3 or more job types, 4 or more recommended; unique kebab-case keys. After the baseline pack turns hyphens into underscores the keys must still be unique (`a-b` and `a--b` collide).
- Every price seed: integer cents, a cost basis, margin at the lowest price within about five points of the benchmark target, 3 or more customer keywords for the AI quote lookup.
- All figures are placeholders until a practitioner of the trade confirms them `[VERIFY]`. The catalog has no source field, so the sources, dates and reviewer go into the pull request description.
- Non-US markets: the catalog is a USD-like baseline with imperial examples. Convert, ship a separate seed set, or do not ship the price book there `[VERIFY]`. `npm run lint:regional` applies.

### Phase 3: Intents (I1-I4)

"Intent" in Vireek has two layers:

1. **Caller scenarios** are generic (emergency, after hours, new inquiry, price quote, reschedule or cancel, existing customer, complaint). They need no trade code, but each should be scripted once with the trade's vocabulary in the call-script simulator and the results recorded.
2. **Job-type resolution** is the trade-specific layer: `match` fragments on each job type, matched against `jobs.service_type`.

Resolution rules that matter (all from `tradePlaybookCatalog.ts` and `firstTimeFixAutopilot.ts`):

- Inside one playbook the longest matching fragment wins.
- Across playbooks, `findJobType` walks `TRADE_PLAYBOOKS` in array order and returns the first playbook with any match.
- Therefore a new playbook goes at the **end** of the array, and none of its fragments may equal or contain a fragment of an older trade. Any service type that contains your fragment would also contain theirs, and they win.
- The price-book service name is usually what ends up in `service_type`, so each seed's `serviceName` must resolve to its own job type. The linter checks this directly (`price-name-shadowed`).
- Generic words (`replace`, `install`, `tune`, `maintenance`, `inspection`, `heater`, `upgrade`, `panel`, `light`, `fan`, `tank`, `pipe`) are already taken. Pad very short tokens with spaces (`" ac "`).

### Phase 4: Safety content (F1-F6)

- Every diagnosable job type needs a symptom, a safety sentence, at least three causes (one `common`), and test, fix and parts for each. The AI article summary lists the common causes, so a job type with none would read "Common causes include ." The linter rejects it.
- Mark isolation, lock-out, test-before-touch and commissioning steps `critical`. Critical items feed the learning loop.
- `dispatchNotes` become a published AI article. For each hazard: what the caller must do first, then the dispatch priority. The AI is told not to promise a diagnosis by phone.
- **Life-safety wording is never model-generated.** `emergencyCore.ts` holds fixed lines for gas, smoke, electric and water only. A trade with another hazard (stored energy, chemical, structural, height) needs a reviewed fixed line and tests `[COUNSEL]`, or an explicit "end the call and direct to emergency services" path.
- The fast-path regexes are English and Spanish. A missed phrase is a false negative. A false positive costs a phone call. Add the trade's phrases and tests, and add native phrases for every other language `[COUNSEL]`.
- A working practitioner reviews every cause, test, fix, part, safety line and price. Neither the linter nor an AI can substitute for that `[VERIFY]`.

### Phase 5: Compliance (C1-C7)

- Licensing, permit and certification rules per market: the rule seeds in `compliance-rules/seedRules.ts` cover US federal plus five states and are all `in_review`. Do not write any requirement into playbook text or marketing until counsel confirms it for that market `[COUNSEL]` `[VERIFY]`.
- Regulated products (refrigerants, pesticides): ledger and log types belong to the Trade Pack framework, not the catalog `[COUNSEL]`.
- Recording consent and AI disclosure wording for each market and language `[COUNSEL]`; see `docs/compliance/voice-consent-and-ai-disclosure.md`.
- Public claims about the trade go through `scripts/check-claims.mjs` and `docs/compliance/PUBLIC_CLAIMS_INVENTORY.md`.
- Cross-tenant sharing: contribution to the Outcome Intelligence Network is opt-in with a consent timestamp. A published cell needs at least 5 tenants, at least 10 matured cases and no tenant above 50 percent. A new trade starts empty and stays empty until it clears those thresholds, which is expected.
- New tables: register them in `docs/compliance/erasure-coverage-baseline.json`.

### Phase 6: Localization (L1-L5)

What is true today `[verified in code]`:

- Catalog text (labels, triage, dispatch notes) is English-only data.
- `TradePlaybooksPage.tsx` renders it, and its own toast messages, without `useTranslation`.
- Locale bundles exist for `en` plus `es`, `fr`, `de`, `ja`, `zh`, `hi`, `ar`, `fa`. `ar` and `fa` are right-to-left.

So a new trade ships either English-only (state that in the release notes) or after a content-localization mechanism exists. Do not machine-translate safety text. New UI strings go through i18n for all nine locales. Emergency, consent and AI-disclosure keys need a named native reviewer (`docs/i18n/launch-checklist.md`, `npm run i18n:coverage:release`) `[COUNSEL]`.

### Phase 7: Data model (D1-D4)

- **No migration** is needed for install, outcomes, tuning or suggestions: `playbook_slug` is free text and the tables are RLS-scoped by `get_account_owner_id()`.
- **Outcome network:** to contribute, ship an idempotent migration that extends the CHECKs, the RPC guard and the taxonomy seeds (symptom, failure mode, action, part), update `OinTrade` and `tradeFromIndustry()`, and add pgTAP tests. Otherwise state plainly that the trade does not contribute. `[COUNSEL]` for the consent wording.
- **New tables:** idempotent migration, RLS with `user_id = public.get_account_owner_id()`, pgTAP under `supabase/tests/database`, `npm run lint:migrations`, a rollback note in the header comment.
- **Pack publish:** staff publish pack versions in ascending order (immutable after that), grant `packs:<slug>`, and gate with the `trade_pack_framework` flag.

### Phase 8: Entry points and go-to-market (E1-E3)

Update the five industry enumerations in section 3 (rows 2 to 6). The playbook page needs no edit, but verify it on a staging tenant: install, install again (must add nothing), record an outcome, check loading, empty and error states. Marketing copy for the trade: original and sourced, no invented testimonials or statistics `[VERIFY]`.

### Phase 9: Verification and release (Q1-Q4, R1-R3)

- `npm run product:new-trade -- <input.json> --verify-evidence --check` exits 0.
- `npx vitest run src/lib/packs src/lib/newTradeChecklist.test.ts src/lib/outcomeLearning.test.ts src/lib/serviceIntelligenceLoop.test.ts`, then `npm run typecheck`, `npm run lint`, and the conditional checks (`lint:migrations`, `i18n:coverage`).
- Shadow-mode pilot with one to three friendly tenants before the AI speaks to real customers (`docs/SHADOW_MODE.md`).
- New entry ships at `catalogVersion: 1` (pack `1.0.0`). Any later content change bumps the version.
- **Rollback:** remove the entry from the array and switch off the pack entitlement or flag. Rows already installed in tenants stay by design (the install flow has no uninstall); say so in the release notes.

**Release gate.** A trade is not releasable while any blocking item is open, the linter reports an error, a `[COUNSEL]` item lacks counsel sign-off, or the practitioner review is missing.

## 5. Using the generator

```bash
npm run product:new-trade -- path/to/input.json                       # print the checklist
npm run product:new-trade -- path/to/input.json --out checklist.md    # write it to a file
npm run product:new-trade -- path/to/input.json --verify-evidence --check   # CI / pre-merge gate
```

`input.json` holds a `candidate` (slug, name, hazards, regulatedWork, usesRegulatedProducts, recurringContracts, markets, languages, joinsOutcomeNetwork, needsNewTables) and, optionally, a `draft` playbook shaped like a `TradePlaybook` with a free-form slug. The candidate decides which conditional items appear. The draft is linted for structure and internal consistency: it cannot know whether a number is true.

Exit codes: `0` fine, `1` lint errors or stale evidence with `--check`, `2` unusable input. Output is deterministic (no timestamps), so it can be diffed.

## 6. Dry run: garage door (hypothetical)

Input: [`examples/garage-door.dry-run.json`](examples/garage-door.dry-run.json). Garage door is a hypothetical expansion trade chosen because its main hazard (stored spring energy) is not covered by any fixed safety line. All prices, benchmarks, causes and safety sentences in the file are placeholders nobody has reviewed `[VERIFY]`, and the file must never be installed.

**Checklist produced:** 40 applicable items, 30 blocking, 8 needing counsel, 9 containing unverified facts; 5 items skipped as not applicable (non-US pricing, regulated-product register, new-table work, erasure registration, non-Spanish voice).

Items that appeared because of the candidate, and why:

- F5, because `stored_energy` and `structural` have no fixed safety line.
- D2, because the trade should feed the outcome network, which is locked to three trades today.
- C1, because regulated work was assumed `[VERIFY]` for at least one state.
- C3, because annual service contracts imply recurring visits.
- L1, L3, C4, because Spanish was requested and playbook text is English-only.

**Draft lint, run by run (real output):**

1. First draft: 1 error. `match-collision`: the fragment `maintenance` is identical to one in `hvac/maintenance-tuneup`.
2. After tightening the rule to the behaviour of `findJobType`: 3 errors. The fragments `spring replacement` contain `replace` and `replacement` from `hvac/system-replacement`, and the service name "Garage door spring replacement" resolves to the HVAC job type.
3. After renaming the job to "Garage door spring repair" and its fragments to `spring repair`: 0 errors, 0 warnings. (Before run 2 the draft had also been edited by hand to avoid `tune-up`, `maintenance` and `bent panel` wording, because those words contain HVAC and electrical fragments. The linter did not report those; the unit test `fragment that contains an older trade fragment` covers the rule.)

What the run taught us: ordinary trade vocabulary ("replacement", "maintenance", "tune-up") is already claimed by HVAC. A real garage door team says "spring replacement" every day. Under today's resolver that phrase is routed to HVAC. Fixing this properly is a resolver change, not a content change (section 7).

**Evidence check:** every touchpoint claim was verified against the repository (files and substrings). See the verification report delivered with this change for the exact run.

## 7. Findings in the shipped catalog (not fixed here)

The linter was run against the three shipped playbooks, each against the playbooks before it. Seven errors surfaced. They are pre-existing, and `src/lib/newTradeChecklist.test.ts` pins them exactly, so a new defect fails the test and a fix forces the list to be updated.

| Playbook | Finding |
|---|---|
| plumbing | `water heater` contains `heater` (HVAC `furnace-no-heat`). "Water Heater Repair" resolves to `hvac/furnace-no-heat` |
| plumbing | `install` is identical to the HVAC `system-replacement` fragment. "Fixture Installation (toilet / faucet)" resolves to `hvac/system-replacement` |
| electrical | `service upgrade` contains `upgrade` (HVAC `system-replacement`) |
| electrical | "Light / Ceiling Fan Installation" and "EV Charger Installation (Level 2, starting at)" resolve to `hvac/system-replacement` |

Impact (verified by reading the callers): `findJobType` feeds `buildPrior` and a second call in `firstTimeFixAutopilot.ts`, so for those seed service names the first-time-fix prior and duration come from an HVAC benchmark. `TradePlaybooksPage` is not affected because it tries the selected playbook before any other.

Options, in the order of least change: (a) rename the colliding fragments and service names in the existing playbooks (content change, bumps `catalogVersion`); (b) make `findJobType` prefer the tenant's primary playbook or compare fragment length across playbooks (code change in `firstTimeFixAutopilot.ts`, needs tests); (c) do nothing and accept that new trades must avoid generic words. This document assumes (c) until the team decides. `[DECISION]`

Other observations:

- There is no `CLAUDE.md` in the repository snapshot reviewed, so conventions here come from existing code and `docs/`.
- `roofing` is selectable in onboarding and signup, but has no playbook (row 5 in section 3).
- The playbook page and catalog content are not localized (Phase 6).
- The outcome network and the emergency network each carry their own hard-coded trade lists (rows 6 to 8).

## 8. What this document does not settle

- Whether to change the cross-trade resolver (section 7).
- A content-localization mechanism for playbooks.
- Per-market licensing facts `[COUNSEL]`, and any claim that a trade or market is "compliant".
- Real prices and benchmarks for any new trade `[VERIFY]`.
