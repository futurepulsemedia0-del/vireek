# Decision log (ADRs)

An Architecture Decision Record (ADR) is a short, dated note that says **what we decided, why, and what evidence it rests on**. This folder is the repository's decision log. It already existed (ADR 0001 and 0002); this README and the template fill in the process around it.

> The task that created this process asked for `docs/decisions/`. The repository already records decisions in `docs/adr/` (`CONTRIBUTING.md`, `.github/pull_request_template.md` and `.github/CODEOWNERS` all point here), so a second folder would have split the log in two. If you later want the other name, move the folder and update those three files and `scripts/governance/check-adr.mjs` (`ADR_DIR`).

## When to write one

Write an ADR when a choice is hard to reverse, crosses teams, changes a data flow or a public contract, adds a vendor or sub-processor, or when someone will ask "why did we do it this way?" in six months. Do **not** write one for a bug fix, a copy change or a reversible experiment behind a flag (use the flag docs).

## How

1. Copy [`TEMPLATE.md`](TEMPLATE.md) to `NNNN-short-kebab-title.md` using the next free number.
2. Fill the front matter. Every decision links to its **evidence** in the `evidence:` list:

   | Prefix | Points to | Checked by CI |
   |---|---|---|
   | `repo:` | a file in this repository (optionally `#L10` or `#anchor`) | file must exist, must stay inside the repo |
   | `research:` | a finding, survey or session record under `docs/research/` | file must exist there |
   | `metric:` | a number and where it is measured, e.g. `metric:voice booking success rate, observability dashboard` | must be described, not just named |
   | `external:` | an `https://` source (add `[VERIFY]` until checked) | must be an https URL |
   | `assumption:` | a bet made without proof, as a full sentence | must be a sentence |

3. A decision can only be `accepted` if at least one entry is `repo:`, `research:` or `metric:`. A decision resting on `external:` and `assumption:` alone stays `proposed` or is `confidence: low`.
4. Set `review_by`. A passed date prints a warning; it does not fail CI. It is a promise to look again, not a deadline that breaks the build.
5. Run `npm run adr:check`, then open the PR. The PR template already has an ADR checkbox.

## Rules of the log

- **Append-only.** Never rewrite an accepted ADR to change its meaning. Write a new ADR, set `supersedes: [ADR-00NN]` on it and `status: superseded` plus `superseded_by: [ADR-00MM]` on the old one. Typo fixes are fine.
- **Evidence over opinion.** If the evidence is a survey, it must come from the method in [`../research/survey-method.md`](../research/survey-method.md), and the ADR cites the finding, not the raw data. Never paste personal data here.
- **No invented facts.** Unchecked vendor or platform facts are marked `[VERIFY]`; legal or compliance statements are marked `[COUNSEL]` and are not decisions until counsel has seen them.
- **Say what is unknown.** `confidence: low` is an honest, allowed answer.

## Index

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-feature-store-pilot.md) | Feature store: audit result and pilot decision | Accepted (pilot only) — legacy format |
| [0002](0002-watch-companion-apps.md) | Do not build Apple Watch / Wear OS apps now | Accepted — legacy format |
| [0003](0003-decision-log-requires-evidence-links.md) | Every decision links to evidence; CI enforces it | Proposed |

ADR 0001 and 0002 predate the front matter and are not validated (CI prints a warning for them). Other ADR-style documents live outside this folder and are not covered by the check: `docs/platform/adr-0001-infrastructure-as-code.md`, `docs/compliance/adr-0001-data-residency.md`, `docs/mobile/adr-001-mobile-architecture.md`, `docs/mobile/adr-002-sync-engine.md`. Moving them here would renumber references elsewhere, so it is a separate, deliberate task.
