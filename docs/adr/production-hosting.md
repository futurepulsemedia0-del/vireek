# ADR — Which host serves production: Vercel or the Cloudflare Worker?

- **Status:** PROPOSED — **BLOCKED on owner answers (§5).** No host is confirmed.
- **approvedBy:** PENDING
- **Tracks:** `docs/governance/DECISIONS_NEEDED.md` D-6 (referred to there as "ADR-0011"; final number **[VERIFY]**)
- **Evidence base:** static read of the uploaded snapshot `vireek-main__7_.zip` only. The snapshot has no `.git` history, no DNS data, no deploy logs and no dashboard access. The live repo may differ **[VERIFY]**. Nothing below was executed.

## 1. Question

`vercel.json` and `wrangler.jsonc` + `worker/` both exist. Documents disagree about which one serves `vireek.com`. This record decides **only from evidence**; where the evidence does not decide, it says so and lists what is needed.

## 2. Evidence

| # | Source | What it shows | Weight |
|---|---|---|---|
| E1 | `wrangler.jsonc` | Worker `vireek`, entry `worker/index.ts`, assets `./dist` with `run_worker_first: true`, routes `vireek.com` and `www.vireek.com` as `custom_domain`. Declares intent to own both hostnames. | Config: intent, not proof of deployment |
| E2 | `worker/index.ts` (header + `import vercel from '../vercel.json'`) | Calls itself the replacement for "what Vercel did"; applies `vercel.json` rewrites (Supabase proxies) and **all** header rules. So `vercel.json` is a live input to the Worker. | Code. **The presence of `vercel.json` is therefore not evidence for Vercel hosting.** |
| E3 | `cf-build.sh` | Build for the Cloudflare path: `npm install --legacy-peer-deps`, ~35 packages installed `--no-save` outside the lockfile, `PRERENDER_OPTIONAL=1 npm run build`. | Code |
| E4 | `vercel.json` | `installCommand` runs `npm ci && npx playwright install chromium` (Vercel builds can prerender with Chromium); catch-all rewrite to `/_spa.html`. | Config; consistent with either host |
| E5 | `.github/workflows/*` (24 files) | No workflow deploys either host. No `wrangler` call anywhere. Only `vercel-preview-smoke.yml` (needs `VERCEL_AUTOMATION_BYPASS_SECRET`, preview only). Both deploys therefore happen outside the repo (Git integration / dashboard). | Verified by grep |
| E6 | `api/win-card.ts` | Vercel Edge function (`runtime: "edge"`). Its comment says crawlers are rewritten "see vercel.json", but `vercel.json` has **0** `win-card` rewrites; the Worker has no `/api` handler and answers non-GET/HEAD with 405. In this snapshot **no host routes to it**. | Verified by grep |
| E7 | `supabase/functions/verify-custom-domain`, `landing-domain-verify` | Customer landing-page domains: CNAME target `cname.vercel-dns.com`, A record `76.76.21.21` (defaults; env-overridable), provisioning through the Vercel API (`VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID`). | Code. **Vercel is in the customer-domain path whichever host serves `vireek.com`.** |
| E8 | `ARCHITECTURE.md` §1, `README.md`, `RUNBOOK.md` §1/§2.1, `ENVIRONMENT.md`, `docs/RELEASE_SAFETY.md` #7 (`vercel rollback`), `docs/TESTING.md`, `docs/compliance/SOC2_READINESS.md`, `data-map.md` | All say Vercel. `RUNBOOK.md` itself says to *verify* the Vercel Git integration. | Docs derived from the repo, not from dashboards |
| E9 | `docs/platform/adr-0001-infrastructure-as-code.md` | Says the Worker is Git-connected (build `bash cf-build.sh`, deploy `npx wrangler deploy`), the `vireek.com` zone is on Cloudflare, and "the move from Vercel to Cloudflare is in progress" — all marked **Reported** by the founder, "not provable from the repo". | Founder-reported, unverified |
| E10 | `docs/brand/06-entity-dependency-audit.md` finding 5 | "UNVERIFIED which serves production." | Doc |
| E11 | `wrangler.jsonc` `compatibility_date: "2026-10-01"` vs `SUBPROCESSORS_LAST_UPDATED = 'September 12, 2026'` | *Inference:* the Worker config was written on/after 2026-10-01, after the public sub-processor list was last updated. | Inference only |

