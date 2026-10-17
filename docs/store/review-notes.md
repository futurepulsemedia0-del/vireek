# App Review notes (paste into App Store Connect → App Review Information → Notes; adapt for Play "App access")

Replace every REPLACE_ value before submitting (`npm run mobile:preflight` warns while any is left).

```text
Vireek Field is the technician companion app of the Vireek platform (https://vireek.com). It requires an account created by a company administrator, so please use the demo account below.

DEMO ACCOUNT
Email: REPLACE_DEMO_EMAIL
Password: REPLACE_DEMO_PASSWORD
(The account has sample jobs, so every screen is populated. No 2-step verification is required for this account.)

HOW TO TEST
1. Sign in → the "Today" screen lists the assigned jobs. Open any job.
2. Take a photo, record a voice note, scan an equipment barcode (any barcode works). NFC tags are optional.
3. Turn on airplane mode, capture a photo, turn it off: the capture syncs automatically.
4. Settings → Security: "App lock" (Face ID / passcode) and "Delete my account" (in-app account deletion).

WHY THE APP IS NOT JUST A WEBSITE (Guideline 4.2)
The app uses native capabilities that a website cannot: push notifications, background location for trip sharing, camera and microphone capture with an on-device offline queue that syncs later, NFC and barcode scanning, secure Keychain session storage and Face ID app lock.

BACKGROUND LOCATION (UIBackgroundModes: location)
While a technician is on a job and has started a trip, the app shares their position with the dispatch office so customers receive accurate arrival times. Location is requested only when the technician starts a trip, a blue status indicator is shown by iOS, and sharing stops when the trip ends. Location is not used for advertising or sold.

NFC
NFC reading is used only to identify equipment tags during a job.

ACCOUNT DELETION
Settings → Security → "Delete my account" permanently deletes the account and data (Guideline 5.1.1(v)).

Contact: support@vireek.com
```
