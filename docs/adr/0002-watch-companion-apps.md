# ADR 0002 — Apple Watch / Wear OS companion apps: demand and cost

- **Status:** Accepted — **do not build now** (nothing implemented)
- **Scope:** whether to build native watch apps offering only the *Answer* and *Call back* actions
- **Evidence base:** the `vireek-main` snapshot available when this was written. Vendor/platform facts that could not be checked offline are marked **[VERIFY]**.

## 1. Question

`docs/SETUP_MOBILE_SURFACES.md` (section E) states that watch companion apps are **not built**; what exists is the phone's actionable notifications mirrored to the watch. The task rule: write an ADR on demand and cost; implement nothing unless it concludes *yes*, and then only the answer / call-back actions.

## 2. What exists today (verified in the snapshot)

| Item | Evidence |
|---|---|
| iOS notification categories `EMERGENCY_CALL` (Answer / Call back / Dispatch), `MISSED_CALL` (Call back / Assign), `JOB` (Open job); mirrored to a paired Apple Watch by the OS | `docs/SETUP_MOBILE_SURFACES.md` §D.6 |
| Android: up to 3 actions, `WearableExtender` bridging to Wear OS | `android/.../VireekNotifier.java` lines ~56, ~75 |
| Action → screen mapping (`ANSWER` → live calls, `CALLBACK` → calls, `DISPATCH`/`ASSIGN` → dispatch) | `src/lib/native/surfacesCore.ts` `ACTION_PATHS` |
| Every action only **opens a screen on the phone**; nothing dials or writes from a lock screen or watch | `VireekNotifier.java` header comment; `SETUP_MOBILE_SURFACES.md` §E |
| Per-user switch `watch_enabled` ("Apple Watch and Wear OS") | `20280402000000_mobile_surface_prefs.sql`, `MobileSurfacesSettingsPage.tsx` |

**Finding:** `watch_enabled` is stored and shown in settings, but no server or client code reads it (`grep -ri watch` over `supabase/functions/_shared/notify` and `send-push-notification` returns nothing). Switching it off changes nothing today. Not fixed here (out of scope, and the ADR concludes no feature work); tracked in §7.

## 3. Demand

**No demand evidence exists in the repository.**

- No telemetry for notification-action taps (which action, which platform, from phone or watch). The OS reports a tap the same way whether it happened on the watch or the phone, so even a tap counter would not separate them without extra work.
- No record of customers requesting a watch app: nothing in `docs/store/*`, support docs or the roadmap files mentions one beyond the setup note.
- No count of field users who own a watch, and no usage of the existing mirrored actions.

Demand is therefore **unmeasured**, not low. A "yes" cannot be justified on this evidence.

## 4. Cost

Capacitor wraps a web view; neither a watchOS app nor a Wear OS app can be produced from the current React/Capacitor codebase **[VERIFY: Capacitor has no first-party watch support]**. A companion for Answer / Call back means:

1. **Two new native codebases** outside `src/lib/native/*`: a watchOS target (Swift/SwiftUI, Xcode, Mac required) and a Wear OS module (Kotlin or Java, own Gradle module and form-factor release track **[VERIFY: Play requirements for Wear OS apps]**). `ADR-001 — Mobile architecture` says no feature goes native without a table entry and the ownership table would need new rows.
2. **A new security surface.** Today no write happens from a watch. "Answer" and "Call back" from the wrist need either (a) a relay to the phone app (phone must be nearby and unlocked rules apply) or (b) an independent authenticated channel from the watch to Vireek's telephony. (b) means token storage on the watch, tenant-scoped authorization for a new endpoint, and customer phone numbers or names on a wrist. The current design avoids all of that on purpose (names hidden by default, `hide_customer_names`).
3. **Dialling semantics are not solved by a watch app.** "Call back" today opens the calls screen; nothing dials automatically. A watch button that dials needs a product decision on which number/line is used and on consent and call-recording rules **[COUNSEL]**.
4. **Ongoing cost:** two more build/signing/release pipelines in `mobile.yml`, device matrix testing on physical watches (cannot be done in CI), store review for each app, and OS-version churn **[VERIFY: review and signing requirements]**.
5. **Verification limit in this repo:** neither Xcode nor Android Studio builds run in the sandbox used for this ADR; nothing here could be compiled or tested.

No cost figure is given: any number would be invented. The cost is qualitative but large relative to a mirrored notification that already exists.

## 5. Options

| Option | Demand needed | Cost | Verdict |
|---|---|---|---|
| A. Keep mirrored actionable notifications (status quo) | none | none | **Chosen** |
| B. Native watch apps with Answer / Call back | proven, repeated field demand | two native apps + new auth surface (§4) | Rejected for now |
| C. Phone-relay-only watch UI (no independent auth) | same as B | still two native apps; relay adds latency/availability limits | Rejected for now |

## 6. Decision

**No. Do not build Apple Watch or Wear OS apps now, and implement nothing.** The existing mirrored notifications already deliver Answer / Call back / Dispatch / Open job to both watches. There is no measured demand, and the cost is two new native codebases plus a security surface the product deliberately does not have.

## 7. Reopen criteria and cheap preconditions

Revisit only when **all** are true (thresholds are proposals, **[VERIFY with the owner]**):

1. A notification-action analytics event exists (action id, platform, source app version) and has run for at least 90 days. *(Not implemented by this ADR.)*
2. Customers or prospects have asked for a watch app, recorded in one place (support/CRM), at a count the owner considers meaningful.
3. A written decision on dialling, consent and recording for wrist-initiated calls **[COUNSEL]**.
4. Option C or B has a threat-model note covering watch token storage and PII on the wrist.

Small follow-ups that are *not* a watch app and are not done here: make `watch_enabled` actually gate something or remove the toggle, so the setting is not a no-op.

## 8. Verification

Static inspection of the files listed in §2 only. Nothing was built or run; no platform or vendor statement was checked online.
