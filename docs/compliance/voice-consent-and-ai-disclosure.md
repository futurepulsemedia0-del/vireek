# Voice: recording consent + AI disclosure by region

> DRAFT scripts and a research summary. **Not legal advice; every rule below is a starting hypothesis for counsel.** All translations need review by a native speaker and a local lawyer before use.

## 1. Design (what the product must support)
* Consent/disclosure profile is chosen by the **business location the call serves** (and, where law keys on the caller, the caller's country/state), not only the caller's area code as today.
* Profile fields: `ai_disclosure_text[lang]`, `recording_mode` = `off | notice | opt_in | opt_in_strict`, `consent_text[lang]`, `decline_behavior` (continue without recording / transfer to human), `legal_review_status`.
* Order: **(1) AI disclosure -> (2) recording notice or consent question -> (3) only then start recording/transcription.** If the provider cannot start recording after consent, `opt_in_strict` profiles must stay disabled (**TO CONFIRM with Vapi**).
* Every outcome goes into the existing AI Disclosure Proof Ledger (`call_ai_disclosures`) plus a recording-consent outcome record.

## 2. Starting hypotheses by jurisdiction (verify all)
| Region | Recording hypothesis | Default `recording_mode` |
| --- | --- | --- |
| Germany | Recording the spoken word without consent is a criminal offence (StGB s.201); also GDPR basis needed. Treat as explicit opt-in before recording. | `opt_in_strict` |
| Other EU | Highly varied; GDPR transparency + basis; many states stricter than "notice". | `opt_in` until counsel clears a state |
| UK | Business-call recording is permitted for defined purposes with notice (Lawful Business Practice regs) plus UK GDPR transparency. | `notice` (counsel to confirm) |
| Canada | Federal one-party rule in criminal law, but privacy statutes (PIPEDA, Quebec Law 25) require notice/consent for collection. | `notice` + opt-out; Quebec `opt_in` |
| Australia | State/territory surveillance-device laws differ; many require consent of all parties. | `opt_in` |
| US | Existing all-party list by area code (13 states) | keep; add business-location input |

## 3. Draft scripts
Placeholders: `[Business]`, `[Purpose]`.

**en-GB (notice)** - "Hello, you've reached [Business]. I'm an AI voice assistant, not a person. This call is recorded and transcribed for [Purpose]. Say 'no recording' if you'd rather we didn't, or ask for a person at any time."

**en-AU / en-CA (opt-in)** - "Hello, this is [Business]'s AI voice assistant - I'm not a person. May I record and transcribe this call for [Purpose]? Please say yes or no. You can ask for a person at any time."

**de-DE (opt-in strict)** - "Guten Tag, Sie sind mit dem digitalen Sprachassistenten von [Business] verbunden. Ich bin eine KI und kein Mensch. Dürfen wir dieses Gespräch zu [Purpose] aufzeichnen und transkribieren? Bitte antworten Sie mit Ja oder Nein. Sie können jederzeit darum bitten, mit einer Person zu sprechen."
Decline: "In Ordnung, ich zeichne nichts auf. Wie kann ich Ihnen helfen?"

**fr-FR / fr-CA (opt-in)** - "Bonjour, vous êtes en ligne avec l'assistant vocal de [Business]. Je suis une intelligence artificielle, pas une personne. Acceptez-vous que cet appel soit enregistré et transcrit pour [Purpose] ? Répondez par oui ou par non. Vous pouvez demander à parler à une personne à tout moment."
Decline: "Très bien, je n'enregistre pas cet appel."

**es (opt-in)** - "Hola, le atiende el asistente de voz con inteligencia artificial de [Business]; no soy una persona. ¿Nos permite grabar y transcribir esta llamada para [Purpose]? Responda sí o no. Puede pedir hablar con una persona en cualquier momento."
Decline: "De acuerdo, no grabaré la llamada."

Other supported languages (zh, hi, ar, fa, ja): AI-disclosure sentence already exists in `BUILTIN_DISCLOSURES`; add consent sentences only after a market decision.

## 4. EU AI Act - what applies (researched 2026-11-02; **needs counsel**)
Sources: European Commission, "Transparency obligations under Article 50 of the AI Act" (digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act); Cooley, "Digital AI Omnibus Delays Key Deadlines" (cdp.cooley.com); Morgan Lewis, "EU AI Act's Transparency Rules: What Went Into Effect on 2 August?" (morganlewis.com); ActuIA status note of 6 Oct 2026 (actuia.com). Secondary sources summarise the law - read the Regulation text and the Commission's final Article 50 guidelines before relying on this.

| Item | What the sources say | Vireek relevance |
| --- | --- | --- |
| Art. 50 general date | Applies from **2 Aug 2026**; Digital Omnibus on AI (Reg. (EU) 2026/1744, in force 27 Jul 2026) did not move it | In force now |
| Art. 50(1) interactive AI | People must be told they are interacting with AI unless obvious | **Voice assistant answering callers - directly relevant.** The disclosure ledger helps; make it default-on and non-removable for EU profiles. Role (provider vs deployer) split with the customer: counsel |
| Art. 50(2) machine-readable marking of synthetic audio/text | Systems placed on the market before 2 Aug 2026 have until **2 Dec 2026**; new systems from the outset | Synthetic speech output and voice cloning. Depends on TTS vendor capabilities and who is "provider" - counsel + vendor questionnaire |
| Art. 50(3) emotion recognition / biometric categorisation | Deployer must inform exposed persons | Check whether any sentiment/score feature infers emotion from **voice**; text-only sentiment may differ - counsel |
| Art. 50(4) deepfakes | Deployer must disclose | `clone-voice` output used in calls |
| Art. 5(1)(f) | Emotion inference in workplace prohibited (in force since Feb 2025) | Technician/CSR coaching analytics must not infer emotion from voice |
| Annex III high-risk | Moved to 2 Dec 2027 | Probably not triggered; confirm no employment-management use |
| Fines | Up to EUR 15M or 3% for transparency breaches (per ActuIA summary) | - |
| Commission Code of Practice on marking/labelling | Adequacy concluded July 2026 (per Jones Walker summary) | Monitor |

## 5. Engineering items this implies (not yet built)
Region/profile table + resolver (extend `recordingConsent.ts`, do not create a parallel module); consent outcome ledger; provider recording gating; tests per profile; UI in business settings with `legal_review_status` banner.
