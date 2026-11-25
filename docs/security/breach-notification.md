# Breach notification

> Status: **TEMPLATE**. Not legal advice. Every deadline and legal basis below is `TODO(counsel)`.
> Machine-readable twin: `docs/security/breach-notification-rules.json` (read by `src/lib/breachNotification.ts`).
> Owner: `TODO(owner)` (security lead). Counsel contact: `TODO(counsel)`.

## 1. Clock rules (how the calculator works)

- **Awareness** (`awareness_at`) = when Vireek has a reasonable degree of certainty a security incident compromised personal data. **Determination** (`determination_at`) = when it is confirmed as a notifiable breach. Which one starts a clock depends on the rule: `TODO(counsel)`.
- Set `awareness_at` as early as honestly possible. The database only lets it move **earlier**, never later.
- A rule with no counsel-confirmed deadline shows `unspecified`. The system never guesses a date.
- Do not wait for full facts to start the clock or to call counsel. Partial notices are allowed where the law allows: `TODO(counsel)`.

## 2. Jurisdiction matrix

Fill one row per place where affected tenants, their customers, or Vireek operate. Remove rows that do not apply (`TODO(owner)`).

| Region | Regime to confirm | Notify regulator | Notify individuals | Clock starts | Applies to Vireek as | Source |
|---|---|---|---|---|---|---|
| EU/EEA | GDPR Arts. 33-34 | TODO(counsel) | TODO(counsel) | TODO(counsel) | TODO(counsel) processor/controller | TODO(counsel) |
| UK | UK GDPR / DPA 2018 | TODO(counsel) | TODO(counsel) | TODO(counsel) | TODO(counsel) | TODO(counsel) |
| US (per state) | State breach statutes; list states in scope | TODO(counsel) | TODO(counsel) | TODO(counsel) | TODO(counsel) | TODO(counsel) |
| Canada | PIPEDA + provincial | TODO(counsel) | TODO(counsel) | TODO(counsel) | TODO(counsel) | TODO(counsel) |
| Australia | Privacy Act, notifiable data breaches | TODO(counsel) | TODO(counsel) | TODO(counsel) | TODO(counsel) | TODO(counsel) |
| Other | TODO(owner) | | | | | |

Vireek usually acts for its tenants (the contractors). Whether Vireek or the tenant must notify the regulator and individuals is a per-regime question: `TODO(counsel)`.

## 3. Customer-contract duties

Source of truth: `docs/registers/commitments.json`. **It does not exist yet** (decision D-10 in `docs/governance/decision-pack.md`). Until it does, this section is incomplete and the calculator's `customer_contract` rule stays `unspecified`.

Each register entry that carries a breach duty needs: customer, source document link, notice window and clock start, notice channel and named contact, required content, who at Vireek sends it. Contract interpretation: `TODO(counsel)`. Transcription: `TODO(owner)`.

Per incident: filter the register by affected tenants, create one `breach_notifications` row per duty (`rule_id` = a stable id you add to the rules file).

## 4. Decision tree

1. **Is there a suspected security incident touching our systems or a subprocessor's?** No → ordinary incident process. Yes → open a `breach_incident_records` row (status `assessing`), set `detected_at`.
2. **Could personal data have been accessed, lost, altered or disclosed?** Unknown → keep `assessing`, preserve logs, engage counsel. No, with evidence → status `not_a_breach`, record why. Yes → set `awareness_at`, continue.
3. **Contain.** Revoke credentials, isolate, preserve evidence. Set `contained_at`.
4. **Whose data, where?** Record `affected_tenant_count`, `jurisdictions`, `data_categories`, `affected_individuals_estimate` (counts only, no personal data).
5. **Is it a notifiable breach under any matrix row?** Counsel decides: `TODO(counsel)`. Yes → status `confirmed_breach`, set `determination_at`.
6. **Run the clocks** (`evaluateClocks`). Notify in order of earliest due date: regulators, customers under contract, individuals.
7. **Record each notice** in `breach_notifications` (one per rule; `sent_at`, channel, reference).
8. **Close** only with a postmortem reference (`postmortem_ref`).

## 5. Staff incident record (fields that drive the clock)

Table `breach_incident_records` (staff only, no delete), child table `breach_notifications`.

| Field | Meaning |
|---|---|
| `ref` | Auto `BR-YYYY-NNNNN` |
| `status` | `assessing`, `confirmed_breach`, `not_a_breach`, `closed` |
| `detected_at` | First signal |
| `awareness_at` | Clock start (awareness). Only movable earlier |
| `determination_at` | Clock start (determination). Needs `awareness_at`, not earlier than it |
| `contained_at`, `counsel_engaged_at` | Response timeline |
| `personal_data_involved` | `unknown`, `yes`, `no` |
| `jurisdictions`, `data_categories` | Free-form tags, matrix row names |
| `affected_tenant_count`, `affected_individuals_estimate` | Counts only |
| `title`, `summary` | Facts only. No names, e-mails or personal data (e-mails are rejected) |
| `breach_notifications.*` | `rule_id`, `audience`, `sent_at`, `channel`, `reference` |

## 6. Notice templates

Text in brackets is filled per incident. Legal wording: `TODO(counsel)`.

**A. Regulator notice**

> Subject: Personal data breach notification, [reference]
> Controller/processor: [TODO(owner): legal entity, address]. Contact: [TODO(owner)].
> What happened: [facts, date/time of awareness]. Data and people affected: [categories, approximate counts, regions].
> Likely consequences: [TODO(counsel)]. Measures taken and planned: [containment, remediation].
> Further information will follow: [yes/no, expected date].

**B. Customer (tenant) notice**

> Subject: Security incident affecting your Vireek account
> We became aware on [date, time, timezone] that [plain description]. Your data involved: [categories]. What we have done: [actions]. What you should do: [steps]. Your own notification duties may apply: [TODO(counsel)].
> Contact: [TODO(owner): named person, channel]. Next update by: [date].

**C. Individual notice (if Vireek must send it)**

> Subject: Notice about your personal information
> What happened, what information was involved, what we are doing, what you can do, who to contact: [TODO(counsel): required content differs per jurisdiction].

**D. Internal escalation** (security lead, founder, counsel): incident ref, `awareness_at`, `jurisdictions`, earliest due clock from the calculator, current status.

## 7. Open items

`TODO(counsel)`: all deadlines, clock starts, processor/controller roles, template wording. `TODO(owner)`: commitments register, owner names, legal entity details, regulator contact details, which regions apply.
