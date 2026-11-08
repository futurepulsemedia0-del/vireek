# ADR-001 — Mobile architecture (Field, Home, PWA)

Status: proposed · Date: 2026-11-05 · Owner: mobile platform

## Context
One React/Vite codebase ships three surfaces: PWA/web, **Vireek Field** (`com.vireek.field`, Capacitor, project `android/` + `ios/`) and **Vireek Home** (`com.vireek.home`, `VIREEK_APP=home`, projects `android-home/` + `ios-home/`, not yet in the repo). Evidence: `capacitor.config.ts`, `scripts/cap-home.mjs`.

## Decisions
1. **Native only where the browser cannot do the job**; everything else stays web content inside the shell.
   - Native (via `src/lib/native/*`): push (FCM/APNs), background location, camera/ML Kit scanner, NFC, Bluetooth, Stripe Terminal, Keychain/Keystore storage, biometric lock, share, haptics, widgets/intents (Swift/Java), Sentry native crashes.
   - Web: all screens, forms, i18n, billing UI, admin. No new feature goes native without an entry in the table below.
2. **Shared-code boundary.** `src/lib/native/*` is the only place that imports Capacitor plugins (enforced by `mobile:doctor` import scan; ESLint rule to follow in Phase 5). UI calls these wrappers, which no-op on web. Field-only plugins (background geolocation, NFC, Stripe Terminal, barcode, Bluetooth) must be dynamically imported so Home's bundle does not pay for them; Home gets its own entry and `dist-home`.
3. **Per-app / per-platform feature flags.** Reuse the existing flag platform (`featureFlags.ts`); add context keys `app` (`field|home|web`) and `platform` (`ios|android|web`). Native-capability flags default **off** and are enabled per build, never by remote config alone (store review must see the same behaviour).
4. **Native projects are committed** (see build-integrity.md); verification replaces regeneration.
5. **Minimum OS.** Follow the Capacitor 8 template minimums (`android/variables.gradle` `minSdkVersion`, Podfile/pbxproj deployment target); do not raise them without crash/usage data. *Value not verifiable here: those files are absent from the snapshot.* Store rules constrain the **build SDK/target** (Android target 36, Xcode 26/iOS 26 SDK), not the supported OS floor.
6. **OTA/live updates** only for JS/assets, same primary purpose, version-compatibility gated (Phase 8).

## Native-capability ownership
| Capability | Plugin / code | Field | Home |
|---|---|---|---|
| Push | `@capacitor-firebase/messaging`, `VireekMessagingService` | yes | yes (own topic/bundle) |
| Background location | `@capgo/background-geolocation` | yes | no |
| Camera/scanner/NFC/BLE | camera, mlkit, `@capgo/capacitor-nfc`, bluetooth-le | yes | camera only |
| Payments (Tap to Pay) | `@capacitor-community/stripe-terminal` | where applicable | no |
| Secure storage/biometrics | `@aparajita/*` | yes | yes |

Consequence: Home must not inherit Field's background-location, NFC or Bluetooth permissions (store labels and review risk).
