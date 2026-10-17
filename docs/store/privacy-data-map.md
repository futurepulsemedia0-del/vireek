# Privacy data map — App Store "App Privacy" labels + Google Play "Data safety"

Derived from the app's code and permissions. Have the owner of the privacy policy confirm it against the real data flows and https://vireek.com/subprocessors before submitting. `ios/App/App/PrivacyInfo.xcprivacy` mirrors the Apple column.

| Data | Why | Linked to user | Tracking | Apple type | Google type |
| --- | --- | --- | --- | --- | --- |
| Name, email | Account, job assignment | Yes | No | Name, Email Address | Personal info → Name, Email |
| Account / user id | Sign-in, sync | Yes | No | User ID | Personal info → User IDs |
| Push token | Deliver notifications | Yes | No | Device ID | Device or other IDs |
| Precise location | Photo location stamp, trip sharing with dispatch | Yes | No | Precise Location | Location → Precise |
| Photos | Job documentation | Yes | No | Photos or Videos | Photos and videos → Photos |
| Voice notes | Job notes | Yes | No | Audio Data | Audio → Voice or sound recordings |
| Job notes, form entries | Job records | Yes | No | Other User Content | App activity → Other user-generated content |
| Crash logs, performance | Fix crashes, keep app fast (Sentry) | Yes (user id) | No | Crash Data, Performance Data | App info and performance → Crash logs, Diagnostics |

## Google Play Data safety answers
- Data collected: yes (all rows above). Data shared with third parties: **No** for functionality (Supabase hosting, Firebase push delivery and Sentry act as service providers on Vireek's behalf) — confirm wording with counsel.
- Data encrypted in transit: **Yes** (HTTPS). Users can request deletion: **Yes** — in-app (Settings → Security → Delete my account) and web: https://vireek.com/contact
- Location and camera/mic permissions are optional features (requested at use); account data is required.
- Foreground service permission (location): declare type "Location", core feature = trip sharing with dispatch; attach a short screen recording of starting a trip with the persistent notification.
- The app does not request ACCESS_BACKGROUND_LOCATION.

## Apple App Privacy answers
- Data used to track you: **None**. Data linked to you: the rows above. Data not linked: none.
- Privacy policy URL: https://vireek.com/privacy · Account deletion available in-app.
