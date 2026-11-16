# Vireek AI policy

> **Status: DRAFT. Not adopted until the policy owner approves it** (owner: `[OWNER: fill]`, approval date: `[DATE: fill]`).
> This is an internal engineering and product policy. It is **not** legal advice and makes **no claim** of certification, conformity or regulatory compliance. Items that need legal judgement are marked **[COUNSEL]**; facts not confirmed from the repository or from vendor terms are marked **[VERIFY]**.

Related: [`ai-system-register.md`](./ai-system-register.md) (generated inventory), [`../compliance/dpia-voice-ai.md`](../compliance/dpia-voice-ai.md), [`../compliance/voice-consent-and-ai-disclosure.md`](../compliance/voice-consent-and-ai-disclosure.md), [`../security/voice-incident-response.md`](../security/voice-incident-response.md).

## 1. Scope and definitions

- **AI use** = any code path that sends data to a machine-learning / generative model or speech service, or runs one in the browser. Examples in this repo: the `ai-core` gateway (`askVireekAi`, `routeChat`), direct provider calls, Vapi / ElevenLabs voice features, Web Speech API in the dashboard.
- **Call site** = one detected AI use in code. The register lists every call site; the CI gate (`npm run ai-governance:check`) fails when one is missing.
- Applies to production code, Edge Functions, the web app, and scripts that call a live model with real data. Fixtures and unit tests with mocked models are out of scope.

## 2. Register rules (enforced by CI)

1. Every AI call site must appear in `docs/ai-governance/ai-system-register.md`.
2. To add or change an AI use: implement it, run `npm run ai-governance:inventory`, review the new rows, fill **Owner** and **Review date**, replace `[VERIFY]` text you confirmed, set **Risk class** only with counsel **[COUNSEL]**, commit the register in the same pull request.
3. New provider or SDK: add it to `PROVIDERS` in `scripts/ai-governance/inventory.mjs`, otherwise the scan cannot see it. Also follow the sub-processor process (`docs/compliance/data-map.md`); changing the public list can trigger customer notice **[COUNSEL]**.
4. LLM calls from Edge Functions go through `ai-core` (`askVireekAi` / `askVireekAiStream`). Direct provider calls are existing debt tracked by `npm run check:direct-llm`; do not add new ones.
5. An exclusion (`// ai-inventory: ignore <reason>`) needs a reason, is listed in the register, and is reviewed like any other row.
6. Not detectable by the scan: AI features switched on inside a third-party product with no code here, new vendors not yet in `PROVIDERS`. These must be added by hand at review time.

## 3. Acceptable use

**Allowed by default** (still needs a register row): drafting, summarising, classifying and extracting from the tenant's own data for that tenant; knowledge-base answers limited to approved content; transcription and call analysis where the required notices and consents are in place **[COUNSEL]**.

**Requires explicit approval from the policy owner before release:**
- Any use that sends a new class of personal data to a model (voice audio, images of people or homes, payment or banking data, children's data).
- Voice cloning or any voice-biometric-adjacent feature (consent, retention and deletion path required; see the DPIA draft) **[COUNSEL]**.
- Outbound customer contact initiated by AI (calls, SMS, email) beyond the existing governed path.
- Any use whose output could affect pricing offered to a person, access to a service, employment or payroll **[COUNSEL]**.

**Not allowed:**
- Sending secrets, credentials, full card numbers or government ID numbers to a model or putting them in prompts.
- Letting a model generate or execute SQL, or act with service-role credentials (the existing `ai-assistant-query` design is the reference: the model only classifies / phrases, code fetches the data).
- Using one tenant's data in another tenant's prompt, retrieval index or fine-tune. Tenant scoping (`accountOwnerId`, RLS) applies to everything built into a prompt.
- Telling a person they are speaking to a human when asked directly (already a non-negotiable in the `ai-core` identity prompt).
- Using customer data to train or fine-tune models, by Vireek or by a vendor, unless approved, disclosed and contractually confirmed **[COUNSEL] [VERIFY]** (vendor retention and training terms are not verified in this repository).
- Emotion or sentiment profiling of individuals beyond the existing call-quality scoring without a DPIA update **[COUNSEL]**.

## 4. Human oversight

- **AI proposes, people or governed code dispose.** Model output is treated as untrusted input: validated, schema-checked, and never executed as instructions. `ai-core` runs input and output guardrails; keep every new task behind them.
- **Customer-facing or money-moving side effects** (SMS, calls, payments, refunds) must use the governed path (`authorizeAgentAction` / `runTool` / `runPlan`), enforced by `npm run check:agent-governance`. Exemptions need a written reason.
- **Drafts for people to send** stay drafts (for example `dm-suggest` never sends). A human sees and approves before anything leaves the system, unless the feature is an approved autonomous workflow with its own limits and audit trail.
- **Disclosure:** callers must be told they are speaking to AI. Use the `ai-disclosure` ledger and drift scan; wording and jurisdictional rules are **[COUNSEL]**.
- **Low confidence or missing data:** features return a holding or "I don't know" answer and hand off to a person rather than guess (see the epistemic-boundary module).
- **Stop switch:** every AI feature must be switchable off per tenant or globally without a deploy (feature flag / kill switch; drill workflow `kill-switch-drill.yml`). Scope of the existing switches per feature: **[VERIFY]**.
- **Review of outcomes:** owners sample outputs (call-quality review, eval harnesses, red-team suites) and record problems as incidents (section 6).

## 5. Review cadence

| Trigger | What happens | Who |
| --- | --- | --- |
| Every register row | Re-confirm purpose, data seen, provider, owner; update **Review date** (`YYYY-MM-DD`). Proposed maximum interval: **6 months** (CI warns after 183 days) **[COUNSEL / management to confirm]** | Row owner |
| Material change (new provider or model, new data class, new task or prompt that changes what data is sent, new region) | Update the row before release; re-check risk class and sub-processor list | Row owner + policy owner |
| Quarterly | Walk the whole register: unowned rows, placeholders, stale rows, exclusions | Policy owner |
| After any AI incident | Review the affected rows within 10 working days (proposed) | Row owner |
| Vendor terms change | Re-check retention, training and region statements **[VERIFY]** | Policy owner + counsel |

Once all placeholders are filled, switch the CI step to `ai-governance:check -- --strict` so stale rows, an out-of-date register and overdue reviews also fail the build.

## 6. Incidents

Wrong, harmful or leaked AI output, a mis-disclosed AI call, or unexpected data going to a provider is an incident. Follow `docs/security/voice-incident-response.md` for voice, and the general incident runbooks for everything else. Record the affected register rows.

## 7. Roles

- **Policy owner:** `[OWNER: fill]` approves this policy and risk classes with counsel.
- **Row owner:** named per system in the register; keeps the row accurate.
- **Counsel:** classifies risk and reviews consent, disclosure and transfer wording **[COUNSEL]**.

## 8. Open items

| # | Item | Tag |
| --- | --- | --- |
| 1 | Risk class for each system (the register leaves it as `[COUNSEL]`) | [COUNSEL] |
| 2 | Whether and how EU / other AI-specific regulation applies to Vireek's roles (provider vs. deployer) | [COUNSEL] |
| 3 | Vendor data-retention and no-training terms per provider | [VERIFY] |
| 4 | Scope of existing kill switches per AI feature | [VERIFY] |
| 5 | Owners for all register rows and the policy owner | fill in |
| 6 | Final review interval (proposed: 6 months) | [COUNSEL] |
