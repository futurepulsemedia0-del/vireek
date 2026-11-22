# Sanctions screening gate

**Status: engineering design + implementation notes. Not legal advice. No screening provider has been integrated, contracted or exercised against a real service.**
Items marked **[COUNSEL]** need a legal decision before go-live. Items marked **[VERIFY]** are facts nobody has confirmed against a primary source.

## 1. What already existed (verified in the repo)

| Where | What it says / does |
|---|---|
| `src/lib/legalDocs/exportControl.ts` (public page `/export-control`) | States that Vireek *may* screen customers against restricted-party lists and *may* use IP / billing-country signals. It describes a right, not a running control. **[COUNSEL]** keep the wording in line with what this gate actually does (section 9). |
| `docs/PAY_AND_CAPITAL.md` (line "KYC/OFAC on payees (partner)") | Lists KYC/OFAC on payees as a partner-side obligation. Nothing in code screened anyone before this change. |
| `supabase/functions/auth-before-user-created` | Existing signup hook (fraud scoring, fail-open by design). Extended here. |
| `supabase/functions/stripe-connect-onboarding` | Creates the Stripe Express account for payouts. Extended here. |
| `supabase/functions/_shared/instantPayouts/service.ts` | Instant payout money path. Extended here (state check only). |

No sanctions list, provider, review queue or hold state existed.

## 2. Design in one page

```
 signup (Auth hook) ──► runScreening(checkpoint=signup, name only) ──┐
 payout setup (stripe-connect-onboarding) ► runScreening(payout_setup, legal name + country) ─┤
                                                                      ▼
   provider adapter (http | mock-list)  ──►  decision: clear | review | error
                                                                      ▼
                     sanctions_record_screening()  (one transaction)
          screening log  +  review case  +  account gate state (held | cleared | blocked)
                                                                      ▼
   instant payouts / resume ► checkAccountGate(owner)  (state only, no provider call)
   staff ► /staff/sanctions ► sanctions-admin ► sanctions_decide_case() (clear | confirm_block | escalate)
```

Code: `supabase/functions/_shared/sanctions/` (`gate.ts`, `providers.ts`, `config.ts`, `matcher.ts`, `store.ts`).
Schema: `supabase/migrations/20290307000000_sanctions_screening_gate.sql`.
No vendor is named in code, schema or env var values. The provider is whatever answers the contract in section 5.

## 3. Checkpoints

| Checkpoint | Data screened | Required? | If it cannot be screened |
|---|---|---|---|
| `signup` | `full_name` from the signup form (nothing else is available to the Auth hook) | No: skipped when no name is present (Google / OTP signups often have none) | n/a (skipped) |
| `payout_setup` | legal name (request body, falls back to profile name), aliases (company name), **country (required)**, optional birth date | Yes: name + valid ISO country | `422 SANCTIONS_SUBJECT_REQUIRED`; the UI asks for them |
| money movement (`instant-payouts`) | none: reads the account gate state | n/a | held / blocked accounts cannot request or resume a payout |

**Known limitation:** at signup only a name is screened, never an email address or IP. The strong control is at payout setup. Whether signup-time screening is sufficient, or whether the product should collect country/DOB earlier, is **[COUNSEL]**.

## 4. Decisions and fail-closed rules

Effective mode comes from `sanctions_settings.mode` (`shadow` | `enforce`), resolved by `config.ts`:

| Situation | `enforce` | `shadow` |
|---|---|---|
| Provider returns no match >= threshold | allow, account `cleared` | allow, logged |
| Match >= threshold, or country in `restricted_countries` | **deny** (`SANCTIONS_HOLD`), review case opened, account `held` | allow, logged, `would deny` counted |
| Provider missing / timeout / bad response / HTTP error | **deny** (`SANCTIONS_UNAVAILABLE`, retryable) | allow, logged |
| Hash secret (`FRAUD_HASH_PEPPER`) missing | **deny** | allow, logged |
| Cannot write the audit record | **deny** | allow |
| Settings row missing / unreadable / invalid | treated as `enforce` with the strictest threshold (0.70) | n/a |
| `SANCTIONS_FORCE_ENFORCE=true` | `enforce` regardless of the row | n/a |
| Subject already confirmed blocked by staff | **deny in every mode** | **deny** |
| Subject already cleared by staff | allow without calling the provider | same |

