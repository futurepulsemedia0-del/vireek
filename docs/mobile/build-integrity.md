# Mobile build integrity (Phase 0)

Status date: 2026-11-05. Evidence below is from static inspection + one executed script run on the uploaded ZIP.
No network, no Xcode, no Android SDK were available: **no build was executed**. CI logs: *not verifiable here*.

## Verified facts (ZIP snapshot)
| Claim | Result | Evidence |
|---|---|---|
| package.json declares no Capacitor/native packages | **REAL in snapshot** | `mobile:doctor` → 27 errors; `grep` finds 0 `node_modules/@capacitor` entries in package-lock.json |
| Imported but undeclared | **21 packages, more than the brief listed** | incl. `@capgo/background-geolocation`, `@capacitor/{share,haptics,camera,text-zoom}`, `@capacitor-firebase/messaging`, `@capacitor-community/{bluetooth-le,in-app-review}`, `@sentry/capacitor`, `@aparajita/capacitor-{secure-storage,biometric-auth}`, `@capgo/capacitor-nfc` (brief's names `capacitor-nfc`, `capacitor-secure-storage`, `capacitor-biometric-auth` are not what the code imports) |
| ios/ has no .xcodeproj/Podfile | **REAL in snapshot**; also has VireekIntents/VireekSurfacesPlugin/VireekWidgets | `find ios` |
| android/ has no root Gradle files | **REAL in snapshot**; also has Java sources, shortcuts, notifier | `find android` |
| `ios-home/`, `android-home/` | **do not exist** (not in ZIP) | `ls` |
| One Maestro flow | **REAL** (`e2e/mobile/01-launch-and-login.yaml`) | `ls` |
| Existing CI can build from clean clone | **No**: `mobile.yml` runs `cap sync android` + `./gradlew` with no root Gradle project and no declared plugins | `.github/workflows/mobile.yml` |
| Capacitor major | docs say **8** (`docs/MOBILE_RELEASE.md`); nothing in package.json enforces it | |

Whether the real repo has the generated native files cannot be known from the ZIP. The doctor (`--native`) answers this on any checkout.

## Decisions
1. **Commit the generated native projects** (`android/`, `ios/`, later `ios-home/`, `android-home/`) with Capacitor's own .gitignore rules. Reason: Vireek's custom Swift/Java/Info.plist/manifest edits live inside them and the Xcode target membership (PrivacyInfo, Swift files) cannot be re-created by a script reliably. Regeneration is therefore not the strategy; verification is (doctor `--native` + CI build).
2. **Exact pins** for every native package and `@sentry/react` (enforced by doctor); lockfile must match.
3. **Capacitor 8**, one major for core/cli/android/ios/official plugins (enforced). Upgrade plan: bump all `@capacitor/*` together on a branch, `npm install`, `npx cap migrate`, run the 3 CI jobs, Maestro smoke, then release train.
4. Node version from `.nvmrc`; doctor compares it with `@capacitor/cli` `engines.node` once installed.

## Commands (run once, locally)
See the delivery message; after them: `npm run mobile:doctor -- --native --app field` must print ✔.

## Open items
- Home native projects: create with `npm run cap:home -- add android|ios`, re-apply Home-specific files, commit; then remove `continue-on-error` for `home` in `.github/workflows/mobile-build-integrity.yml`.
- `@capgo/background-geolocation` replaces the legacy-bridge dependency only if verified on device (Phase 3).
- CI secrets for web build (`VITE_*`) in fork PRs are empty; whether `npm run build` tolerates that is **not verified**.
