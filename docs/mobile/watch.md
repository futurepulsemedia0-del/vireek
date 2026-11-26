# Watch scope — Apple Watch / Wear OS (minimal)

Status: scope + phone-side handler implemented; native work open · Owner: TODO(owner)

## Scope (v1, deliberately small)
| Need | v1 | How |
|---|---|---|
| Job alert on wrist | yes | OS mirrors the phone's push to the watch — **no watch app required** |
| "On my way" (`en_route`) | yes | notification action → `runPushJobAction` → outbox `status` op |
| "Start" (`start` → `in_progress`) | yes | same |
| "Complete" | **opens the job on the phone** | `DIRECT_COMPLETE_ENABLED=false` until TODO(owner) confirms no signature/checklist is required |
| "Arrive" | **not built** | no `arrived` status exists in `JobStatus`; decision TODO(owner): map to a new status, or to a timestamp on `en_route` |
| Standalone watch app, complications, watch GPS | out of scope | revisit with usage data |

## What exists in code
- `src/lib/native/pushJobActions.ts` — validates the action, extracts the job id from `data.url` (`/tech/job/<uuid>` on vireek.com only), checks the job is in this technician's local bundle, forward-only status, de-duplicates taps, queues through the existing outbox (works offline, idempotent via `client_op_id`).
- `src/lib/native/push.ts` — `notificationActionPerformed` now forwards non-`tap` action ids via `onAction`.
- `src/components/native/NativeBridge.tsx` — connects `onAction` to the outbox.

## Native / server work left (not done, cannot be verified here)
1. **iOS**: register a `UNNotificationCategory` (e.g. `JOB_ALERT`) with actions `en_route`, `start`, `complete` (title strings localized); watchOS shows them automatically. TODO(owner): Swift owner.
2. **Android**: add the same three `NotificationCompat.Action`s in `VireekMessagingService`; set `WearableExtender` if wanted. Actions must route back to the app's FCM plugin so `notificationActionPerformed` fires with `actionId`.
3. **Server**: `send-push-notification` must send the category (`JOB_ALERT`) for job-assignment notifications and keep `data.url` = `/tech/job/<id>`. Today it sends `url` and `category` from `buildMobilePayload`; confirm the category value matches the native one.
4. Background execution: iOS may deliver the action only after the app is woken; test cold-start (app killed) — the handler runs when the JS bridge starts, the queued op then syncs normally.
5. Real-device matrix: iPhone+Watch, Pixel+Pixel Watch. TODO(owner): devices.
6. Store/privacy: no new data types are collected; re-check privacy labels if watch location is ever added.

## Acceptance
- Tapping Start with no signal queues one `status` op; syncing sends it once.
- Second tap does nothing. Tapping on a notification for another account does nothing.
- Complete opens the job screen.