* The migration seeds `mode = 'shadow'` so that applying it cannot stop signups or payouts before a provider exists. **Switching to `enforce` is the go-live step** (section 8). A missing or corrupt row fails *closed*, not open.
* The signup hook defaults to **deny**: only an explicit allow lets a signup through, and an unexpected exception in the sanctions step is a denial (unlike the fraud-scoring step, which fails open by design).
* The end user always gets one generic message for hold / block / unavailable. It does not say "sanctions". **[COUNSEL]** wording and any tipping-off considerations.
* Automatic results never release a confirmed block, and never release a hold on the *same* subject; only a reviewer does. A corrected subject (different name/country) is screened afresh.

## 5. Provider contract (`SANCTIONS_PROVIDER=http`)

Env (Supabase edge function secrets): `SANCTIONS_PROVIDER`, `SANCTIONS_PROVIDER_URL` (must be `https://`, no embedded credentials), `SANCTIONS_PROVIDER_TOKEN`, optional `SANCTIONS_PROVIDER_LABEL` (`[a-z0-9._-]`, stored with each screening).

```
POST <URL>   Authorization: Bearer <TOKEN>   Content-Type: application/json
{ "requestId": "uuid", "subject": { "kind": "person|entity", "name": "...", "aliases": ["..."], "country": "DE|null", "dateOfBirth": "YYYY[-MM[-DD]]|null" } }

200 { "listVersion": "string", "matches": [ { "listId": "string", "entryId": "string", "name": "string", "score": 0..1, "programs": ["string"] } ] }
```

Anything else (non-200, non-JSON, a score outside 0..1, oversized body, redirect, timeout) is an **error**, never "no matches". No email, IP or user id is sent. A real provider usually needs a thin proxy you own to map this contract. **[VERIFY]** against the chosen provider; nothing here has been run against one.

`SANCTIONS_PROVIDER=mock-list` (+ `SANCTIONS_ALLOW_MOCK=true`, `SANCTIONS_MOCK_LIST_JSON`) exists only for staging smoke tests and is refused otherwise. **Never set `SANCTIONS_ALLOW_MOCK` in production.**

## 6. Review workflow (`/staff/sanctions`)

1. A hit creates **one** live case per account + subject (repeat attempts refresh it).
2. A reviewer sees the subject, top score, the list entries that matched, and a birth-year-mismatch hint. They choose **Clear** (false positive), **Escalate**, or **Confirm block**. A note (3-1000 chars) is mandatory and goes to the audit log.
3. *Clear* writes a subject override so a retry (including a signup that was denied) passes; *Confirm block* writes a block override and sets the account to `blocked`.
4. Owners cannot read any of these tables (no policy by design). Four-eyes approval for *Clear* is not enforced in code. **[COUNSEL]** decide whether it is required.

## 7. Data handling

`sanctions_screenings` / `sanctions_review_cases` hold the screened name, aliases, country and birth date (personal data), staff-read only, and survive account deletion (`ON DELETE SET NULL`) so evidence is not lost. **[COUNSEL]** retention period, deletion-request handling and the lawful basis; add the tables to `docs/compliance/data-map.md` and to the erasure coverage baseline once decided. Nothing deletes these rows today.

## 8. Go-live checklist

1. Apply the migration; run `supabase test db` (`sanctions_screening_gate.test.sql`).
2. Set `FRAUD_HASH_PEPPER` (already required by the signup hook) and the provider secrets; deploy `sanctions-admin`, `auth-before-user-created`, `stripe-connect-onboarding`, `instant-payouts`.
3. In `/staff/sanctions` confirm both readiness lines are green. Run the provider in **shadow** for a period and review the "would-be stops" and error counts.
4. **[COUNSEL]** populate `restricted_countries` (empty by default; the list is a legal determination **[VERIFY]**) and settle the thresholds.
5. Switch to **enforce** (reason is audited). Optionally pin it with `SANCTIONS_FORCE_ENFORCE=true`.
6. Test with a mock-list entry in staging: signup, payout setup, a held payout, *Clear*, *Confirm block*.

## 8a. Not implemented (deliberately out of this change)

* **Re-screening** of existing accounts when lists change (the `rescreen` checkpoint and `sanctions_account_state` are ready for a job; none exists). **[COUNSEL]** cadence.
* Re-screening on Stripe `account.updated` (verified legal name / address), and screening of payroll / EWA transfer recipients (`pay-transfer-request`).
* IP / billing-country restricted-region blocking mentioned on the public page.
* Beneficial-owner / director screening for business accounts.
* Existing accounts are `unscreened`; they are *not* blocked, and payouts are only stopped for `held` / `blocked`.

## 9. [COUNSEL] summary

Which parties and lists must be screened; thresholds; restricted-country list; user-facing wording; tipping-off; four-eyes; retention and erasure; licensing or reporting obligations when a true match is confirmed; wording of `/export-control` versus this implementation; whether a signup-time name-only check is acceptable.
