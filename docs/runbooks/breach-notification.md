# Breach notification runbook

**Status: DRAFT for counsel review. Not legal advice.** Nothing below has been checked against statute or regulator text. Every legal statement is marked **[COUNSEL]** (a lawyer must decide) and/or **[VERIFY]** (a fact nobody has confirmed against a primary source). Complements `docs/runbooks/incident-response.md` (triage and containment) and the public Incident Response & Data Breach Policy (`src/lib/legalDocs/incidentResponse.ts`).

Decision owner for "is this a notifiable breach?": **TBD [COUNSEL]**. Roster and paging: see `incident-response.md` (also TBD).

## 1. When to use this runbook

Use it when a security incident may have exposed, altered or destroyed personal data or customer data that Vireek holds. Start it **in parallel** with containment, not after. The notification clock usually starts at "awareness", so the first action is to write down when that happened (section 4, step 1).

Vireek acts in two roles, and the duties differ **[COUNSEL]**:

| Role | Data | Typical first duty |
|---|---|---|
| **Processor / service provider** for its customers (tenants) | Calls, transcripts, leads, customers, jobs, payments, bank data, etc. stored per tenant | Tell the affected customer(s) promptly so they can meet their own duties |
| **Controller / business** for its own data | Account owner details, billing, team members, staff data | Vireek itself may need to notify regulators and individuals |

## 2. What Vireek has already told customers (in-repo, verified)

* `src/components/sections/GdprDpaContent.tsx` section 6: notify the controller **without undue delay, and in any case within 72 hours** of becoming aware.
* `src/components/sections/DpaContent.tsx` section 9: notify the controller **without undue delay after becoming aware of a confirmed breach**.
* `src/lib/legalDocs/incidentResponse.ts`: the customer notice describes, as far as known, the nature of the breach, the categories and approximate volume of data and people affected, likely consequences and measures taken; the customer decides about regulators and individuals.

**[COUNSEL]** Confirm which DPA version applies to which customer, and what "aware" and "confirmed" mean in practice. The stricter commitment (72 hours) is the safe planning assumption until counsel says otherwise.

## 3. Jurisdiction timeline  **[COUNSEL][VERIFY]**

> Written from general knowledge, **not** verified against statute or regulator text. Tenant country is **not stored** per tenant, so the applicable rows must be worked out by hand for each incident. Treat every deadline as "earliest possible" until counsel confirms.

| # | Jurisdiction / regime | Who notifies whom | Trigger (summary) | Timing (summary) | Status |
|---|---|---|---|---|---|
| 1 | **Contract: Vireek to customer** (DPA, see section 2) | Vireek to the customer (controller) | Awareness of a breach (GDPR DPA) / confirmed breach (standard DPA) | Without undue delay; **<= 72 h** under the GDPR DPA | In-repo text; **[COUNSEL]** |
| 2 | **EU / EEA: GDPR** (Art. 33, 34) | Processor to controller; controller to supervisory authority; controller to individuals if high risk | Personal-data breach; authority notice unless unlikely to result in a risk | Processor: without undue delay. Controller to authority: **72 h** from awareness. Individuals: without undue delay | **[COUNSEL][VERIFY]**. Lead authority depends on Vireek's EU establishment (open item L1 in `docs/compliance/gap-list.md`) |
| 3 | **United Kingdom: UK GDPR** | Same structure to the ICO | As above | **72 h** from awareness | **[COUNSEL][VERIFY]** |
| 4 | **United States: state breach laws** (50 states + DC + territories) | Usually the data owner (the customer) to individuals and, above thresholds, to a state attorney general; a service provider to the owner | Unauthorized acquisition of "personal information" as each statute defines it | Varies: "most expedient time possible" to fixed day counts; some require regulator notice by headcount thresholds | **[COUNSEL]** supply the state matrix. Do not rely on this row. Example to check: California Civ. Code 1798.82 **[VERIFY]** |
| 5 | **Canada: PIPEDA** and provincial laws (for example Quebec) | Organization to the privacy commissioner and individuals; record-keeping duty | Real risk of significant harm | "As soon as feasible" **[VERIFY]**; keep a record of every breach | **[COUNSEL][VERIFY]** |
| 6 | **Australia: Notifiable Data Breaches scheme** | Entity to the OAIC and affected individuals | Eligible data breach likely to cause serious harm | Assess promptly (a 30-day assessment window is commonly cited); notify as soon as practicable **[VERIFY]** | **[COUNSEL][VERIFY]** |
| 7 | **Payment card data** | Per acquirer / card-brand rules and the Stripe agreement | Any compromise of card data. Raw card data must not be stored by Vireek (`docs/pci-pay-by-phone.md`) | Per contract **[VERIFY]** | **[COUNSEL]** |
| 8 | **Telephony / call-record regimes** (if any apply to call logs) | Per regime | Per regime | Per regime | **[COUNSEL]** decide whether any apply |
| 9 | **Sub-processors and Vireek's own vendors** | Vireek to or from vendors | Contractual | Per each vendor contract | **[COUNSEL]** collect clauses |
| 10 | **Other markets Vireek serves** | Add a row per market | | | **[COUNSEL]** |

