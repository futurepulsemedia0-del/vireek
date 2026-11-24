# Trademark clearance checklist (by market)

Status: DRAFT working checklist. Not legal advice. Searches show what is easy to find, not what is safe to use: **a clean search is never proof of availability, and no mark is "cleared" until counsel has given a dated written opinion.** Every legal step is **[COUNSEL]**. Statements about how a market's system works are **[VERIFY]** against the office's own current guidance before you rely on them; they are orientation, not law.

Applies to any new or changed word mark, logo, product or module name, tagline, or sub-brand, and to entering a market with an existing mark. It extends the naming gate in `docs/brand/BRAND_ARCHITECTURE.md` §5 (which holds the generic seven checks) with market-specific steps and a record. Public usage rules: `/trademark-policy` (`src/pages/TrademarkPolicyPage.tsx`). Brand ownership: `BRAND_GOVERNANCE.md` §1.

## 1. Current position (from the repository, not from any register)

| Item | What the repository says | Status |
| --- | --- | --- |
| Vireek word mark | `src/lib/brand/brandConfig.ts` sets `registered: false` and renders the ™ symbol; its comment forbids ® until a registration exists | Unregistered use. Filings, if any, are unknown to engineering **[VERIFY]** |
| Logo | Brand assets in `src/components/brand/` and `public/` | No filing known **[VERIFY]** |
| Owner entity | `src/lib/legalEntity.ts` and `docs/brand/06-entity-dependency-audit.md` discuss the legal entity; the entity that would own the marks is not confirmed here | **[COUNSEL] [VERIFY]** |
| Module and product names | Listed in `docs/brand/01-brand-surface-audit.md` | No clearance record in `docs/ip/` yet |
| Third-party marks shown on site (integration logos, provider names) | Governed by the trademark policy page; nominative use only | Counsel reviews the policy wording **[COUNSEL]** |

Rule that already exists and stays: use ™ until counsel confirms a registration in that market; never use ® otherwise.

## 2. Process (one record per mark per market)

Run the steps in order. Stop and escalate on any "stop" item. Keep evidence (screenshots with date and query, export files) in the private IP folder, not in `docs/`.

### Step 0: Define the mark and the use
- [ ] Exact form: word, logo (attach artwork), slogan; spelling and diacritics; any stylisation.
- [ ] Intended goods and services in plain words, and the Nice classes you think apply. The repository's naming gate lists classes 9, 35, 36, 42 and 44; counsel confirms the list and decides whether other classes (for example telecommunications for voice) belong. **[COUNSEL] [VERIFY]**
- [ ] Markets where it is used today and markets planned in the next 24 months **[VERIFY: planning horizon is an internal choice]**.
- [ ] Who will own the mark (legal entity) and who will use it (affiliates, licensees, resellers).
- [ ] Languages: meaning, pronunciation and connotation in each target language (`BRAND_ARCHITECTURE.md` §5 item 4).

### Step 1: Internal screen
- [ ] Search the repository, `docs/brand/01-brand-surface-audit.md`, and the module list for similar existing Vireek names.
- [ ] Confidence check against Vireek's own marks and modules (reviewer: Brand owner).
- [ ] Domain and social handles: record availability only; availability is not a rights signal.
- Stop if: the name is generic or purely descriptive for the service in an obvious way, or contains a third party's mark. **[COUNSEL]**

### Step 2: Knockout search (identical and near-identical)
For each target market use the office's own database plus an international source, and record query, date, filters, and result count even when zero. Search the exact mark, plausible misspellings, phonetic equivalents, translations and transliterations, and the logo's elements if it has any.
- [ ] Official register(s) for the market (table in section 3).
- [ ] International: WIPO Global Brand Database (includes Madrid designations) and TMview **[VERIFY]** which offices each currently covers.
- [ ] Unregistered use: general web, app stores, business registers, domain registries, major marketplaces. Unregistered rights can matter in some markets **[COUNSEL]**.
- [ ] Class coverage: search the mark in the intended classes and in classes counsel treats as related.
- Result: list every hit that looks confusingly close, with owner, status (live, pending, expired, cancelled), classes and goods. Do not classify hits as conflicts yourself.

### Step 3: Counsel review and written opinion
- [ ] Send the Step 0 definition and Step 2 evidence to counsel.
- [ ] Counsel records: a dated written opinion per market, scope of searches reviewed, residual risk, and a recommendation (proceed, modify, abandon, seek consent or coexistence). **[COUNSEL]**
- [ ] A change of name, logo or goods after the opinion restarts Step 2 for the change.

