---
id: ADR-0003
title: Every decision record links to evidence, and CI checks the links
status: proposed
date: 2026-11-20
deciders: [OWNER_PLATFORM]
confidence: medium
review_by: 2027-05-20
evidence:
  - repo:docs/adr/0002-watch-companion-apps.md
  - repo:docs/adr/0001-feature-store-pilot.md
  - repo:.github/pull_request_template.md
  - repo:docs/research/FINDINGS_REPOSITORY_TEMPLATE.md
  - assumption:A decision whose evidence is one click away is cheaper to revisit than one reconstructed from memory.
supersedes: []
tags: [process, governance]
---

# ADR-0003 — Every decision record links to evidence, and CI checks the links

## Context

`docs/adr/` holds two ADRs, both written well but in free form. ADR 0002 spends a section listing what is verified in the snapshot and what is not; ADR 0001 lists the engines it audited with file names. Nothing forces a future ADR to do the same, and nothing links a decision to a research finding or a measured number. The PR template asks "ADR added/updated for a new decision" but does not check that one has the information a reviewer needs.

## Decision

We will give ADRs a fixed front matter (status, date, deciders, confidence, review date, typed evidence list) and a fixed set of sections, and we will make CI fail when a new ADR omits a required field, links to a file that does not exist, or is `accepted` with no grounded evidence. ADR 0001 and 0002 stay as they are and are reported as legacy warnings.

## Alternatives considered

| Option | Why it looked reasonable | Why it was not chosen |
|---|---|---|
| Do nothing; rely on review | No tooling to maintain | Review catches what the reviewer remembers to check; the two existing ADRs show good habits are not automatic |
| Rewrite ADR 0001 and 0002 into the new format | One consistent log | Rewrites accepted records; the log is meant to be append-only. They are grandfathered instead |
| A new `docs/decisions/` folder | Matches the task wording | `docs/adr/` is already referenced by `CONTRIBUTING.md`, the PR template and `CODEOWNERS`; a second folder splits the log |
| A heavier tool (adr-tools, a docs site plugin) | Richer features | New dependency for a check that is about a hundred lines of plain Node |

## Consequences

- **Easier:** a reviewer sees on one screen what a decision rests on and how sure the author is.
- **Harder:** writing an ADR takes a few minutes longer; an `accepted` ADR needs a real file, finding or metric to point at.
- **Committed to:** keeping `scripts/governance/check-adr.mjs` in step with the template.
- **Risk:** authors satisfy the check with a token link. The check proves the link resolves, not that it supports the claim. Reviewers still have to read the Evidence section.

## Evidence

| Evidence entry | What it shows | Strength |
|---|---|---|
| ADR 0002 | A decision recorded with a verified-facts table and explicit `[VERIFY]` marks; the target quality | Observed |
| ADR 0001 | Another ADR citing engines by file; no review date, no confidence statement | Observed |
| PR template | The only current gate is a checkbox | Observed |
| Findings repository template | Research findings already have IDs a decision can cite | Observed |
| Assumption | Cheaper revisits are the expected payoff; not measured | Assumed |

## Reopen when

The check produces repeated false failures, or ADRs are routinely accepted with token evidence. Review by 2027-05-20.
