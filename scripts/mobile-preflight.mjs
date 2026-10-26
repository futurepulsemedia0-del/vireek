#!/usr/bin/env node
// scripts/mobile-preflight.mjs — pre-submission gate for the native app.
// Run: npm run mobile:preflight   (exit code 1 = blocking problem, warnings never fail)
import { existsSync, readFileSync } from 'node:fs';

const errors = [];
const warnings = [];
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const must = (cond, msg) => { if (!cond) errors.push(msg); };
const should = (cond, msg) => { if (!cond) warnings.push(msg); };

const plist = read('ios/App/App/Info.plist');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const gradle = read('android/app/build.gradle');
const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
const cfg = read('capacitor.config.ts');

must(plist, 'ios/ is missing — run: npx cap add ios --packagemanager CocoaPods');
must(manifest && gradle, 'android/ is missing — run: npx cap add android');
const appId = cfg?.match(/appId:\s*'([^']+)'/)?.[1];
must(appId, 'capacitor.config.ts: appId not found');

if (plist) {
  for (const key of [
    'NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription', 'NSMicrophoneUsageDescription',
    'NSLocationWhenInUseUsageDescription', 'NSLocationAlwaysAndWhenInUseUsageDescription',
    'NFCReaderUsageDescription', 'NSBluetoothAlwaysUsageDescription','NSFaceIDUsageDescription', 'ITSAppUsesNonExemptEncryption', 'UIBackgroundModes',
  ]) must(plist.includes(`<key>${key}</key>`), `Info.plist: missing ${key}`);
  must(!plist.includes('<string>armv7</string>'), 'Info.plist: UIRequiredDeviceCapabilities still lists armv7 (use arm64)');
  must(existsSync('ios/App/App/PrivacyInfo.xcprivacy'), 'ios/App/App/PrivacyInfo.xcprivacy is missing');
  must(pbx?.includes('PrivacyInfo.xcprivacy'), 'PrivacyInfo.xcprivacy is not added to the Xcode App target (Xcode → right-click App → Add Files…)');
  should(existsSync('ios/App/App/GoogleService-Info.plist'), 'ios/App/App/GoogleService-Info.plist missing — iOS push will not work');
}

if (manifest) {
  for (const p of ['CAMERA', 'RECORD_AUDIO', 'BLUETOOTH_SCAN', 'BLUETOOTH_CONNECT','ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION']) {
    must(manifest.includes(`android.permission.${p}`), `AndroidManifest: missing ${p}`);
  }
  must(!manifest.includes('ACCESS_BACKGROUND_LOCATION'), 'AndroidManifest: ACCESS_BACKGROUND_LOCATION triggers Play background-location review — the foreground service is enough');
  must(manifest.includes('android:allowBackup="false"'), 'AndroidManifest: allowBackup must be "false" (session data)');
  must(manifest.includes('android:autoVerify="true"'), 'AndroidManifest: verified App Links intent-filter missing');
  must(manifest.includes('android:scheme="vireek"'), 'AndroidManifest: vireek:// scheme intent-filter missing');
  must(manifest.includes('ic_stat_vireek'), 'AndroidManifest: notification icon meta-data missing');
  should(existsSync('android/app/google-services.json'), 'android/app/google-services.json missing — Android push will not work');
}

if (gradle && appId) {
  must(gradle.match(/applicationId\s+"([^"]+)"/)?.[1] === appId, 'applicationId in android/app/build.gradle differs from capacitor.config.ts appId');
  must(gradle.includes('signingConfigs'), 'build.gradle: release signing config missing');
}

for (const [file, token] of [['public/.well-known/assetlinks.json', 'sha256'], ['public/.well-known/apple-app-site-association', 'appIDs']]) {
  const body = read(file);
  must(body, `${file} is missing`);
  if (body) {
    must(!body.includes('REPLACE_'), `${file}: replace the REPLACE_ placeholders (universal links stay broken otherwise)`);
    if (appId) must(body.includes(appId), `${file}: does not reference ${appId} (${token})`);
  }
}

// @sentry/capacitor needs the exact @sentry/react it was built against.
const peer = JSON.parse(read('node_modules/@sentry/capacitor/package.json') ?? '{}').peerDependencies?.['@sentry/react'];
const have = JSON.parse(read('node_modules/@sentry/react/package.json') ?? '{}').version;
if (peer && have) must(peer === have, `@sentry/react is ${have} but @sentry/capacitor requires exactly ${peer}`);

// Store copy: every "### Title (max N)" block must fit its limit.
const listing = read('docs/store/listing.md');
must(listing, 'docs/store/listing.md is missing');
if (listing) {
  for (const m of listing.matchAll(/^### (.+?) \(max (\d+)\)\n+```[a-z]*\n([\s\S]*?)\n```/gm)) {
    const [, title, max, text] = m;
    must([...text].length <= Number(max), `listing.md: "${title}" is ${[...text].length} chars (max ${max})`);
  }
}
for (const f of ['docs/store/review-notes.md']) {
  should(!(read(f) ?? '').includes('REPLACE_'), `${f}: fill in the REPLACE_ values (demo account) before submitting`);
}

for (const e of errors) console.log(`✖ ${e}`);
for (const w of warnings) console.log(`! ${w}`);
console.log(errors.length ? `\n${errors.length} blocking problem(s), ${warnings.length} warning(s).` : `\n✔ Ready for submission checks (${warnings.length} warning(s)).`);
process.exit(errors.length ? 1 : 0);
