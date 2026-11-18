# Regulatory calendar

<!-- GENERATED from docs/compliance/regulatory-calendar.json. Do not edit by hand: run `npm run compliance:calendar:write`. -->

> Reminder register, not legal advice. Every entry is [COUNSEL]; [VERIFY] marks unverified facts. Seeded only from laws already referenced in repo docs; absence of a law here does not mean it does not apply.

Every entry is **[COUNSEL]**: nothing here has been confirmed by a lawyer. Entries are seeded only from laws that are already referenced in repo docs (see *Sources*). `[VERIFY]` marks a fact that still needs checking. A review is overdue when `next_review` is before today; `scripts/compliance/calendar-check.mjs` and `.github/workflows/regulatory-calendar.yml` enforce that.

Entries: 30. Owners that are still `@OWNER_*` placeholders must be replaced together with CODEOWNERS.

## Privacy

| ID | Regulation | Jurisdiction | Applies to feature | Owner | Last reviewed | Next review | Flags |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `gdpr-eu` | General Data Protection Regulation (GDPR) | EU / EEA | Voice AI assistant (call data, transcripts); DPA page /gdpr-dpa; Sub-processor transfers | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `uk-gdpr` | UK GDPR | United Kingdom | Voice AI assistant (transparency, recording notice) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `gdpr-chapter-v-transfers` | International transfer mechanisms: SCCs, UK IDTA/Addendum, EU-US Data Privacy Framework | EU / UK / CH | Vireek to US sub-processors (Vapi, Gemini, Twilio, ...); DPA package | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] [VERIFY] |
| `eprivacy-ttdsg` | ePrivacy rules for cookies/analytics (TTDSG s.25 in Germany) | EU; Germany | Analytics cookies and consent engine | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `ccpa-cpra` | California Consumer Privacy Act / CPRA | US-CA | Privacy notices; Missed-call audit; Employee-monitoring notice (read-access logging) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `pipeda-quebec-law25` | PIPEDA and Quebec Law 25 | Canada; Quebec | Voice AI assistant (notice/consent); Cross-border processing in the US | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `au-privacy-act-app` | Australian Privacy Principles (APP 8, overseas disclosure) | Australia | Cross-border processing in the US | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `hipaa` | HIPAA | US | Public compliance claims (complianceStatus.ts) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `de-stgb-201-recording` | German Criminal Code s.201 (recording the spoken word) | Germany | Voice AI assistant (call recording) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `uk-lawful-business-practice` | UK Lawful Business Practice regulations (business-call recording) | United Kingdom | Voice AI assistant (call recording) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `us-call-recording-consent` | US state call-recording (all-party / two-party consent) laws | US (state by state) | Voice AI assistant (call recording); Shadow mode | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |

## AI

| ID | Regulation | Jurisdiction | Applies to feature | Owner | Last reviewed | Next review | Flags |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `eu-ai-act-art50` | EU AI Act Article 50 (transparency obligations) | EU | Voice AI assistant (AI disclosure); clone-voice / synthetic speech | @OWNER_COMPLIANCE | 2026-11-02 (engineering research (not counsel)) | 2026-12-02 | [COUNSEL] [VERIFY] |
| `eu-ai-act-art5-annex3` | EU AI Act Art. 5(1)(f) (emotion inference in the workplace) and Annex III high-risk | EU | QA / coaching analytics on callers and staff | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] [VERIFY] |
| `us-state-ai-disclosure` | US state AI / bot-disclosure laws (CA, UT, others) | US (state by state) | Voice AI assistant (AI disclosure); Missed-call audit | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] [VERIFY] |

## Accessibility

| ID | Regulation | Jurisdiction | Applies to feature | Owner | Last reviewed | Next review | Flags |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `wcag-2-2` | WCAG 2.2 (technical standard; no accessibility statute is cited in repo docs) | International (W3C) | Dashboard UI (target sizes, motion, contrast) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |

## Telecom

| ID | Regulation | Jurisdiction | Applies to feature | Owner | Last reviewed | Next review | Flags |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `us-tcpa` | Telephone Consumer Protection Act (TCPA) and FCC Feb 2024 declaratory ruling on AI voices | US | Outbound dialer; Speed-to-lead calls; SMS (sendCompliantSms) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] [VERIFY] |
| `us-dnc-registries` | US National and State Do-Not-Call registries | US | Outbound dialer (internal DNC list) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `us-can-spam` | CAN-SPAM Act | US | Follow-up emails (missed-call audit) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `ca-casl-crtc` | Canada's Anti-Spam Legislation (CASL) and CRTC rules | Canada | SMS / email consent; Speed-to-lead calls | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] [VERIFY] |
| `uk-pecr-au-spam-act` | UK PECR and Australian Spam Act (marketing consent) | United Kingdom; Australia | Marketing SMS / email (consent ledger) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `us-stir-shaken` | STIR/SHAKEN caller-ID authentication | US | Caller ID on PBX legs | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] [VERIFY] |