## 3. What the evidence cannot show

Which host answers real traffic for `vireek.com`, `www`, `app.`, `status.`; whether DNS records are proxied; the last production deployment on either platform; whether Vercel still has `vireek.com` assigned. All of that lives in DNS and dashboards.

## 4. Conclusion

**Undetermined.** Three hypotheses fit every item above equally well:

- **H1** — Vercel serves production; the Worker is staged/unused.
- **H2** — The Worker serves `vireek.com`/`www`; Vercel remains only for other things (customer domains E7, previews E5, `app.`?).
- **H3** — Split by hostname.

No answer was chosen, and **`ARCHITECTURE.md`, `src/lib/subprocessors.ts` and the DPA/transfer drafts were not changed to claim either one.**

## 5. Questions the owner must answer

Answer in the PR or reply to this record. Commands are read-only.

1. `curl -sI https://vireek.com`, then the same for `https://www.vireek.com`, `https://app.vireek.com`, `https://vireek.com/.well-known/agent-card.json`. Paste the headers `server`, `x-vercel-id`, `cf-ray`, `cf-cache-status`, `via`. (`x-vercel-id` present ⇒ Vercel answered; `cf-ray` without it ⇒ not Vercel. Header behaviour **[VERIFY against current vendor docs]**.)
2. `dig +short vireek.com www.vireek.com app.vireek.com` and, in the Cloudflare DNS tab, are those records **Proxied** or **DNS only**? (Decides whether Cloudflare handles website traffic even when Vercel is the origin.)
3. Cloudflare → Workers & Pages → `vireek`: are `vireek.com`/`www.vireek.com` listed under Domains & Routes? Date and commit of the last production deployment; Git-connected to which branch?
4. Vercel project → Settings → Domains: which hostnames are assigned? Production branch? Date of the last production deployment; Git integration still deploying `main`?
5. Which host serves `app.vireek.com` and `status.vireek.com`?
6. Are `VERCEL_API_TOKEN` / `VERCEL_PROJECT_ID` set in Supabase function secrets (`supabase secrets list` shows names only)? Do customer landing-page domains stay on Vercel?
7. Is Win Cards (`/win/:token` crawler previews, E6) live? Where does that traffic go today?
8. Intended end state and date: retire Vercel completely, or keep it for specific surfaces?
9. **[COUNSEL]** Which vendor terms/DPAs are accepted today for Cloudflare and for Vercel? (Not answerable from the repo.)
10. **[COUNSEL]** Are there customers on signed DPAs with a sub-processor change-notice clause? (`DpaContent.tsx` §5 describes advance notice.)

## 6. Prepared alignment — NOT APPLIED until §5 is answered

### 6.1 `ARCHITECTURE.md` (lines 20 and 36 in the snapshot)

