# User research program — technician field flows

Owner: Product / Design research. Status: **template stage — no research has been run yet.**

This folder holds the materials to run and record usability research with field technicians on the mobile `/tech/*` flows. It contains **no findings**. Every findings table is intentionally empty until a real session produces evidence.

| Document | Use it to |
|---|---|
| [RESEARCH_PROTOCOL.md](RESEARCH_PROTOCOL.md) | Decide what we are trying to learn, who to recruit, how to run, analyse and report |
| [CONSENT_FORM_TEMPLATE.md](CONSENT_FORM_TEMPLATE.md) | Obtain informed consent (written or verbal). **Needs legal review `[COUNSEL]` before first use** |
| [FIELD_USABILITY_TEST_SCRIPT.md](FIELD_USABILITY_TEST_SCRIPT.md) | Facilitate sessions under gloves, glare, a noisy truck and weak signal |
| [FINDINGS_REPOSITORY_TEMPLATE.md](FINDINGS_REPOSITORY_TEMPLATE.md) | Record sessions, findings and hypotheses with evidence and severity |
| [`../../e2e/tech-field-conditions.spec.ts`](../../e2e/tech-field-conditions.spec.ts) | Automated **proxy** check of core technician flows under throttled network and CPU |

## What the automated test can and cannot tell us

It runs in Chromium with CPU throttling, bandwidth/latency throttling of the app's own assets, and a mocked API that is slow, fails or drops. It can catch regressions such as a missing loading/error state, a lost typed note, or a too-small primary button. It **cannot** tell us whether a technician can hit a button with a work glove, read the screen in sun, hear a prompt in a running truck, or understand the wording. Only the field sessions do that. Never cite the proxy test as user evidence.

Run it: `npx playwright test e2e/tech-field-conditions.spec.ts --project=chromium`

## Conventions

- Participants are `P01`, `P02`… Never put names, phone numbers, employers, customer names or addresses in this repository.
- Raw recordings and the consent/ID key live **outside** the repository in the access-controlled store named in the protocol. `[COUNSEL]` confirms retention and location.
- Facts about regulations, vendors or device behaviour that have not been checked are marked `[VERIFY]`. Legal wording is marked `[COUNSEL]`.
- Hypotheses written from reading code are labelled **hypothesis** and must not be reported as findings until observed in a session.