### Step 4: Decide filing and use
- [ ] Filing plan per market: file now, file later, rely on use for now. Counsel advises on route (national, regional, Madrid), classes, timing and whether to claim priority from an earlier filing. **[COUNSEL]**
- [ ] Owner entity confirmed and consistent with the entity named in contracts, privacy policy and app-store listings. **[COUNSEL] [VERIFY]**
- [ ] Evidence of use kept from the first public use in each market (dated screenshots, invoices, release notes), in case use matters for rights or for a use requirement. **[VERIFY]**
- [ ] Until registered: ™ only. After registration in that market: counsel confirms, then update `brandConfig.ts` market-by-market only if the product supports market-specific symbols; otherwise keep ™. **[COUNSEL]**

### Step 5: After launch
- [ ] Watch service or recurring manual search for the mark in each filed market and key classes. See `04-competitor-ip-monitoring.md` §4.
- [ ] Record deadlines counsel gives (office actions, publication, opposition, renewal, use declarations). The repository does not know them; do not store invented dates. **[COUNSEL]**
- [ ] Revisit the record when entering a new market, adding goods or services, changing owner entity, or rebranding.

## 3. Market table

Offices and databases are the ones most likely to matter for the markets that appear in the repository's regional configuration (`src/lib/regionConfig/`, `src/lib/regionalPacks/`): United States, Canada, United Kingdom, Germany and the wider EU, Australia. Confirm the current list of live markets before using this table. **[VERIFY]**

Orientation notes are shorthand to prompt the right question for counsel. They are **[VERIFY]** and are not guidance.

| Market | Primary register to search | Add also | Questions to put to counsel |
| --- | --- | --- | --- |
| United States | USPTO trademark search system **[VERIFY: current name of the search tool]** | State registers; common-law use (web, app stores, business names) | Use in commerce vs intent-to-use filing; handling of descriptive terms; specimen requirements; whether state-level or common-law prior users change the risk |
| European Union (all member states, single filing) | EUIPO eSearch plus **[VERIFY]** | TMview; national registers of the markets that matter most | One refusal in a part of the EU can affect a unitary filing; whether a unitary filing or national filings fit the plan; translation checks across EU languages |
| Germany | DPMAregister **[VERIFY]** | TMview; EUIPO for EU marks that also cover Germany | Whether a national filing adds anything over an EU filing; business-name and title protection questions that can arise alongside marks |
| United Kingdom | UKIPO trade mark search **[VERIFY]** | WIPO Global Brand Database; Companies House names | The UK is separate from the EU for trademarks; treatment of former EU rights **[COUNSEL]** |
| Canada | CIPO Canadian Trademarks Database **[VERIFY]** | Business registers; web and app stores | Rules on use and registration, and the effect of the filing basis chosen; bilingual (English and French) conflicts |
| Australia | IP Australia trade mark search **[VERIFY]** | WIPO Global Brand Database; ABN and business names | How similarity is assessed; whether to file before launch |
| Any other market (add a row before entering it) | The national office's own database | WIPO Global Brand Database; Madrid Monitor | Whether the market is first-to-file or use-based; local agent requirements; language and script checks |

Markets that appear in the regional packs but are not in the table (for example France, Netherlands, Ireland, Japan) are either covered through the EU row or need their own row before launch. **[VERIFY]**

## 4. Record to complete for each mark and market

Copy into the private IP folder, one per mark per market:

```markdown
# Trademark clearance record: <mark> / <market>
- Mark (form, artwork id):                          - Date opened:
- Owner entity (confirmed by counsel? y/n):        - Brand owner:
- Goods and services (plain words) and classes:
- Searches run (register, query, date, filters, result count): attach exports
- Hits needing counsel review (owner, status, classes, goods):
- Counsel opinion (date, author, scope, recommendation):   [COUNSEL]
- Decision: proceed / modify / abandon / consent-coexistence     Decided by / date:
- Filing route and date (if any), reference number (from the office, never invented):
- First-use evidence kept (date, location):
- Symbol to use in this market: ™ until counsel confirms otherwise
- Next review date and trigger events:
```

## 5. Hard rules

1. No public use, domain purchase for launch, app-store listing, packaging, or paid campaign for a new name before Step 3 is complete for the launch markets. **[COUNSEL]**
2. No ® unless counsel confirms a registration in that market.
3. Never write "available", "cleared", "no conflicts" or "protected" in a document, deck, or customer reply on the strength of searches alone.
4. Never invent filing numbers, dates, classes or status. If it is not in an office record you have seen, write **[VERIFY]**.
5. A claim about trademark status on a public page goes through `docs/claims-register.json` and the Trust owner (`BRAND_GOVERNANCE.md` §1) before publication.
