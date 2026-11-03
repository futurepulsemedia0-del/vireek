# Vireek mobile surfaces — setup (phases 2–5)

Everything below is written against the uploaded zip. Verify each Ctrl+F string in your local copy first.
Status legend used in the report: PASSED = executed here · NOT RUN = needs your machine · BLOCKED = needs Xcode / Android Studio / a device.

## A. Backend (order matters)
1. Run `20280402000000_mobile_surface_prefs.sql` (phase 1), then `20280402000100_live_surfaces.sql` in the Supabase SQL editor.
2. Copy `supabase/functions/_shared/notify/{mobilePayload,liveSurface,apns}.ts` and `supabase/functions/live-surface-dispatch/index.ts`.
3. **fcm.ts**: paste `fcm_patch_append.ts` at the very END of `supabase/functions/_shared/notify/fcm.ts` (phase-1 edits stay).
4. **send-push-notification/index.ts**
   a. Change the import line  `import { isFcmConfigured, sendFcm } from "../_shared/notify/fcm.ts";`  to
      `import { isFcmConfigured, sendFcm, sendFcmData } from "../_shared/notify/fcm.ts";`
      and the phase-1 import to `import { buildMobilePayload, DEFAULT_PREFS, versionAtLeast, type MobilePrefs } from "../_shared/notify/mobilePayload.ts";`
   b. In `interface DeviceTokenRow` add after `token: string;`:   `platform: string; app_version: string | null;`
   c. Find `.select("id, token, subscriber_user_id")` (the device_push_tokens query) → `.select("id, token, subscriber_user_id, platform, app_version")`
   d. Replace the whole `const result = await sendFcm(device.token, { ... });` statement (phase-1 version) with:
```ts
          const androidActions = device.platform === "android"
            && versionAtLeast(device.app_version, Deno.env.get("ANDROID_DATA_ALERTS_MIN_VERSION"));
          const result = androidActions
            ? await sendFcmData(device.token, {
                kind: "alert", title: mp.title, body: mp.body, url, tag,
                severity: mp.severity, category: mp.category, haptic: mp.haptic,
              }, { androidChannel: mp.androidChannel })
            : await sendFcm(device.token, {
                title: mp.title, body: mp.body, url, tag,
                androidChannel: mp.androidChannel, interruptionLevel: mp.interruptionLevel,
                category: mp.category, severity: mp.severity, haptic: mp.haptic,
              });
```
   The gate fails closed: Android devices get the old notification message until `ANDROID_DATA_ALERTS_MIN_VERSION` is set,
   so old app versions never go silent. Set it ONLY after the new Android build is live:
   `supabase secrets set ANDROID_DATA_ALERTS_MIN_VERSION=1.1.0` (use the versionName you ship).
5. Secrets for iOS Live Activities (optional; iOS Live Activities are skipped without them):
   `supabase secrets set APNS_KEY_P8="$(cat AuthKey_XXXX.p8)" APNS_KEY_ID=XXXX APNS_TEAM_ID=YYYY APNS_BUNDLE_ID=com.vireek.field APNS_ENV=production`
   (use `APNS_ENV=sandbox` for Xcode-installed debug builds).
6. `supabase functions deploy live-surface-dispatch --no-verify-jwt`  (it checks `x-push-dispatch-secret` itself).
   `app.settings.edge_function_base_url` and `app.settings.push_dispatch_secret` are already used by the push trigger; nothing new to set.

## B. Web edits
1. New files: `src/lib/native/surfacesCore.ts`, `surfacesCore.test.ts`, `surfaces.ts` (+ phase-2 files).
2. **src/lib/native/push.ts** — find `m.addListener('notificationActionPerformed'` and replace that whole listener with:
```ts
    m.addListener('notificationActionPerformed', ({ actionId, notification }) => {
      const path = resolveActionPath(actionId, extractNotificationUrl(notification.data));
      if (path) h.onOpen(path);
    }),
```
   and add at the top: `import { resolveActionPath } from './surfacesCore';`
3. **src/components/native/NativeBridge.tsx** — add import `import { startSurfaceBridge } from '@/lib/native/surfaces';`
   and, right above `// Keep this device's token attached to whoever is signed in`, add:
```tsx
  // Widgets snapshot, Live Activity tokens and Siri-queued links (iOS/Android native only).
  useEffect(() => {
    if (!isNative() || !userId) return undefined;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void startSurfaceBridge(open).then((s) => (cancelled ? s() : (stop = s)));
    return () => { cancelled = true; stop?.(); };
  }, [userId, open]);
```
   (`surfaces.ts` already re-syncs the push token on every resume, which replaces the plugin's token-rotation listener on Android.)
4. **src/contexts/AuthContext.tsx** — in `signOut` (find `await supabase.auth.signOut();`) add on the line BEFORE it:
   `void import('@/lib/native/surfaces').then((m) => m.clearSurfaceSnapshot()).catch(() => undefined);`
   so widgets never show a signed-out person's data.

## C. Android (Android Studio)
1. Copy the files under `android/app/src/main/...` (java, res). Phase-2 `VireekNotificationChannels.java` stays.
2. **MainActivity.java**: add `registerPlugin(VireekSurfacesPlugin.class);` as the FIRST line of `onCreate`, before `super.onCreate(savedInstanceState);`.
3. **Find the plugin's own messaging service** (only one service may receive `MESSAGING_EVENT`):
   `grep -rn "MESSAGING_EVENT" node_modules/@capacitor-firebase/messaging/android/src/main/AndroidManifest.xml -B3`
   Note its `android:name`, call it PLUGIN_SERVICE.
4. **AndroidManifest.xml** — add `tools:` already declared. Inside `<application>` (after the `<meta-data ... default_notification_color>` line):
```xml
        <service android:name="PLUGIN_SERVICE" tools:node="remove" />
        <service android:name=".VireekMessagingService" android:exported="false">
            <intent-filter><action android:name="com.google.firebase.MESSAGING_EVENT" /></intent-filter>
        </service>
        <receiver android:name=".VireekSnoozeReceiver" android:exported="false" />

        <receiver android:name=".VireekWidgets$TodayWidget" android:exported="false" android:label="Today">
            <intent-filter><action android:name="android.appwidget.action.APPWIDGET_UPDATE" /></intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/widget_today" />
        </receiver>
        <receiver android:name=".VireekWidgets$NextJobWidget" android:exported="false" android:label="Next job">
            <intent-filter><action android:name="android.appwidget.action.APPWIDGET_UPDATE" /></intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/widget_nextjob" />
        </receiver>
        <receiver android:name=".VireekWidgets$OnCallWidget" android:exported="false" android:label="On call">
            <intent-filter><action android:name="android.appwidget.action.APPWIDGET_UPDATE" /></intent-filter>
            <meta-data android:name="android.appwidget.provider" android:resource="@xml/widget_oncall" />
        </receiver>
```
   Inside the LAUNCHER `<activity>` (after its closing `</intent-filter>` for MAIN/LAUNCHER) add:
   `<meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />`
   Known tradeoff: with the plugin's service removed, a push that arrives while the app is OPEN no longer fires the in-app toast on Android
   (the system notification still appears). Wear OS receives the same notification and its actions through Android's built-in bridging.
5. **android/app/build.gradle** `dependencies { ... }`: if the build says it cannot find `com.google.firebase.messaging`, add
   `implementation 'com.google.firebase:firebase-messaging'` (the plugin normally supplies it).
6. Google Assistant: upload to Play Console internal testing, then test with the "Google Assistant plugin for Android Studio" (App Actions Test Tool). Only OPEN_APP_FEATURE navigation is declared; write actions are intentionally absent.

## D. iOS (Xcode; Mac required)
1. Copy `ios/App/App/*.swift` into the App group of the project, tick Target Membership = App. Tick BOTH App and VireekWidgets for `VireekShared.swift`.
2. Main.storyboard → the Capacitor view controller scene → Identity inspector → Custom Class = `VireekBridgeViewController`, Module = `App`.
3. File → New → Target → Widget Extension, name `VireekWidgets`, tick "Include Live Activity" = off (we provide ours), Embed in App. Delete the generated .swift, add `VireekWidgets/VireekWidgets.swift`, replace its Info.plist with ours. Set the extension's iOS Deployment Target to 16.2. Bundle id: `com.vireek.field.VireekWidgets`.
4. Signing & Capabilities, on BOTH targets: **App Groups** → `group.com.vireek.field`. On App only: Push Notifications (exists), **Time Sensitive Notifications**.
   Do NOT enable Critical Alerts (see decision below).
5. **Info.plist (App)**: add inside `<dict>`:  `<key>NSSupportsLiveActivities</key><true/>`
6. **AppDelegate.swift**: add `import UserNotifications` at top; in `didFinishLaunchingWithOptions`, before `return true`:
```swift
        func act(_ id: String, _ title: String) -> UNNotificationAction { UNNotificationAction(identifier: id, title: title, options: [.foreground]) }
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: "EMERGENCY_CALL", actions: [act("ANSWER", "Answer"), act("CALLBACK", "Call back"), act("DISPATCH", "Dispatch")],
                                   intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: "Emergency call", options: []),
            UNNotificationCategory(identifier: "MISSED_CALL", actions: [act("CALLBACK", "Call back"), act("ASSIGN", "Assign")],
                                   intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: "Missed call", options: []),
            UNNotificationCategory(identifier: "JOB", actions: [act("OPEN_JOB", "Open job")],
                                   intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: "Job update", options: []),
        ])
```
   These actions also appear on a paired Apple Watch automatically. There is no inline Snooze on iOS: it would need our own
   UNUserNotificationCenter delegate, which Capacitor/Firebase already own, and a conflict would break push taps.
7. Firebase/APNs: unchanged (existing .p8 in Firebase). The SAME key can be used for APNS_KEY_P8 above (enable "Apple Push Notifications service" for the key).
8. `npx cap sync ios`, build to a simulator for the compile check.

## E. Decisions and honest limits
- **Critical Alerts: not requested.** Time-Sensitive breaks through Focus/Scheduled Summary and is enough for "call someone back".
  Apple grants Critical Alerts (bypassing the mute switch and DND) only for life-safety-type apps and reviews the justification; request
  it later with a written case only if emergency pages must ring on silent.
- **Apple Watch / Wear OS companion apps: not built.** What exists: actionable notifications mirrored to both watches (Answer / Call back /
  Dispatch / Open job). Custom haptic patterns per severity need a native watch app; on Android the channel vibration pattern is
  used on the phone, and the watch applies its own. Tap-to-call = tap "Call back" → opens the calls screen on the phone; nothing dials automatically.
- **Siri / Assistant**: read-only answers come from the snapshot, which contains no customer names, phones or addresses. "Call my last missed
  customer" and "Mark job complete" only open the right screen (unlocked phone required); the confirmation happens in the app.
- **Android lock-screen widgets** don't exist on phones; Android gets home-screen widgets + an ongoing notification with a live timer.
  iOS gets home + lock-screen widgets and the Live Activity.
- Widgets don't poll. They update when the app writes a snapshot (open / resume / sign-in) and show "Updated N h ago" after 6 h.
- Currency in widgets: Android uses USD formatting, iOS uses the phone's region currency. Change if Vireek bills outside the US.
- iOS 16.2–17.1: Live Activities can't be started remotely (push-to-start needs 17.2); they start when the app opens.
- `NSSupportsLiveActivitiesFrequentUpdates` is not enabled: updates are state changes (start / handoff / end), the timer runs on-device.

## F. CI (append to .github/workflows/mobile.yml under `jobs:`)
```yaml
  surfaces-unit:
    name: Surfaces unit tests
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - run: npx vitest run src/lib/native
      - run: node --experimental-strip-types supabase/functions/_shared/notify/mobilePayload.test.mjs
      - run: node --experimental-strip-types supabase/functions/_shared/notify/liveSurface.test.mjs
```
Also in the existing `ios-compile-check` job add after "Build for simulator":
```yaml
      - name: Widget extension was built and embedded
        run: |
          APPEX=$(find ~/Library/Developer/Xcode/DerivedData -name 'VireekWidgets.appex' -path '*iphonesimulator*' | head -1)
          test -n "$APPEX" || { echo "::error::VireekWidgets.appex missing"; exit 1; }
```
and for Android, in `android-bundle` after "Sync Capacitor" add `- run: ./gradlew lintRelease --no-daemon` with `working-directory: android` to compile-check the new Java and resources.
(The `.mjs` test files are the ones run here; move them to vitest if you prefer.)

## G. What must be tested on physical devices
| # | Check | Where |
|---|---|---|
| 1 | Emergency push arrives with app killed; lock screen shows "Emergency call" and NO name; tapping opens live-calls | iPhone + Android |
| 2 | Turn "Hide customer names" off → name appears; on → hidden again | both |
| 3 | iOS: Answer / Call back / Dispatch actions visible by long-press and on Apple Watch; each opens the right screen | iPhone + Watch |
| 4 | Android: 3 actions on the heads-up card and on Wear OS; Snooze re-posts after ~10 min | Android + Wear |
| 5 | Live Activity starts on a new live_calls row (17.2+), timer counts, "handing off" updates, ends with "Call ended" and disappears | iPhone |
| 6 | Android ongoing notification shows a counting timer and disappears at call end | Android |
| 7 | Focus mode: Time-Sensitive alert breaks through; turning off the setting stops that | iPhone |
| 8 | Widgets: signed-out shows "Open Vireek"; after sign-in values appear; airplane mode keeps last values; >6 h shows "Updated"; dark mode; largest Dynamic Type / font scale | both |
| 9 | Sign out clears widgets | both |
| 10 | Siri phrases (4), including on a locked phone: read-only answers work, the other two require unlock | iPhone |
| 11 | Assistant "open my schedule / who is on call" | Android |
| 12 | Cross-account: sign in as a different owner on the same phone → no old snapshot, no old Live Activity | both |
Simulator-testable: widget layouts and timelines (Xcode previews), deep links (`xcrun simctl openurl booted vireek://tech/today`), push payloads
(`xcrun simctl push booted com.vireek.field payload.apns`), Android widget layout and channels.
