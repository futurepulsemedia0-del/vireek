# Third-party agent vetting

How a third-party agent (a `runtime = 'webhook'` row in `marketplace_agents`) gets listed, stays listed, and is removed.
First-party agents (`publisher_id IS NULL`) are seeded already approved and are not affected by the submission gate, but staff can still delist them.

**Status of this document:** engineering design for the implemented controls. Items marked **[COUNSEL]** need legal review before they are shown to publishers. Items marked **[VERIFY]** are assumptions nobody has confirmed. Nothing here is a certification, audit result or compliance claim.

## 1. What already existed (not duplicated)

| Capability | Where |
|---|---|
| Scope catalog with `low/medium/high` risk, per-install scope grants (a subset of what the manifest requests) | `marketplace_scopes`, `install_marketplace_agent` |
| Manifest validation (scopes, triggers, limits) | `validate_marketplace_manifest` |
| SSRF shape check, private-IP check, HMAC-signed calls, scope-minimised data, response validation | `_shared/agent-marketplace/contract.ts`, `agent-runtime` |
| Staff review queue, approve / reject, suspend | `list_marketplace_review_queue`, `review_marketplace_agent_version`, `suspend_marketplace_agent` |
| Hash-chained per-tenant audit | `marketplace_agent_audit` |

## 2. What this change adds

1. **Automated static checks** (`_shared/agent-marketplace/vetting.ts`, run by the `marketplace-vetting` edge function) producing an append-only report.
2. **A staff review checklist** (12 items, 7 apply to every agent; others depend on scopes, price and risk tier).
3. **A database-enforced approval gate** inside `review_marketplace_agent_version`.
4. **More approval states**: `changes_requested` (version) and `delisted` (agent).
5. **Delisting and reinstating** with immediate install revocation and an append-only history.
6. **A staff page**: `/staff/marketplace-vetting` (queue, listed agents, history).
7. Optional manifest field `outbound_domains` (self-declared processors).

## 3. Lifecycle

```
publisher submits version ─► submitted ──► approved ─► (agent: published)
                                  │            └─► deprecated   (when a newer version is approved, or on delisting)
                                  ├──► changes_requested   (publisher submits a NEW version number)
                                  └──► rejected

agent:  draft ─► in_review ─► published ─► suspended (temporary, installs paused)
                                  └──────► delisted  (installs revoked, versions deprecated)
                                              └─► draft  (reinstated; needs a fresh version + full vetting)
```

Versions are immutable. A change always means a new version number, which restarts vetting.

## 4. Automated checks

Pure, deterministic and unit-tested (`vetting.test.ts`). Each check returns `pass`, `warn` or `fail`. Any `fail` makes the report verdict `fail`, and a failed report **blocks approval in the database**. Warnings do not block; they require the human checklist.

| Check id | Looks at | Fails when | Warns when |
|---|---|---|---|
| `manifest.shape` | scopes, triggers, limits | malformed, unknown trigger, out-of-range limit | – |
| `manifest.limits` | `timeout_ms`, `max_actions` | – | timeout > 10 000 ms or max_actions > 5 |
| `manifest.prompt` | `system_prompt` | present on a webhook agent | – |
| `scopes.known` | requested scopes vs catalog | unknown scope | – |
| `scopes.risk` | scope risk | – | any `high` scope |
| `scopes.coherence` | scope combinations | – | SMS without customer scope; contact data without messaging purpose; financials without jobs |
| `outbound.endpoint` | endpoint URL | not https / not 443 / credentials / IP literal / internal host / missing | built-in agent with an endpoint |
| `outbound.host` | host label and peers | – | punycode label; same host used by another publisher |
| `outbound.dns` | A / AAAA answer | does not resolve, or any private address | DNS not checked |
| `outbound.declared` | `outbound_domains` | invalid hostname list | contact data requested but nothing declared (use `[]` to say none) |
| `data.exposure` | exact fields leaving Vireek, from the same lists `projectJob` / `projectCustomer` use | – | personal contact data |
| `data.messaging` | `act:send_sms` | – | SMS requested |
| `identity.publisher` | publisher / agent name | third party uses "Vireek" | – |
| `identity.lookalike` | agent name vs others | – | identical or edit distance <= 2 to another agent |

**Risk tier** is `high` if any requested scope is `high` risk or unknown, `medium` if any is `medium`, otherwise `low`.

### What the checks cannot tell you

- What the publisher's server does with data after it receives it.
- Whether `outbound_domains` is complete or true. It is **self-attested and not enforced anywhere**.
- Whether the DNS answer will be the same at run time. `agent-runtime` re-resolves and rejects private addresses on every call, but a record that changes between calls is a residual DNS-rebinding risk **[VERIFY]**: the runtime does not pin the resolved IP for the connection.
- Domain ownership. That is a checklist item done out of band.

