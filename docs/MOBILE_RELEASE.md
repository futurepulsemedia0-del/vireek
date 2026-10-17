# Vireek Field — mobile build & store release

App id `com.vireek.field` · Capacitor 8 · Android (Gradle) + iOS (CocoaPods; ML Kit scanner is not SPM-compatible). iOS needs a Mac.

## One-time setup
1. `npm install`, then `node scripts/codemod-app-origin.mjs` (already applied → "Nothing to change").
2. `npm run build && npx cap add android && npx cap add ios --packagemanager CocoaPods && npm run native:assets && npx cap sync`
3. Apply the native edits (AndroidManifest, Info.plist, AppDelegate) — see the integration notes.
4. Firebase project → Android app `com.vireek.field` → `google-services.json` into `android/app/`; iOS app → `GoogleService-Info.plist` into `ios/App/App/` (add to the App target in Xcode). Upload an APNs Auth Key (.p8) in Firebase → Cloud Messaging.
5. Backend: `supabase db push`; `supabase secrets set FCM_SERVICE_ACCOUNT_JSON='<service-account json>'`; `supabase functions deploy send-push-notification --no-verify-jwt`.
6. Fill `public/.well-known/assetlinks.json` (SHA-256 of Play App Signing + upload key) and `apple-app-site-association` (Team ID), deploy the website.
7. Xcode → App target → Signing & Capabilities: Team, Push Notifications, Background Modes (Location updates, Remote notifications), Associated Domains (`applinks:vireek.com`), Near Field Communication Tag Reading.

## Everyday
- `npm run cap:android` / `npm run cap:ios` — build web, sync, open the IDE.
- After changing plugins or `capacitor.config.ts`: `npx cap sync`.
- Never edit `android/app/src/main/assets/public` or `ios/App/App/public` (generated).

## Android release
1. Keystore (keep it OUT of git, back it up): `keytool -genkeypair -v -keystore vireek-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`
2. Android Studio → Build → Generate Signed App Bundle → release `.aab`. Raise `versionCode` in `android/app/build.gradle` for every upload.
3. Play Console → create app → Play App Signing on → upload `.aab` to Internal testing first.
4. Required forms: Data safety (location, photos, audio, device ID/push token, account info); Foreground service permissions → type "location" (dispatch trip sharing, short demo video); target audience/content rating. The app does NOT request `ACCESS_BACKGROUND_LOCATION` (foreground service covers locked-screen tracking), so no background-location review.
5. Copy the SHA-256 of the Play App Signing key into `assetlinks.json`, redeploy the site, check: `adb shell pm get-app-links com.vireek.field`.

## iOS release
1. Xcode → Product → Archive → Distribute App → App Store Connect. Raise `CURRENT_PROJECT_VERSION` for every upload; `MARKETING_VERSION` = user-facing version.
2. TestFlight internal test first.
3. App Store Connect: privacy nutrition labels (location, photos/videos, audio, identifiers, contact info), review notes with a demo technician login, justification for background location ("dispatch sees the technician's trip while on a job"), and NFC usage.
4. Screenshots: 6.9" and 6.5" iPhone (+ iPad if enabled).

## Release checklist
- [ ] Sign in survives app restart and phone reboot (Keychain / Keystore).
- [ ] Push arrives with the app closed on both platforms; tapping opens the right screen.
- [ ] `https://vireek.com/tech/today` opens the app from Messages/Notes; `vireek://tech/today` works.
- [ ] Password-reset email link opens the app on the reset screen.
- [ ] Photo / barcode / NFC / voice note work; permission denial shows the message.
- [ ] Airplane mode → capture → reconnect syncs (vault).
- [ ] GPS trail keeps recording with the screen locked.
- [ ] Shared links (booking, tracking, sign) use `https://vireek.com/...`.
