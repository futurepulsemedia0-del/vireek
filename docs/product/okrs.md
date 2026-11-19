# Goals → key results → bets → shipped features

> Human-readable twin of [`okrs.json`](okrs.json). The JSON is what `npm run product:trace` checks; keep the two in sync.
> **Status: placeholders only.** No goal below has been decided. Replace every `TODO`.

## Why this exists

Vireek ships hundreds of routes and edge functions. This file ties them back to a goal so that two questions always have an answer:

1. **Which shipped features serve no goal?** (candidates to link, exempt, or retire)
2. **Which goals have no shipped work?** (candidates to start, re-scope, or drop)

## Structure

```
goal            outcome the company wants (not a feature)
└─ key result   measurable result for that goal: metric, baseline, target, unit, source of the number
└─ bet          initiative we think moves the key results
   └─ shipped   routes / edge functions that exist in the repo because of this bet
```

## Goals (fill in)

| ID | Goal | Owner | Status |
|---|---|---|---|
| G1 | TODO: goal 1 (outcome, not a feature) | TODO | placeholder |
| G2 | TODO: goal 2 | TODO | placeholder |

### G1 — TODO

| Key result | Metric | Baseline | Target | Unit | Source of the number |
|---|---|---|---|---|---|
| G1-KR1 | TODO | TODO | TODO | TODO | TODO |

| Bet | Status | Shipped (routes / functions) |
|---|---|---|
| G1-B1 TODO | proposed | — |

### G2 — TODO

| Key result | Metric | Baseline | Target | Unit | Source of the number |
|---|---|---|---|---|---|
| G2-KR1 | TODO | TODO | TODO | TODO | TODO |

| Bet | Status | Shipped (routes / functions) |
|---|---|---|
| G2-B1 TODO | proposed | — |

## Editing `okrs.json`

| Field | Rule |
|---|---|
| `schemaVersion` | Must be `1`. |
| `goals[].id`, `keyResults[].id`, `bets[].id` | Unique across the whole file; letters, digits, `.`, `_`, `-`. |
| `goals[].status` | `placeholder`, `active`, `achieved`, `dropped`. Use `placeholder` until the goal is real. |
| `bets[].status` | `proposed`, `in-progress`, `shipped`, `dropped`. |
| `bets[].shipped` | List of refs (below). Empty is fine for a bet that has not shipped. |
| `exempt` | `{ "ref": "...", "reason": "..." }` for features that legitimately serve no goal (login, legal pages, health checks). A reason is required. |

**Refs.** `route:/dashboard/jobs` matches one route exactly, exactly as written in the route table (for example `route:/dashboard/jobs/:id`). `fn:voice-call` matches the folder `supabase/functions/voice-call`. `*` matches any characters: `route:/dashboard/jobs*` links the page and everything under it, `fn:voice-*` links a function family. A ref that matches nothing is an error, so renamed or deleted features surface immediately.

A feature may serve more than one goal; this is reported as info, not an error.

## What the check reads

- **Routes**: `<Route path>` entries in `src/App.tsx` and `src/routes/groups/*Routes.tsx` (see [ROUTES.md](../ROUTES.md) for the route map). Redirect-only routes and the catch-all `*` are not counted. Routes declared with a `ROUTES.*` constant are not resolved; the report prints how many were skipped.
- **Edge functions**: every folder in `supabase/functions` except those starting with `_`.

This is a static source scan. It shows that a route or function exists in source, not that it works or that anyone uses it.

## Running it

```bash
npm run product:trace                    # report only, always exit 0
npm run product:trace -- --check         # exit 1 on structural errors (dangling refs, duplicate ids, bad enums)
npm run product:trace -- --strict        # also exit 1 on orphan features, goals with no shipped work, placeholder goals
npm run product:trace -- --update-baseline   # accept today's orphan features into okrs.baseline.json
npm run product:trace -- --json          # machine-readable
npm run product:trace -- --all           # do not truncate lists (default 40)
npm run test:scripts:product             # unit tests (no database, no network)
```

Exit codes: `0` ok, `1` gate failed (`--check` / `--strict` only), `2` usage error or unreadable `okrs.json`.

## Suggested rollout

1. Fill in real goals and key results. Leave `shipped` empty at first.
2. Link bets to the routes and functions that exist, using `*` families rather than listing hundreds of entries.
3. Add `exempt` entries (each with a reason) for the platform shell.
4. When the orphan list is too long to link at once, run `--update-baseline`. This writes `docs/product/okrs.baseline.json`. From then on `--strict` is a ratchet: only **new** orphan features fail, and baseline entries that have since been linked, exempted or deleted also fail until you refresh the file, so the list only shrinks. Review the baseline diff in code review like any other change.
5. Add `npm run product:trace -- --check` to CI once the file is real. Use `--strict` once the goals are real (it still fails on placeholders and goals with no shipped work). It is not wired into any workflow by default, because `--strict` fails while the file holds placeholders.
