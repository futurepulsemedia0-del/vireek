# Public claims inventory (evidence needed)

> Generated 2026-11-03 by grep over `src/**/*.ts(x)` (tests excluded). Each line is a place where the app mentions a compliance, security or uptime term. **A mention is not necessarily a claim** (it may say "not certified" or "in progress") — review each in context. `docs/claims-register.json` has `claims: []`, i.e. no registered evidence. Per `BRAND_GOVERNANCE.md`, an entry only counts as current evidence with `evidence.url`, `evidence.owner` and an in-date `expiresAt`/`issuedAt`. Do NOT add entries without real proof.

Matches: **44**.

| File:line | Term | Context (trimmed) | Action |
|---|---|---|---|
| `src/components/sections/SecurityPrivacy.tsx:29` | End-to-End Encrypt | title: 'End-to-End Encryption', | verify wording; add evidence or remove |
| `src/components/sections/SecurityPrivacy.tsx:45` | 99.9% | body: 'Hosted on enterprise-grade cloud infrastructure, targeting 99.9% monthly uptime under our published SLA | verify wording; add evidence or remove |
| `src/components/sections/SecurityPrivacy.tsx:62` | 99.9% | { label: 'Uptime SLA', value: '99.9% Target' }, | verify wording; add evidence or remove |
| `src/components/sections/SlaContent.tsx:187` | 99.9% | <strong className="text-text-primary">99.9% monthly uptime</strong> for the | verify wording; add evidence or remove |
| `src/components/sections/SlaContent.tsx:227` | 99.9% | <li>• Below 99.9% but at or above 99.0% &mdash; 10% of that month's subscription fee</li> | verify wording; add evidence or remove |
| `src/components/sections/TrustBar.tsx:6` | End-to-End Encrypt | { icon: Lock, label: 'End-to-End Encrypted' }, | verify wording; add evidence or remove |
| `src/components/sections/TrustBar.tsx:7` | 99.9% | { icon: Server, label: '99.9% Uptime SLA' }, | verify wording; add evidence or remove |
| `src/components/sections/TrustBar.tsx:9` | Multi-Region | { icon: Globe, label: 'Multi-Region' }, | verify wording; add evidence or remove |
| `src/lib/brandFacts.ts:96` | SOC 2 | "IMPORTANT GUARDRAIL: Vireek's public Security page is deliberately written as factual statements about how th | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:4` | SOC 2 | * RULE: state only what is actually true. Today Vireek holds NO SOC 2 report, | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:5` | HIPAA | * offers NO HIPAA BAA and has NO PCI DSS attestation of its own (same position as | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:27` | soc2 | id: 'soc2' \| 'hipaa' \| 'pci'; | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:29` | SOC 2 | /** Short noun phrase used in the summary sentence, e.g. "a SOC 2 report". */ | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:44` | soc2 | id: 'soc2', | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:45` | SOC 2 | name: 'SOC 2', | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:46` | SOC 2 | heldLabel: 'a SOC 2 report', | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:50` | SOC 2 | statement: 'Vireek has not completed a SOC 2 audit and does not hold a SOC 2 report (Type I or Type II).', | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:52` | SOC 2 | 'There is no SOC 2 report to share. Your review can rely on the controls described in our security whitepaper  | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:55` | hipaa | id: 'hipaa', | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:56` | HIPAA | name: 'HIPAA', | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:57` | HIPAA | heldLabel: 'a HIPAA Business Associate Agreement', | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:58` | HIPAA | what: 'A US federal law that sets rules for protecting health information. There is no official HIPAA certific | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:61` | HIPAA | statement: 'Vireek does not claim HIPAA compliance and does not currently offer a Business Associate Agreement | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:63` | HIPAA | 'If your organization is a HIPAA covered entity or business associate, contact us before using Vireek for anyt | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:67` | PCI DSS | name: 'PCI DSS', | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:68` | PCI DSS | heldLabel: 'its own PCI DSS attestation', | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:73` | PCI DSS | 'Vireek does not hold its own PCI DSS attestation. Card payments are handled by Stripe, and Vireek does not st | verify wording; add evidence or remove |
| `src/lib/complianceStatus.ts:75` | PCI DSS | "Stripe maintains its own PCI DSS compliance; that is Stripe's attestation, not Vireek's. See the sub-processo | verify wording; add evidence or remove |
| `src/lib/evidenceRequest.ts:17` | SOC 2 | { id: 'compliance', label: 'A question about SOC 2, HIPAA or PCI DSS' }, | verify wording; add evidence or remove |
| `src/lib/evidenceRequest.ts:22` | soc2 | { id: 'soc2', label: 'SOC 2' }, | verify wording; add evidence or remove |
| `src/lib/evidenceRequest.ts:23` | hipaa | { id: 'hipaa', label: 'HIPAA' }, | verify wording; add evidence or remove |
| `src/lib/evidenceRequest.ts:24` | PCI DSS | { id: 'pci', label: 'PCI DSS' }, | verify wording; add evidence or remove |
| `src/lib/glossary.ts:722` | SOC 2 | term: 'SOC 2', | verify wording; add evidence or remove |
| `src/lib/glossary.ts:725` | SOC 2 | 'An independent audit standard that evaluates how a company protects customer data across security, availabili | verify wording; add evidence or remove |
| `src/lib/glossary.ts:750` | pci-dss | slug: 'pci-dss', | verify wording; add evidence or remove |
| `src/lib/glossary.ts:751` | PCI DSS | term: 'PCI DSS', | verify wording; add evidence or remove |
| `src/lib/outcomePricing.ts:285` | 99.99% | if (!(input.targetUptimePct >= 80 && input.targetUptimePct <= 99.99)) errors.push('Target uptime must be betwe | verify wording; add evidence or remove |
| `src/lib/securityWhitepaper.ts:9` | SOC 2 | * (SOC 2, ISO 27001, HIPAA, PCI level, ...) unless Vireek actually holds it — | verify wording; add evidence or remove |
| `src/pages/ComplianceStatusPage.tsx:34` | SOC 2 | "Vireek's current SOC 2, HIPAA and PCI DSS status, stated plainly, plus how to request security documentation  | verify wording; add evidence or remove |
| `src/pages/ComplianceStatusPage.tsx:349` | SOC 2 | Where Vireek stands on SOC 2, HIPAA and PCI. | verify wording; add evidence or remove |
| `src/pages/SecurityPage.tsx:19` | SOC 2 | // certification Vireek does not currently hold. If/when a SOC 2 report, | verify wording; add evidence or remove |
| `src/pages/SecurityPage.tsx:20` | HIPAA | // HIPAA BAA, etc. is obtained, add it explicitly here — don't imply one | verify wording; add evidence or remove |
| `src/pages/TrustCenterPage.tsx:26` | SOC 2 | // "SOC 2 certified", "HIPAA compliant", or similar badge unless that | verify wording; add evidence or remove |
| `src/pages/TrustCenterPage.tsx:379` | SOC 2 | SOC 2 report) here as soon as they&rsquo;re formally completed &mdash; if your business | verify wording; add evidence or remove |
