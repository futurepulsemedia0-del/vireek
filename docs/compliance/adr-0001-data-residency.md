# ADR-0001: Regional data residency (US / EU / UK / CA / AU)

Status: **PROPOSED** - needs founder decision + counsel input. Not legal advice.
Date: 2026-11-02

## Context
Vireek must be credible to EU, UK, Canadian and Australian buyers. Verified from the snapshot:
* A Trust Pack already implements a **control plane (US) + per-region data plane** with a fail-closed router, but only for **recordings and sealed fields**, only `us|eu|ca`, and `eu`/`ca` are not available or enforced (`data_regions.is_available=false`, `enforced_at` NULL).
* The UI is behind flag `data_residency_ui` (default OFF) and a DB trigger refuses tenants in unenforced regions. This is the right guard; keep it.
* Live voice, STT/TTS and all LLM calls go to US providers.
* UK and AU cannot be represented (CHECK constraints).

## Options

| | A. Single US region + controls | B. Hybrid (what exists): US control plane + regional data plane for sensitive content | C. Fully separate backend project per region |
| --- | --- | --- | --- |
| What stays in region | Nothing | Recordings + sealed transcripts at rest | Everything at rest |
| In-transit US processing | Yes | Yes (voice, LLM) unless providers are pinned | Only if providers are pinned too |
| Migrations | 1 pipeline | 1 control pipeline + small data-plane schema | N pipelines, version skew risk |
| Routing | none | existing router (`regions.ts`) | domain/tenant routing at the edge, auth per region |
| Cost / support | lowest | low-medium | high (N x infra, N x on-call, cross-region support access = transfer) |
| Honest claim available | "US-hosted + SCC/DPF" | "Recordings/transcripts stored in <region>" (after verification) | "All customer data stored in <region>" |
| Feasible now | yes | partly (EU/CA plane needs provisioning + enforcement probe) | no |

## Decision (recommended, staged)
* **Phase 0 - now:** Option A, sold honestly. Controls: minimise, seal transcripts, per-class retention, signed DPA + transfer mechanism, correct subprocessor list, consent/disclosure scripts. **No residency claims anywhere** (site, DPA, sales).
* **Phase 1:** Finish Option B for **EU** first (largest demand, one plane covers DE/FR/NL/etc.). Add `uk` and `au` to the CHECK constraints (migration) but **serve UK from the EU plane only if counsel confirms** the transfer basis; AU likely stays on US with APP 8 accountability unless a customer requires onshore.
* **Phase 2:** Pin the in-transit path: voice provider storage/custom bucket, EU/UK-region LLM endpoints with zero-retention terms. Until each is verified, `RESIDENCY_SCOPE` must keep `ai_processing = third_party`.
* **Phase 3 (only on enterprise demand):** Option C as a dedicated-tenant product (the `dedicated_tenants` table already anticipates it), priced to cover the support burden.

## Release gate for any "residency" wording
All must be true and evidenced: (1) `data_regions.enforced_at` set by staff after the probe; (2) automated test proves a write for an EU-tagged tenant cannot land outside allowed regions (see gap list T1); (3) provider-side storage verified (D1); (4) DPA and `/subprocessors` describe the real flow; (5) counsel signed off.

## Consequences
Positive: smallest change that gives a defensible story; reuses existing guard. Negative: Phase 0 customers who demand residency will be turned away or wait; control-plane data (customers, jobs, billing) stays US until Phase 3.
