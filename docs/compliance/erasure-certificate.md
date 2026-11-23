# Deletion certificate

A signed JSON record, issued after the retention-sweep erasure job completes a **full-account** deletion request.
It lists the systems and subprocessors from `docs/compliance/erasure-coverage-baseline.json` (`certificate` block),
what happened in each, the backup expiry date, and a SHA-256 that is stored separately for later verification.

> It is a technical record of an automated job. It is not legal advice and not an independent certification.
> The `notice` wording in `erasureCertificate.ts` is **[COUNSEL]**: have counsel review it before customers receive the file as a compliance document.

## Flow

1. `data-retention-sweep` erases a due `full_account` request (provider erasure, trust pack, owned tables, `erase_user_rows`).
2. It stores what it did in `erasure_job_evidence` (service role only), then marks the request `completed`.
3. It issues the certificate (`erasure_certificates`, append-only). Failure here never re-opens the erasure.
4. Every later sweep run issues any certificate that is still missing (crash, or key configured later).
5. The owner downloads it from the `erasure-certificate` edge function.

Out of scope: `delete-account` (immediate self-service deletion) removes the login at the end, so the owner has no session to
download with afterwards. No certificate is issued on that path. If you need one, issue it to an email-verified channel; decide that with counsel.

## Endpoint

`GET /functions/v1/erasure-certificate` with `Authorization: Bearer <user access token>` (gateway JWT stays on).

| Request | Result |
|---|---|
| `?deletionRequestId=<uuid>` | The stored certificate as `application/json` attachment (`VRK-ERC-XXXXXXXXXXXX.json`), headers `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Certificate-SHA256`. |
| `?deletionRequestId=<uuid>&verify=1` | `{ ok, certificateNumber, sha256, valid, checks }`, recomputed from the stored document. |
| no id | Metadata of the caller's own certificates (max 50). |

Errors: `401` no/invalid session, `400` malformed id, `404` not found **or not yours** (indistinguishable), `405`, `503` not configured.
The function reads with the caller's own token; Postgres RLS (`account_id = auth.uid()`) decides. It holds no service-role key.

## Document

`type`, `schemaVersion`, `certificateNumber`, `issuedAt`, `subject` (pseudonymous `accountId`, `deletionRequestId`), `timeline`, `status`
(`completed` or `completed_with_exceptions`), `systems[]`, `subprocessors[]` (each `outcome`: `erased`, `not_applicable`,
`skipped_no_credential`, `failed`, `no_evidence`), `limitations[]` (things the job does **not** cover), `backup`, `coverageBaseline`
(digest of the baseline file and its accepted-uncovered-table count), `notice`, `integrity`.
No email, name or row content is included.

## Integrity

* `integrity.sha256` = SHA-256 of the canonical payload (sorted keys, no whitespace, `integrity` removed).
* `integrity.signature` = HMAC-SHA256 over `"vireek-erasure-cert-v1\n" + canonical payload`, key id in `integrity.keyId`.
* `erasure_certificates.sha256/signature/key_id` repeat these as columns; the table rejects UPDATE/DELETE/TRUNCATE for every role.
* HMAC means only Vireek can verify. A third party cannot. A public-key signature would allow that but is quantum-vulnerable (see `docs/security/crypto-inventory.md`). Decide deliberately.

## Configuration (edge function secrets)

| Name | Purpose |
|---|---|
| `ERASURE_CERT_SIGNING_KEY` | Required. At least 32 random characters (`openssl rand -base64 48`). Without it no certificate is issued (the sweep reports it in `errors`, and backfills later). |
| `ERASURE_CERT_KEY_ID` | Optional, default `k1`. Change it when you rotate. |
| `ERASURE_CERT_VERIFY_KEYS` | Optional JSON `{"k0":"<old secret>"}` so certificates signed with retired keys stay verifiable. |
| `BACKUP_RETENTION_DAYS` | Integer 1-3650. **[VERIFY]** the real retention of Supabase PITR/backups and `dr-backup-run` in the dashboard first. If unset, `backup.expiresAt` is `null` and `backup.status` is `unverified`. A date is never guessed. |

Set `ERASURE_CERT_SIGNING_KEY` on **both** `data-retention-sweep` and `erasure-certificate` (same project secrets).

## Baseline file

`certificate.systems` / `certificate.subprocessors` must stay true to the code. `automated: false` entries are printed as limitations.
Current gaps (from code): storage audio files, Twilio recordings/logs, Resend logs, backups (age out). ElevenLabs/Vapi delete endpoints are **[VERIFY]**.
`node scripts/compliance/check-erasure-coverage.mjs --baseline` now preserves the `certificate` block.

## Known pre-existing issue (not changed here)

`check-erasure-coverage.mjs --check` already reports 153 tables not in the baseline in the untouched repo. This work did not re-baseline; that is a policy decision.
