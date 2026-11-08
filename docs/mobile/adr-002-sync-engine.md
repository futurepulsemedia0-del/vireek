# ADR-002 — Offline sync engine: extend, don't replace (Phase 2)

Date: 2026-11-05 · Status: partly implemented · Basis: static reading of `src/lib/offline/sync.ts`, `src/lib/native/vault.ts`, `src/contexts/AuthContext.tsx`.

## Finding
A single durable outbox engine **already exists** (`sync.ts`): one outbox for forms/capture/notes/photos/time/GPS pings, idempotency via `client_op_id` + batch RPC `sync_technician_batch`, exponential backoff with ±25 % jitter, network errors never give up, cross-tab lock (`navigator.locks`), SW Background Sync, per-user cache scoping, native write-ahead vault. A second engine would violate "extend, never parallel". Phase 2 therefore = close gaps.

## Requirement status
| Requirement | Status | Evidence |
|---|---|---|
| Durable outbox, idempotency keys | exists | `sendChunk`, `finishOp`, deterministic upload path + upsert |
| Ordered replay | **fixed now** (per-job) | `replayOrder.ts`; before, a failed upload let later ops overtake it |
| Retry/backoff/jitter | exists | `backoffMs`, `scheduleRetry` |
| Conflict policy | partial: server decides, benign ones auto-resolved, others parked as `conflict` | `isBenignConflict`; UI to resolve not verified |
| **Encryption at rest (native vault)** | **done now** (AES-256-GCM, key in Keychain/Keystore, legacy files still readable, falls back to old behaviour if keystore unusable) | `vaultCrypto.ts`, `vault.ts` edits |
| IndexedDB copy encrypted | **not done** (WebView storage; needs `db.ts`) | — |
| **Wipe on logout** | **done now** for caches; un-synced work is kept on purpose; explicit discard = `wipeLocalData({includeUnsynced:true})` | `wipe.ts`, `AuthContext.signOut` |
| Wipe on remote revoke / account deletion | **not wired** (function exists; trigger point needs the revoke channel) | — |
| Resumable/chunked uploads | **not done** | single `storage.upload`; needs TUS (`tus-js-client`, 6 MB chunks) — not added because it cannot be verified offline |
| Storage quota management | **not done** | only `navigator.storage.persist()`; needs `outbox.ts`/`db.ts` (enqueue path) |
| UI states + diagnostics screen | **not verified/not done** | `SyncState` exposes online/syncing/pending/failed/conflicts; consumers: `FieldCapturePanel`, `useNetState`, `OfflinePage` |
| Tests: loss mid-upload, duplicates, clock skew, kill during sync, large batches | **not done** | need `db.ts` fakes; `sync.ts` has no test file |

## Missing from the snapshot (blocks the rest)
`src/lib/offline/db.ts`, `outbox.ts`, `store.ts`, `identity.ts` are imported by `sync.ts`/`vault.ts` but absent from the ZIP. Send them to finish quota, IndexedDB encryption, identity wipe, the conflict/diagnostics UI and the sync test suite.

## Known trade-offs
- Un-synced data survives sign-out (only caches wiped). Safer for field data; at-rest protection comes from sealing, not deletion. Counsel/product may require a "discard on sign-out" prompt.
- If the keystore can't persist the key, vault entries are written unsealed (previous behaviour) rather than risking unreadable data.
- Entries sealed under a lost key are skipped on restore (same as a corrupt entry).
