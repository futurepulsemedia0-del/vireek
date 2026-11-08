# Photo provenance (job evidence photos)

Integrates photo capture with the existing **Job Evidence Chain** (`job_evidence_chain_entries`). It adds no second ledger.

## What it proves — and what it does not (shown in the UI as well)
- **Proves:** the photo file is byte-identical to what the server received, and records when (server receipt time + device clock), how (in-app camera / gallery import / browser upload / offline) and — only if allowed — where (accuracy class) it was captured.
- **Does not prove:** that the work was done correctly, or that the photo shows what it is claimed to show.
- **Limits:** the device clock and GPS can be spoofed (rooted/emulated devices, mock-location apps). Photos not taken with the in-app camera carry no capture guarantee. "Original bytes" means the bytes the capture API delivered to the app; the Capacitor camera plugin may already have re-encoded them (quality 85, max 2048 px). Hardware-backed capture attestation and C2PA signing at capture are **not** implemented (see Decision memo).

## Data flow
1. Device fingerprints (SHA-256) the original bytes, stores blob + metadata in an IndexedDB queue (`vireek-photo-provenance`).
2. Upload to the private bucket `job-evidence-chain` at the content-addressed path `{owner}/{job}/photo/{sha256}.{ext}`.
3. Edge function `photo-provenance` re-downloads the object, re-computes SHA-256 and size, then calls the service-role-only `evp_record_capture()`.
4. SQL stamps `server_received_at`, computes `core_commit`, applies the location gates, inserts the row and appends a sealed entry to the job's hash chain (`source_key = 'photo:<id>'`).
5. Derived copies (resize, redaction) are rows in `evidence_photo_derivatives` with `parent_sha256`, each sealed as its own chain entry (`photoderiv:<id>`). Resizing therefore never invalidates the original's verification.

Verification (`evp_capture_view`) recomputes the commitment from the row, compares it with the sealed ledger payload and the file hash in `media[0]`, and requires the existing `job_evidence_chain_verify()` to be valid up to that entry. Statuses: `unmodified` · `imported` · `offline` · `integrity_failed`.

## Location privacy
Coordinates are stored only in `evidence_photo_locations` (no policy, no grants: unreadable to clients) and never in the chain. The chain holds a **salted commitment**; deleting the row (purge/retention) destroys the salt, so the chain stays valid and the commitment links to nothing.
A coordinate is accepted only if **all** hold: account switch `evidence_photo_policies.capture_location`; `location_privacy_policies.require_consent = true` and `location_tracking_gate()` = `allowed` for the technician; photo device time within `arrived_at|started_at − 15 min … completed_at|now + 60 min`. Otherwise coordinates are discarded and the reason is recorded (`no_consent`, `off_duty`, `outside_job_window`, …). Rounded to 4 decimals (~11 m). Managers only can read coordinates (`evp_coordinates`).

## Retention, deletion on request
- Settings: `location_retention_days` (default 90), `photo_retention_days` (default 1095, applied only when a policy row exists).
- `purge_evidence_photo_location(capture)` — capturing technician or manager. `purge_evidence_photo_locations_for_member(member)` — manager.
- Erase files: edge action `erase` (SQL authorises, files deleted from storage, `files_erased_at` set). The sealed record (hashes, times, statuses) remains by design so the chain verifies; counsel must confirm this is acceptable for your jurisdictions (hashes cannot recover an image).
- Retention sweep: edge action `maintenance` with header `x-cron-secret`. Schedule (needs `pg_cron` + `pg_net`; not verified here):
  ```sql
  select cron.schedule('photo-provenance-sweep', '17 3 * * *', $$
    select net.http_post(
      url := 'https://<project-ref>.supabase.co/functions/v1/photo-provenance',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer <anon-key>','x-cron-secret','<PHOTO_PROVENANCE_CRON_SECRET>'),
      body := '{"action":"maintenance"}'::jsonb) $$);
  ```
  Set the secret: `supabase secrets set PHOTO_PROVENANCE_CRON_SECRET=<random ≥ 32 chars>`.

## Flag for counsel (not legal advice)
Recording technicians' location can be regulated (employee monitoring, works-council co-determination, GDPR lawful basis/DPIA, state laws on employee location tracking). Consent for employees may not be "freely given". Review before enabling `capture_location`; the code defaults it **off**.

## Public verification link
`/verify/photo/:token` (no login). Token = 64 hex chars (≈ 244 random bits), only its SHA-256 is stored; links expire (1–365 days) and can be revoked. The RPC returns fingerprints, times, source flags, location accuracy class, derivative fingerprints. It never returns images, names, addresses, job labels or coordinates. Visitors can check a file locally (hash computed in the browser).

## Operations
- Deploy order: migration `20281103000000_photo_provenance.sql` → `supabase functions deploy photo-provenance` → front-end.
- Regenerate generated docs: `node scripts/security/function-matrix.mjs --write` and `node scripts/security/rls-audit.mjs --write` (the two new service-role-only tables are intentional: `evidence_photo_locations`, `evidence_photo_shares`).
- Tests: `node --experimental-strip-types --test supabase/functions/_shared/photo-provenance/handler.test.ts`; `npx vitest run src/lib/photoProvenance.test.ts`; `npx playwright test e2e/photo-provenance.spec.ts`.

## Rollback (data-destroying; only if the feature is abandoned)
```sql
-- drop in this order (functions first, then tables); the job_evidence_chain entries sealed by this feature remain in the ledger
drop function if exists public.verify_evidence_photo_share(text), public.evp_retention_sweep(integer), public.evp_mark_files_erased(uuid),
  public.request_evidence_photo_erasure(uuid), public.purge_evidence_photo_locations_for_member(uuid), public.purge_evidence_photo_location(uuid),
  public.revoke_evidence_photo_share(uuid), public.list_evidence_photo_shares(uuid), public.create_evidence_photo_share(uuid,uuid[],integer,text),
  public.get_evidence_photo_summary(uuid), public.save_evidence_photo_settings(boolean,integer,integer), public.get_evidence_photo_settings(),
  public.evp_capture_file_paths(uuid), public.evp_recent_capture_count(uuid), public.evp_register_derivative(uuid,uuid,uuid,text,text,bigint,text,text,integer,integer,jsonb,text),
  public.evp_record_capture(uuid,uuid,uuid,uuid,text,text,bigint,text,text,timestamptz,boolean,timestamptz,jsonb,jsonb),
  public.evp_capture_view(uuid,boolean,jsonb), public.evp_coordinates(uuid), public.evp_location_accuracy(uuid), public.evp_location_commit_ok(uuid),
  public.evp_add_derivative(uuid,uuid,text,text,bigint,text,text,integer,integer,jsonb,text), public.evp_append_ledger(uuid,text,jsonb,jsonb,text,text);
-- then the tables evidence_photo_shares, evidence_photo_locations, evidence_photo_derivatives, evidence_photo_captures, evidence_photo_policies
-- (triggers block DELETE/TRUNCATE; drop the triggers first or drop the tables).
```