## Labor

| ID | Regulation | Jurisdiction | Applies to feature | Owner | Last reviewed | Next review | Flags |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `de-betrvg-87` | German Works Constitution Act (BetrVG s.87(1) no. 6, works-council co-determination) | Germany | Read-access logging (employee monitoring); Technician/CSR analytics | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `us-eeoc-ofccp-retention` | EEOC / OFCCP and state hiring-record retention | US (federal and state) | Talent Network (hiring records) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `us-fcra` | Fair Credit Reporting Act (consumer-reporting-agency risk) | US | Talent Network (worker data shared with businesses) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `us-state-wage-payment` | State wage-payment timing laws | US (state by state) | Pay & Capital (worker payouts) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |

## Financing

| ID | Regulation | Jurisdiction | Applies to feature | Owner | Last reviewed | Next review | Flags |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `us-reg-e-reg-z` | Regulation E and Regulation Z (applicability to business cards) | US | Pay & Capital (issued cards) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `us-ecoa-reg-b` | ECOA / Regulation B (fair lending, adverse-action notices) | US | Pay & Capital (capital pre-screen) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `us-money-transmitter` | State money-transmitter licensing | US (state by state) | Pay & Capital (payouts) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `us-nacha-card-network-rules` | NACHA and card-network rules (private-sector rules, not statutes) | US | Pay & Capital (payments, returns, chargebacks) | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] |
| `pci-dss` | PCI DSS (industry standard, not a statute) | Global (card networks) | Pay & Capital; Public compliance claims | @OWNER_COMPLIANCE | never | 2026-12-15 | [COUNSEL] [VERIFY] |

## Sources and notes

### `gdpr-eu`

- Source: `docs/compliance/transfers-and-contracts.md` — "Art. 27 representative"
- Note: Repo docs assume Customer = controller and Vireek = processor (Art. 28); contracting entity and Art. 27 representative are open items [COUNSEL].

### `uk-gdpr`

- Source: `docs/compliance/voice-consent-and-ai-disclosure.md` — "UK GDPR transparency"
- Note: Repo doc cites only UK GDPR transparency; no other UK statute is claimed here.

### `gdpr-chapter-v-transfers`

- Source: `docs/compliance/transfers-and-contracts.md` — "SCC Module 2"
- Note: No executed SCC annexes exist in the repo; DPF status of each vendor is [VERIFY].

### `eprivacy-ttdsg`

- Source: `docs/compliance/transfers-and-contracts.md` — "ePrivacy / TTDSG s.25 in DE"
- Note: Repo doc lists consent as the basis for analytics cookies.

### `ccpa-cpra`

- Source: `docs/compliance/missed-call-audit.md` — "CCPA/CPRA"
- Source: `docs/privacy/read-access-logging.md` — "CPRA employee-data notice"
- Note: Referenced for privacy notices and employee-data notice; thresholds and applicability not assessed.

### `pipeda-quebec-law25`

- Source: `docs/compliance/transfers-and-contracts.md` — "PIPEDA accountability principle"
- Note: Repo doc: Law 25 requires a privacy-impact assessment before communicating personal information outside Quebec [COUNSEL].

### `au-privacy-act-app`

- Source: `docs/compliance/transfers-and-contracts.md` — "APP 8"
- Note: Only APP 8 is referenced in repo docs.

### `hipaa`

- Source: `docs/compliance/PUBLIC_CLAIMS_INVENTORY.md` — "offers NO HIPAA BAA"
- Note: Tracked because public claims mention HIPAA; the platform offers no BAA per repo docs.

### `de-stgb-201-recording`

- Source: `docs/compliance/voice-consent-and-ai-disclosure.md` — "StGB s.201"
- Note: Repo doc default: opt_in_strict recording mode for Germany [COUNSEL].

### `uk-lawful-business-practice`

- Source: `docs/compliance/voice-consent-and-ai-disclosure.md` — "Lawful Business Practice regs"
- Note: Repo doc marks the UK default as notice, counsel to confirm.

### `us-call-recording-consent`

- Source: `docs/compliance/missed-call-audit.md` — "two-party-consent recording laws"
- Source: `docs/SHADOW_MODE.md` — "all-party-consent states"
- Note: Repo keeps an area-code list of 13 states, described as a heuristic and not a legal opinion [COUNSEL].

### `eu-ai-act-art50`

