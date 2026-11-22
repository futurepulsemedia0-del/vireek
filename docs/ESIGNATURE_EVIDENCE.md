# E-signature evidence

What Vireek records when a document is signed, how the record is protected, and what it does **not** establish.
Items tagged **[COUNSEL]** need a lawyer. Items tagged **[VERIFY]** are facts about the deployment or vendors that were not checked here. No legal sufficiency, certification or compliance claim is made.

| Piece | Where |
|---|---|
| Schema, triggers, signing functions | `supabase/migrations/20290308000000_esignature_evidence.sql` (after `20261201000000_native_esignature.sql`) |
| Hashing, chain check, certificate, seal | `supabase/functions/_shared/esign-evidence/evidence.ts` |
| Issue/load certificate | `supabase/functions/_shared/esign-evidence/issue.ts` |
| PDF renderer | `supabase/functions/_shared/esign-evidence/certificatePdf.ts` |
| Download / verify API | `supabase/functions/signature-certificate` |
| Buttons | `src/components/signatures/SignatureCertificateButtons.tsx` (shown to signers on the "fully executed" screen) |
| Tests | `evidence.test.ts`, `src/lib/signatureEvidenceMigration.test.ts`, `supabase/tests/database/esignature_evidence.test.sql` |

## What was already there (verified before this work)
`send-signature-request` stored `consent_text`. `sign-document-action` already captured signer IP and user agent, and the database already stored view/consent/sign/decline timestamps and a plain event log. They were not tamper-evident, the consent text was an editable column, signing silently set `consented_at`, nothing fingerprinted the document, and there was no certificate.

## What is recorded now
- **Document fingerprint.** On insert, a trigger stores the exact canonical text of what was sent (type, id, title, summary, link, optional sender-supplied file hash, consent text, consent version) and its SHA-256. Client-supplied values are overwritten.
- **Consent record** per signer: consent text as shown, its hash, version, how it was captured (`checkbox_click`, or `captured_at_signing` if the earlier call was lost), IP, user agent, time.
- **Signer evidence:** signed name, signature type, a SHA-256 of the signature data, signed time, IP, user agent.
- **Audit chain.** Every event stores the exact text that was hashed, including the previous event's hash. Per request, gap-free. The `signed` event binds the signature hash to the document hash and the consent hash.
- **Certificate** (JSON and PDF), issued once when the request completes, containing all of the above and the results of its own integrity checks. Stored write-once with a SHA-256 and an HMAC-SHA256 seal made with `ESIGN_EVIDENCE_HMAC_KEY`, a secret that is not in the database.

## Protection, and its limits
- A signed request's document fields, a signed signer row, consent records, events and certificates cannot be edited by application code or by clients (triggers). A request with consent or signature evidence cannot be deleted; void it.
- Someone with **database superuser or trigger-disabling access** could still alter rows. The chain makes that detectable (recomputation fails) and the seal makes it undetectable only to someone who also holds the seal key. Keep the key out of the database and out of the repo; rotate with a new `ESIGN_EVIDENCE_KEY_ID`.
- The seal is verified by Vireek (`action: "verify"`). A third party can recompute every hash link from the JSON but cannot check the seal without the key. An external timestamp or anchoring service is **not** included. **[COUNSEL]** whether one is needed.
- The fingerprint covers what the signer was shown as text. It does **not** cover the bytes behind `document_url`, unless the sender supplies `document_file_sha256`. The UI does not yet compute or send that hash.
- Legacy requests (created before this migration) are not back-filled. Their certificate says `legacy` or `partial`.
- IP addresses come from `cf-connecting-ip`, then `x-real-ip`, then the first `x-forwarded-for` entry. **[VERIFY]** the proxy path in production; the last fallback can be influenced by a client.
- Identity is "access to a unique link sent to an e-mail address or phone". There is no identity proofing, no second factor, and signing order is not enforced.
- Expiry (`expires_at`) is not enforced by the signing function. That was already the case.

## Open legal questions **[COUNSEL]**
1. Whether this record meets the requirements for a valid electronic signature in each jurisdiction served (for example the US federal and state e-signature statutes, the EU/UK frameworks) and for each document type (quotes, contracts, invoices). Some document types are excluded from e-signature in some places.
2. The consent wording. The default text predates this work. Consumer-consent disclosures (paper-copy right, withdrawal, hardware/software requirements) are **not** implemented. Version the text with `consent_version` when counsel changes it.
3. Whether signing by link only is acceptable for high-value or regulated documents, or stronger identity steps are needed.
4. Retention period for certificates, IP addresses and user agents, and privacy-law treatment (these are personal data). Deletion requests versus the write-once design.
5. Whether the certificate PDF wording ("Limitations") is acceptable to show to counterparties.
6. Admissibility and the evidence a court would expect; whether a qualified or advanced signature provider is needed instead.

## Deploy
1. Run the migration. 2. `supabase functions deploy signature-certificate --no-verify-jwt`, `send-signature-request`, `sign-document-action --no-verify-jwt`.
3. `supabase secrets set ESIGN_EVIDENCE_HMAC_KEY=<random, 32+ chars> ESIGN_EVIDENCE_KEY_ID=k1`. Without the key nothing is sealed and downloads return "not configured"; no unsealed certificate is presented as sealed.
4. Smoke test: complete a test request, download the PDF and JSON, then call `verify` with the JSON.

## Rollback
See the header of the migration. It destroys evidence; use only before real use.
