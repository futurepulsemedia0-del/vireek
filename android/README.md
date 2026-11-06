# Android (Capacitor)

App id `com.vireek.field` (`android/app/build.gradle`, `capacitor.config.ts`). A second app, **Vireek Home** (`com.vireek.home`, `android-home/`, web dir `dist-home`), is selected by the `isHome` branch of `capacitor.config.ts` (`npm run cap:home`).

- Build, signing and Play Console steps: **[`docs/MOBILE_RELEASE.md`](../docs/MOBILE_RELEASE.md)** (single source of truth — do not duplicate here).
- Store listing, review notes and privacy data map: `docs/store/*`.
- Daily commands: `npm run cap:android` (build web + sync + open Android Studio); after plugin or config changes `npx cap sync`.
- Do **not** edit `android/app/src/main/assets/public` (generated). Keep the upload keystore out of git and backed up.
- Permissions rationale (from `MOBILE_RELEASE.md`): foreground location service for dispatch trip sharing; the app does not request `ACCESS_BACKGROUND_LOCATION`. Re-verify against `AndroidManifest.xml` before each release (`npm run mobile:preflight`).
- Increase `versionCode` for every Play upload.
