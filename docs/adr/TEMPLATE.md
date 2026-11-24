---
id: ADR-0000
title: <short decision title, stated as the decision, not the topic>
status: proposed
date: 2000-01-01
deciders: [<role or team that owns the call, e.g. OWNER_PLATFORM>]
confidence: low
review_by: 2000-01-01
evidence:
  - repo:<path/to/file/that/shows/the-current-behaviour.ts>
  - research:docs/research/<finding-or-survey-file>.md
  - metric:<name of the number and where it is measured>
  - external:https://<source — add [VERIFY] at the end until someone has checked it>
  - assumption:<something we are betting on without proof, written as a sentence>
supersedes: []
tags: []
---

<!--
HOW TO USE THIS TEMPLATE
1. Copy to docs/adr/NNNN-short-kebab-title.md (next free number). Set `id` to ADR-NNNN.
2. Delete every evidence line you do not use. Keep at least one repo:, research: or metric:
   entry before you set status to `accepted`. `external:` and `assumption:` alone never count.
3. Replace every <placeholder>. The CI check (npm run adr:check) rejects leftovers.
4. Do not paste legal or compliance claims here. Mark them [COUNSEL]. Mark unchecked vendor
   or platform facts [VERIFY].
5. Delete this comment block.
-->

# ADR-0000 — <title>

## Context

What forces are at play? What is the situation today, in the code and for customers? Say what is verified (cite the file or the finding) and what is assumed. Keep it short enough that a new engineer understands why a decision was needed.

## Decision

One or two sentences, active voice: "We will …" or "We will not …". Then the rules that follow from it.

## Alternatives considered

| Option | Why it looked reasonable | Why it was not chosen (or was) |
|---|---|---|
| A. | | |
| B. | | |

Include "do nothing" as an option.

## Consequences

- **What gets easier:**
- **What gets harder or more expensive:**
- **What we are now committed to:**
- **Risks and how we will notice them:**

## Evidence

Explain what each `evidence:` entry in the front matter shows and how strongly. Separate what was **observed** (code, a survey, a measured number) from what was **inferred** or **assumed**. If evidence is thin, say so here and set `confidence: low`.

| Evidence entry | What it shows | Strength (observed / inferred / assumed) |
|---|---|---|
| | | |

## Reopen when

The specific facts that would change this decision (a measured threshold, a vendor change, a legal ruling). Set `review_by` in the front matter to the latest date we promise to look again.