## 5. Review checklist

Answers are `pass`, `fail`, or `na` (only where allowed). `fail` and `na` need a note of at least 5 characters. Labels and hints live in `src/locales/*/marketplaceVetting.json`.

| Item | Applies to | Counsel |
|---|---|---|
| `publisher_identity`, `security_contact`, `endpoint_control`, `signature_verification`, `scopes_justified`, `sandbox_run_reviewed` | every agent | – |
| `delisting_terms_ack` | every agent | **[COUNSEL]** |
| `pii_minimisation`, `subprocessors_match` (`na` allowed) | requests `read:customer_contact` | – |
| `dpa_in_place` | risk tier `high` | **[COUNSEL]** |
| `sms_compliance` | requests `act:send_sms` | **[COUNSEL]** |
| `pricing_terms_clear` | paid agents | – |

`[COUNSEL]` only flags that a legal reading is needed; the system cannot verify that one happened.

## 6. Approval gate (server side)

`review_marketplace_agent_version(…, true, …)` raises `APPROVAL_BLOCKED: <codes>` unless **all** hold:

- the reviewer is not the agent's publisher (`self_review`);
- the agent is not suspended or delisted;
- a vetting report exists for this exact `manifest_hash` and endpoint, is not older than 14 days, and its verdict is not `fail` (`no_report`, `report_manifest_mismatch`, `report_endpoint_mismatch`, `report_stale`, `report_failed`);
- no checklist item is `fail` and every applicable item is `pass`/`na` (`checklist_failed`, `checklist_incomplete`).

Rejecting needs a note. The version row is locked `FOR UPDATE`, so two reviewers cannot decide the same version.

Not implemented: **two-person approval** for high-risk agents. Today one staff member can approve. Recommended before opening the marketplace to untrusted publishers.

## 7. Delisting

**When:** confirmed security or privacy problem, fraud or abuse, policy violation, sustained quality failure, legal order, or publisher request. Use *suspend* for "pause while we investigate" (reversible, installs paused) and *delist* for removal.

**What `delist_marketplace_agent` does, in one transaction:**
1. sets the agent to `delisted` with reason code, actor and timestamp;
2. sets approved versions to `deprecated` (so re-listing needs a fresh review);
3. revokes every non-revoked install, blocks its queued runs, and writes an `agent_delisted` entry to each tenant's audit chain (reason code only, never the internal note);
4. appends a `marketplace_delisting_events` row (internal detail, staff-only).

The publisher sees only the publisher-facing message (stored in `suspended_reason`). Staff-only detail is never exposed to publishers or tenants.

**Effects that already hold at run time:** `agent-runtime` refuses runs and execution of approved actions when the agent is not `published`, so approved-but-unexecuted actions from a delisted agent do not run.

**Not done by this change:** cancelling still-pending items in the governance approval queue (they cannot execute but remain listed until a human clears them); notifying affected tenants (the audit entry is the only trace today); refunds or ledger adjustments for paid agents **[COUNSEL]**.

**Reinstating** returns the agent to `draft` with no current version. The publisher must submit a new version that passes vetting and the checklist again.

**Publisher-facing terms** (grounds for delisting, notice, appeal, data handling after delisting) **[COUNSEL]**: not drafted here. The `delisting_terms_ack` item exists so reviewers confirm the publisher accepted whatever terms counsel approves.

## 8. Operations

Deploy order:
1. `supabase db push` (migration `20290311000000_marketplace_vetting.sql`).
2. `supabase functions deploy marketplace-vetting --no-verify-jwt` (auth and staff check are inside the function).
3. Deploy the web app.

Versions already `submitted` at deploy time need a vetting run and checklist before approval.

Everyday: open `/staff/marketplace-vetting` → *Run checks* → answer the checklist → decide. Re-run checks if a report is older than 14 days.

Rollback: see the header of the migration.

Tests: `src/lib/marketplaceVetting.test.ts`, `src/i18n/marketplaceVettingLocales.test.ts`, `supabase/functions/_shared/agent-marketplace/vetting.test.ts` (Vitest); `supabase/tests/database/marketplace_vetting.test.sql` (pgTAP).

## 9. Known gaps

- No scheduled re-vetting of already published agents (a published agent is not re-checked unless staff act).
- No two-person approval; no publisher-facing appeal flow; no tenant notification on delisting.
- Domain ownership is a manual checklist item, not a technical challenge.
- DNS is not pinned for the connection itself (see section 4).
