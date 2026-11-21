# Claims substantiation gate

> Owner: Compliance owner (role). Code: `scripts/claims-gate/`. Register: `docs/claims-register.json` (CODEOWNERS: `@OWNER_COMPLIANCE`).
> This gate checks that evidence is **on file and in date**. It does not and cannot check that the evidence is **true**. A named human owner does that. **[VERIFY]** each evidence link yourself before adding it.

## What it does

`npm run claims:gate` scans public copy and AI marketing outputs for **numeric** and **comparative** claims and fails CI when a claim:

| Code | Meaning |
|---|---|
| `unmapped` | No register entry (or exemption) covers this exact wording |
| `incomplete-evidence` | The entry exists but lacks an `https` evidence URL, an owner, a valid `issuedAt`/`expiresAt`, or its window exceeds 540 days |
| `expired` | The entry's `evidence.expiresAt` is today or earlier |
| register error | The register file itself is malformed (always fails, even if nothing uses the entry) |

It runs next to the existing `npm run claims:check`, which handles certification, SLA and uptime **wording** against `src/lib/trust/claims.ts`. The two checks overlap on figures such as "99.9% uptime": `claims:check` decides whether the wording may be stated as fact, `claims:gate` decides whether a number has dated evidence. Both must pass.

## What counts as a claim

Patterns live in `scripts/claims-gate/detect.mjs`:

- **numeric:** percentages, multipliers (`3x`), social proof (`trusted by 500 contractors`, `answered 47 calls`), savings (`save up to 10 hours`), speed (`answers in under 2 seconds`), ratios (`7 in 10 calls`), ratings (`4.8/5`).
- **comparative:** `faster/cheaper/better than`, `costs less than`, `outperforms`, `#1`, `the most accurate AI…`, `top-rated`, `industry-leading`, `world's best`.

CSS values, Tailwind class lists, code comments, code fences and tag/script/style content are ignored.

## Where it looks

Defined in `scripts/claims-gate/sources.mjs`; print the live list with `node scripts/claims-gate/check-claims-gate.mjs --list-sources`.

- **Public copy:** component files of every public route (found from `src/App.tsx` and `STATIC_PUBLIC_PATHS` in `scripts/seo/routes.mjs`), `src/components/{sections,home,marketing,trust}`, the data modules behind public pages (`src/lib/industries.ts`, `competitors.ts`, `alternatives.ts`, `integrations.ts`, `switchGuides.ts`, `useCases.ts`, `resources.ts`, `helpArticles.ts`, `customerStories.ts`, `homeContent.ts`, `brandFacts.ts`), `content/blog/*.md` (drafts included), `public/llms.txt`, `public/llms-full.txt`, `index.html`.
- **AI marketing outputs:** every file under `eval/marketing-outputs/` (put any AI-written marketing sample you want gated there; the folder does not exist yet) and the public assistant's approved answers `eval/site-assistant.manual.json`, `eval/site-assistant.generated.json`.

### What this does not catch

- Text generated at runtime for a tenant (`marketing-creative-generate`). Its own review-before-publish warnings (`claimWarnings` in `supabase/functions/_shared/marketing-creative/engine.ts`) remain the control there. Extending them is a separate change.
- Translations and i18n namespaces under `src/locales/`.
- Components imported by a public page from folders other than the four above.
- Claims phrased outside the patterns (for example "never misses a call" is a hygiene problem handled by `scripts/brand-audit/checks/trust.mjs`, not by this gate).
- Claims in images, video or PDFs.
- Two public routes the page discovery could not resolve in the inspected snapshot: `/features/live-escalation` and `/locations/:slug`.

## Register format

`docs/claims-register.json` keeps its existing shape (the brand audit still reads it) and gains an optional `exemptions` array.

```json
{
  "version": 1,
  "claims": [
    {
      "id": "stat.example-id",
      "claim": "the exact wording as it appears in the copy",
      "match": ["optional other exact wordings that carry the same number"],
      "file": "optional: limit this entry to one file",
      "evidence": {
        "type": "report",
        "url": "https://…",
        "owner": "person or role accountable",
        "issuedAt": "YYYY-MM-DD",
        "expiresAt": "YYYY-MM-DD"
      }
    }
  ],
  "exemptions": [
    {
      "id": "ex.example-id",
      "match": ["exact wording that looks like a claim but is not one"],
      "reason": "why it is not a claim (15+ characters)",
      "owner": "who approved the exemption"
    }
  ]
}
```

How an entry covers a claim: the entry's `claim` (or a `match` phrase) must appear in the same sentence area as the detected figure **and contain that figure**. So an entry for "40% more booked jobs" does not cover "45% more booked jobs", and changing the wording forces a re-check. Matching ignores case, markup and spacing.

Rules:

1. `evidence.url` is an absolute `https://` link. Internal paths do not count as evidence.
2. `issuedAt` is today or earlier. `expiresAt` is after `issuedAt` and at most 540 days later (the same 18-month ceiling the brand audit uses).
3. An entry stops covering copy **on** its `expiresAt` date (00:00 UTC), the same boundary as the brand audit.
4. Never add an entry without real proof. Fix the copy instead. An empty register is correct today.
5. Exemptions are for figures that are not performance or competitive claims (for example plan-limit thresholds, or an illustrative worked example the page labels as illustrative). Each is reported in the run output and reviewed through CODEOWNERS.
6. A run warns, without failing, when evidence expires within 30 days and when an entry matches no copy.

## Fixing a failure

| You see | Do this |
|---|---|
| `unmapped` | Prefer rewording to a statement you can prove, or removing the number. Otherwise obtain the proof, then add an entry. If it is not a claim, add an exemption with a reason |
| `expired` | Re-confirm the evidence with its owner, then update `issuedAt`/`expiresAt`. If it cannot be re-confirmed, remove the claim from the copy |
| `incomplete-evidence` | Complete the named field |

## Commands

```
npm run claims:gate                      # the CI check
npm run test:scripts:claims-gate         # unit tests of the gate itself
node scripts/claims-gate/check-claims-gate.mjs --json          # machine-readable result
node scripts/claims-gate/check-claims-gate.mjs --now 2027-01-01  # preview what expires by a date
```

## Rollout note

On the inspected snapshot the register is empty, so the gate reports every existing figure as `unmapped` (50 detections across 226 public files and 2 AI-output files, including `100% of calls`, `6 in 10 calls`, `+34%`, `99.9%` and several worked-example percentages in blog posts). That is the gate working as designed, not a bug. Work through the list in one pass (reword, add evidenced entries, or add reasoned exemptions) before turning the CI step on as required. **[VERIFY]** the count against your current local copy.