- Source: `docs/compliance/voice-consent-and-ai-disclosure.md` — "Transparency obligations under Article 50 of the AI Act"
- Note: Repo doc researched 2026-11-02 by engineering, not counsel. It lists 2 Dec 2026 for Art. 50(2) on systems placed on the market before 2 Aug 2026 [VERIFY].

### `eu-ai-act-art5-annex3`

- Source: `docs/compliance/voice-consent-and-ai-disclosure.md` — "Art. 5(1)(f)"
- Note: Repo doc: Annex III moved to 2 Dec 2027 per its sources [VERIFY]; confirm no employment-management use.

### `us-state-ai-disclosure`

- Source: `docs/compliance/missed-call-audit.md` — "State AI-disclosure / bot-disclosure laws"
- Note: Repo doc names CA and UT as examples; the full state list is not established [VERIFY].

### `wcag-2-2`

- Source: `docs/design/ICON_SCALE.md` — "WCAG 2.2 SC 2.5.8"
- Source: `docs/design/MOTION_POLICY.md` — "WCAG 2.2.2"
- Note: Which accessibility laws bind Vireek (for example in the EU or US) is not stated in repo docs, so none is seeded; add them once counsel confirms [COUNSEL].

### `us-tcpa`

- Source: `docs/compliance/speed-to-lead-assumptions.md` — "FCC Declaratory Ruling, Feb 2024"
- Note: Repo assumption A1 treats AI voice as an artificial/prerecorded voice; reassigned-numbers database check is not implemented [VERIFY].

### `us-dnc-registries`

- Source: `docs/compliance/speed-to-lead-assumptions.md` — "National/State DNC registry"
- Note: Repo assumption A8 only; scope of registry rules not assessed.

### `us-can-spam`

- Source: `docs/compliance/missed-call-audit.md` — "CAN-SPAM / CASL"
- Note: Repo treats the report email as transactional and follow-ups as needing separate opt-in [COUNSEL].

### `ca-casl-crtc`

- Source: `docs/compliance/speed-to-lead-assumptions.md` — "No Canadian (CRTC) rules"
- Source: `docs/compliance/missed-call-audit.md` — "CAN-SPAM / CASL"
- Note: Repo doc states no CRTC rules are implemented for auto-dialing.

### `uk-pecr-au-spam-act`

- Source: `docs/compliance/transfers-and-contracts.md` — "Consent (CASL, PECR, Spam Act)"
- Note: Only named in the lawful-basis map of the transfers doc.

### `us-stir-shaken`

- Source: `docs/security/FRAUD_ABUSE_PREVENTION.md` — "No STIR/SHAKEN work here"
- Note: Repo docs state no STIR/SHAKEN work exists; tracked so the gap is reviewed, not as a compliance claim [VERIFY].

### `de-betrvg-87`

- Source: `docs/privacy/read-access-logging.md` — "BetrVG §87(1) no. 6"
- Note: Repo doc flags employee monitoring for counsel; it does not claim compliance.

### `us-eeoc-ofccp-retention`

- Source: `docs/TALENT_NETWORK.md` — "EEOC/OFCCP and state retention periods"
- Note: Repo doc says retention periods must be confirmed.

### `us-fcra`

- Source: `docs/TALENT_NETWORK.md` — "FCRA / consumer-reporting-agency risk"
- Note: Design keeps workers in control of sharing; applicability is a counsel question.

### `us-state-wage-payment`

- Source: `docs/PAY_AND_CAPITAL.md` — "state wage-payment timing laws"
- Note: Referenced only as a payout consideration.

### `us-reg-e-reg-z`

- Source: `docs/PAY_AND_CAPITAL.md` — "Reg E/Reg Z applicability"
- Note: Repo doc: usually commercial, so applicability is [COUNSEL].

### `us-ecoa-reg-b`

- Source: `docs/PAY_AND_CAPITAL.md` — "ECOA/Reg B applies to business credit"
- Note: Repo doc: partner owns adverse-action notices; Vireek keeps pre-screen reason codes.

### `us-money-transmitter`

- Source: `docs/PAY_AND_CAPITAL.md` — "licensed money transmitter"
- Note: Repo doc relies on a licensed partner; Vireek licensing position is a counsel question.

### `us-nacha-card-network-rules`

- Source: `docs/PAY_AND_CAPITAL.md` — "NACHA/card-network rules"
- Note: Included because repo docs list them with payout obligations.

### `pci-dss`

- Source: `docs/PAY_AND_CAPITAL.md` — "PCI DSS scope kept with the issuer"
- Note: Repo docs say Vireek never stores PAN/CVV and has no PCI DSS attestation of its own [VERIFY].