| Outcome | §1 diagram, host label | "Hosting" bullet |
|---|---|---|
| H1 Vercel | keep | keep; change `/index.html` → `/_spa.html` (the snapshot's `vercel.json` rewrites to `/_spa.html`) |
| H2 Worker | `Cloudflare Worker "vireek" (static assets + Supabase proxies + headers from vercel.json)` | `- **Hosting:** Cloudflare Worker (`wrangler.jsonc`, `worker/`), build `cf-build.sh`; `vercel.json` stays as the shared source of truth for rewrites and headers. Vercel: <only what Q6/Q8 confirm>.` |
| H3 Split | name both with their hostnames | one line per host with its hostnames |

### 6.2 `src/lib/subprocessors.ts`

Public legal claim, and `DpaContent.tsx` §5 promises advance notice of changes **[COUNSEL]**. Do not edit before Q10 and counsel review. Coupled files: `src/lib/trustPack/subprocessorResidency.ts` (every name must be classified; the test fails otherwise) and `src/lib/trustPack/subprocessorResidency.test.ts` line 27, which expects `'Vercel Inc.'` in `noCustomerContent`. `docs/compliance/data-map.md` is **generated** by `scripts/compliance/gen-subprocessors-by-region.mjs` — regenerate, never hand-edit.

| Outcome | Change |
|---|---|
| H1 | none, **unless** Q2 = Proxied: then add a Cloudflare DNS/proxy entry (website traffic passes through Cloudflare even with a Vercel origin). |
| H2 | replace the `Vercel Inc.` entry with a unique-name entry, e.g. `Cloudflare, Inc. (Workers & DNS)` (must not collide with the existing `Cloudflare, Inc. (Workers AI)` key); keep a narrowed Vercel entry only if Q6/Q8 say customer domains stay there; classify the new name `no_customer_content` **only after** confirming it receives none; update the test expectation; bump `SUBPROCESSORS_LAST_UPDATED`. |
| H3 | keep Vercel (narrowed purpose) + add the Cloudflare entry as above. |

`location`: do **not** publish "United States" for an edge network without confirmation **[COUNSEL][VERIFY]**; never ship a placeholder string.

### 6.3 DPA / transfer drafts **[COUNSEL]**

- `src/components/sections/DpaContent.tsx` §5 names no vendor ("cloud hosting, …") → no text change is forced by the host answer; the **notice process** is what is triggered.
- `docs/compliance/transfers-and-contracts.md` §2: after the answer, add a draft row — *"Vireek → hosting/CDN provider(s) (per this ADR) | Vendor DPA / SCC Module 3 or DPF status **[VERIFY per vendor]** | Edge hosts process requests in many locations, so a single country on the public list may be inaccurate **[COUNSEL]**. Hosting receives no call content by design; note that the Worker/rewrites proxy Supabase-backed public endpoints (feeds, careers sitemap, badge API, agent card)."*

### 6.4 Follow-up docs after the answer (separate change)

`README.md` (75, 138–139), `RUNBOOK.md` §1/§2.1/§6, `ENVIRONMENT.md` (A, `VERCEL_AUTOMATION_BYPASS_SECRET`), `docs/RELEASE_SAFETY.md` #7, `docs/TESTING.md`, `docs/compliance/SOC2_READINESS.md`, `docs/compliance/soc2/CONTROL_MAP.md` ACC-05, `docs/platform/adr-0001-infrastructure-as-code.md`, `docs/runbooks/incident-response.md`.

## 7. Safe interim edit (facts only, no host claim)

`ARCHITECTURE.md` currently asserts Vercel as fact. Replace with the verified state:

- Ctrl+F `Vercel (static hosting + SPA rewrite + security headers: vercel.json)` → `Host: Vercel OR Cloudflare Worker (undecided — docs/adr/production-hosting.md)`
- Ctrl+F `- **Hosting:** Vercel; ` → `- **Hosting:** **under decision — see [docs/adr/production-hosting.md](docs/adr/production-hosting.md).** Both a Vercel config and a Cloudflare Worker exist; the Worker applies the same rewrites and headers from `vercel.json`. `

(Keep the rest of the bullet; also change `/index.html` to `/_spa.html` in it.)

## 8. Risks that hold whichever host wins

| Risk | Detail |
|---|---|
| R1 Win Cards unrouted | E6: neither host routes crawlers to `api/win-card.ts` in this snapshot. |
| R2 Prerender parity | Worker build uses `PRERENDER_OPTIONAL=1`; Vercel installs Chromium. SEO prerender coverage may differ per host; assertion behaviour of `scripts/seo/assert-prerendered.mjs` under that flag **[VERIFY]**. |
| R3 Unlocked installs | `cf-build.sh` installs packages outside the lockfile (links to D-1/D-5). |
| R4 Shared header source | `worker/index.ts` reads `vercel.json`; invalid JSON or a Vercel-only key breaks both paths. |
| R5 Rollback doc | `docs/RELEASE_SAFETY.md` #7 (`vercel rollback`) is wrong if the Worker serves. |
| R6 Customer domains | E7 keeps a Vercel dependency even after a full Worker cutover. |

## 9. Verification

| Check | Result |
|---|---|
| Static inspection of snapshot (files above) | DONE |
| Live DNS / headers / dashboards | **BLOCKED** (no access) |
| Typecheck, Vitest | **NOT RUN** (docs-only change; no code touched) |

## 10. Decision record

- Decision: **PENDING**
- approvedBy: **PENDING**
- Date: —
- On approval: choose H1/H2/H3, apply §6, then set Status to Accepted.
