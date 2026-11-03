# Transfers, contracts, retention, lawful bases

> DRAFT templates for counsel. Not legal advice. Square-bracket items are decisions or facts we do not have.

## 1. Roles (to confirm)
* Customer (the home-service business) = **controller** of its callers' and customers' data; Vireek = **processor** (Art. 28). For Vireek's own account/billing/marketing data Vireek = controller.
* Sub-processors (Vapi, Gemini, Twilio, ...) = Vireek's processors.
* **Open:** which Vireek legal entity signs, and where it is established. If it is EU-established, EU customer -> Vireek is not a restricted transfer; the restricted transfers are Vireek -> US sub-processors. If it is US-established, GDPR Art. 3(2) and an Art. 27 representative may apply.

## 2. Transfer mechanism map
| Flow | Mechanism candidates | Notes |
| --- | --- | --- |
| EU/UK customer -> Vireek (if non-EU entity) | SCC Module 2 (C2P); UK IDTA or UK Addendum; or DPF if Vireek certifies | Existing `/gdpr-dpa` says SCCs "incorporated by reference" and annexes "on request" - **no executed annexes exist in repo**. Prepare Annex I (parties, processing description), II (TOMs - reuse `SOC2_READINESS.md`), III (sub-processors) |
| Vireek -> US sub-processors | DPF certification of each vendor (verify each vendor's status) else SCC Module 3 (P2P) | Keep a vendor-by-vendor evidence table |
| Canada | PIPEDA accountability principle: contractual comparable protection + notice that data may be processed in the US; Quebec Law 25 requires a privacy-impact assessment before communicating personal information outside Quebec | counsel |
| Australia | APP 8: take reasonable steps so overseas recipient complies with APPs; Vireek remains accountable | counsel |
| Germany-specific | Employee/technician data and works councils; Impressum duties | counsel |

## 3. Transfer Impact Assessment (TIA) template - one per sub-processor
1. Processor / service / data classes (link to data-map row IDs) / volumes.
2. Origin countries; destination country; onward transfers.
3. Mechanism relied on (DPF / SCC module / UK Addendum).
4. Destination-law assessment (public-authority access laws relevant to this data; vendor transparency reports).
5. Supplementary measures: encryption at rest and in transit, customer-held keys (Trust Pack envelope/KMS), pseudonymisation, retention limits, zero-retention API terms, redaction before LLM calls.
6. Residual risk rating + reviewer + date + next review (at least annually, or when the vendor's DPF status or law changes).
7. Conclusion: proceed / proceed with measures / stop.

## 4. Retention schedule (PROPOSED defaults - founder/counsel decide; per-tenant override stays in `data_retention_policies`)
Current published claim: recordings and transcripts **12 months** (`PrivacyContent.tsx` s.7). Shorter defaults are easier to defend under data minimisation.

| Class | Proposed default | Basis / note |
| --- | --- | --- |
| D1 audio | 90 days; customer may extend to 12 months | Minimisation; purpose = QA/disputes |
| D2 conversation-intel audio | existing per-setting retention; tombstone purge | already implemented |
| D3 transcripts/summaries | 12 months, then anonymise (`calls` pii columns) | matches published text |
| D4/D5 caller + customer data | life of customer relationship + [x] months | customer-controlled |
| D6 invoices / payment records | statutory (e.g. DE bookkeeping vouchers ~8 yrs, commercial letters ~6 yrs - **accountant to verify**) | legal obligation overrides erasure; restrict processing instead |
| D9 voice-clone samples | delete on consent withdrawal or account close; delete at provider too | biometric-adjacent |
| D11 consent/disclosure proof | [3-6 yrs] to defend claims | limitation periods vary - counsel |
| D12 telemetry | Sentry [90 days]; GA per consent | verify vendor settings |
| D13 audit logs | [12-24 months] | security purpose |
| Account data after cancellation | 30-day grace then delete (current DSAR grace = `DSAR_GRACE_PERIOD_DAYS`) | confirm value |

## 5. Lawful-basis map (Art. 6; Art. 9 where relevant) - starting hypotheses
| Processing | Controller | Basis | Notes |
| --- | --- | --- | --- |
| AI answers caller, takes booking | Customer | Art. 6(1)(b) steps at the request of the data subject; or 6(1)(f) | notice at call start |
| Call recording / transcript storage | Customer | **Consent** (DE: required in practice; see voice doc) or 6(1)(f) with balancing + opt-out elsewhere | per-region; most contested row |
| QA / coaching analytics on callers | Customer | 6(1)(f) or consent; **no emotion inference from voice** (AI Act Art. 5(1)(f) for workplace) | counsel |
| Marketing SMS / email | Customer | Consent (CASL, PECR, Spam Act) | consent ledger exists |
| Voice cloning of an owner/employee | Customer | Explicit consent (Art. 6(1)(a), likely Art. 9(2)(a) if used to identify) | confirm with counsel |
| Vireek account, billing, security logs | Vireek | 6(1)(b), 6(1)(c), 6(1)(f) | - |
| Analytics cookies | Vireek | Consent (ePrivacy / TTDSG s.25 in DE) | consent engine exists |

## 6. DPA package to produce (counsel to finalise)
Main DPA (Art. 28(3) terms) + Annex I-III + SCC incorporation (Modules 2/3) + UK Addendum + Swiss/Canadian/Australian riders + sub-processor change-notice procedure (already described in `DpaContent.tsx` s.5) + audit/assistance clauses + deletion/return on exit + breach notification timing.
