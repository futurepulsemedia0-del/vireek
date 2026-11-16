# Cross-tenant learning — draft terms wording

> **[COUNSEL] DRAFT. Not approved. Not legal advice.** Every sentence below is proposed product wording for counsel to accept, rewrite or reject.
> Nothing here may be shown to customers, added to `TermsContent` / `DpaContent`, or used to bump `sde_terms_version()` before counsel signs off.
> Items in **[VERIFY]** are facts about the system that must be confirmed against the live project before they are promised.

## A. Where it would live

* Customer-facing: the Service Data Exchange consent screen (per domain) and the Terms of Service / DPA section on aggregated data. **[COUNSEL]** to choose.
* Version control: any accepted change to this wording must change the consent `terms_version` so existing consents are re-requested. **[COUNSEL]**

## B. Proposed wording (plain language)

**B1. What sharing means.**
"If you turn on data sharing for a topic, Vireek uses certain business figures from your account to calculate statistics together with other participating businesses.
Those statistics are shown to participating businesses only as group results. We do not show another business your figures, and we do not show you theirs."

**B2. What we use.**
"For each topic we use only the figures listed on the sharing screen — for example, company-level rates and medians. We do not use customer names, phone numbers,
addresses, call recordings or transcripts, notes, photos, or individual employees' information for these statistics." **[VERIFY per domain; `vertical_intelligence` is call-derived and is currently switched off — do not include it until reviewed]**

**B3. Minimum group size.**
"A statistic is published only when enough businesses contribute to it. The minimum is [5] businesses for most topics [and [10] for ___]." **[COUNSEL/VERIFY: thresholds differ today — 3 (FIE, rebate, procurement), 5, 8 (pricing), 10 (voice priors, report)]**

**B4. Protection against re-identification.**
"We add small amounts of random variation to some statistics and limit how much any one business can influence a result. This reduces, but cannot eliminate, the risk that a result could be traced to one business."
**Do not say** "anonymous", "differential privacy" or "cannot be re-identified". The noise is *DP-inspired*, not a formally proven guarantee; k-anonymity is not a guarantee against differencing or small-segment attacks. **[COUNSEL]**

**B5. Your choice and how to change it.**
"Sharing is off until the account owner turns it on. Only the account owner can change it. You can turn it off for any topic at any time in [Settings → Data sharing]."

**B6. What happens when you turn it off.**
"From the next scheduled update, your figures are no longer used in new statistics for that topic. Statistics that were already calculated are replaced at the next update, normally within [24 hours] **[VERIFY schedule]**.
Results that were already **published outside Vireek** (for example a published industry report edition, or a data release already delivered to a partner) combine many businesses and cannot be recalculated without removing the whole result; they are not changed." **[COUNSEL: acceptability, and whether withdrawal from published editions must be offered]**

**B7. What you get in return.**
"Some insights are available only to businesses that share the matching topic." (give-to-get) **[COUNSEL: confirm this is a permissible condition and is not presented as a precondition of the core service]**

**B8. Who can receive results.**
"Group statistics may be shown to other participating businesses [and, for some topics, to approved partners such as equipment manufacturers, distributors or insurers (see partner list)]." **[COUNSEL/VERIFY: `failure_genome_partners`, `evidence_partners`, and the public State of Home Service Calls report are external recipients; each needs its own disclosure]**

**B9. AI processing.**
"Group statistics may be included in requests to AI providers we use to generate advice for participating businesses." **[VERIFY: `outcome-benchmark-advisor`, `causal-world-simulator`; confirm providers appear on the sub-processor list]**

**B10. Records of your choice.**
"We keep a record of when sharing was turned on or off, by whom, and which wording you accepted." **[VERIFY: SDE keeps `sde_consent_events`; legacy per-flow flags keep no history]**

## C. Items counsel must decide (cannot be resolved in code)

1. Lawful basis and roles: is Vireek a controller for derived statistics? Do aggregates of ≥ k customers count as personal data of the customers' own customers (callers, homeowners)? **[COUNSEL]**
2. Whether consent given before this change (under the opt-out defaults) can be relied on at all. The migration treats absence of an SDE consent as "no" and keeps old flags only as additional off-switches.
3. Retention of consent evidence, and treatment on account erasure.
4. Jurisdiction-specific points (EU/UK, CA, AU) and children's/employee data (technician data is excluded by design in the SDE `labor` domain — **[VERIFY]**).
5. Whether the "free" cohort comparison in the product can be conditioned on sharing (B7).
6. Wording for the three currently closed flows (`vertical_intelligence`, `causal_cohorts`, `rebate_realization`) before any are mapped to a domain.