## 4. Procedure and clocks

1. **Write down the awareness time (T0)** in the incident record (UTC, who became aware, how). **[COUNSEL]** agrees what counts as awareness. All deadlines are tracked from T0 until counsel says otherwise.
2. **Contain and preserve evidence** (do not delete logs). See `incident-response.md`, "First 15 minutes".
3. **Define the incident window** (UTC start and end) and the **systems/tables involved**. If unsure, take the widest defensible window; narrow it later with evidence.
4. **Scope with the tool** (section 5): which tenants had which kinds of data in those tables during the window. Save the internal summary into the incident record. An **INCOMPLETE** scan is not an answer.
5. **Counsel decides** notifiability per row of section 3 and per tenant. Record the decision, who made it and when, including a decision **not** to notify.
6. **Customer notices (processor role).** Generate drafts with the tool, fill every `[TO CONFIRM]` with facts from the investigation, replace every `[COUNSEL]` with approved wording, then send through the normal support channel (the tool sends nothing). Target: inside the strictest contractual deadline (section 3, row 1).
7. **Regulator / individual notices (controller role and where Vireek must).** Prepared by counsel; the tool's internal summary supplies facts (categories, approximate counts, window) only.
8. **Update** customers as facts change. Do not state "no evidence of misuse" or similar unless the investigation supports it.
9. **Close:** post-mortem (template in `incident-response.md`), update the breach register (Canada and others require one **[VERIFY]**), file the evidence links.

## 5. The scoping tool

* Page: `/staff/breach` (staff only). API: edge function `breach-admin`. Data access: `public.breach_scan_table()` (SELECT-only, STABLE, callable by the service role only). Migration: `supabase/migrations/20290307000100_breach_scan_tool.sql`.
* Input: incident window (UTC), tables, and a mode: *records existing when the window closed* (default: what could have been exposed) or *records created inside the window*.
* Output: affected tenants, data categories per tenant and overall, rows per table, and an **incomplete** warning if any table errored or was truncated (5,000 tenants per table).
* Drafts: one customer notice per tenant plus an internal summary. **Nothing is sent.** Drafts carry visible `[COUNSEL]` / `[TO CONFIRM]` placeholders and show "complete" only when none is left (counsel approval is still required).
* Audit: every scan and render writes one `audit_log` row (window, tables, counts). It contains no tenant identities and no notice text. The tool changes no customer data.

**What the tool cannot tell you:** what the attacker actually read or took; rows deleted before the scan; rows that were only *updated* in the window; tenants whose data sits in tables outside the registry; tables with no direct tenant column (for example `sms_messages`), which need a manual query. Always say "may have been involved", never "was accessed", unless the investigation proves it.

## 6. Registry provenance

`supabase/functions/_shared/breach/registry.ts` lists the scannable tables, each with the tenant column, the time column and the data categories. Columns were read from `supabase/migrations` by static inspection; **not executed against a live database [VERIFY]**. A wrong column shows up as a per-table error and marks the scan incomplete rather than silently returning nothing. Category wording follows `docs/compliance/data-map.md` (D1 to D14) and is **not** a legal classification **[COUNSEL]**.

To add a table: confirm it has a `uuid` tenant column and a `created_at`-style timestamp, add one entry to `BREACH_TABLES`, run the breach tests, and re-check `docs/compliance/data-map.md`.

## 7. Notice content checklist (customer notice)

Nature of the incident in plain language - period (UTC) and when Vireek became aware - kinds of data and approximate volume - likely consequences - what Vireek has done - what the customer can do (review activity; rotate API keys and reconnect integrations when connection records are in scope) - the customer's own obligations **[COUNSEL]** - one named contact and the incident reference. Do **not** include other tenants' identities, raw table names or internal system details.

## 8. Rehearsal and open items

* Run a tabletop exercise against this runbook at least once before relying on it, and record the date and findings. **[COUNSEL]** to set the cadence.
* Open: decision owner and roster; state matrix; establishment and lead authority; per-tenant country/residency (not stored today); breach register location; retention of incident records; wording of every `[COUNSEL]` paragraph; notice translations (drafts are English only).
