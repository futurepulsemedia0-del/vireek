#!/usr/bin/env node
// scripts/check-privacy-map.mjs — cross-checks docs/store/privacy-data-map.md against what the
// native projects and source code ACTUALLY use, so the store privacy answers cannot drift.
// Usage: node scripts/check-privacy-map.mjs   (exit 1 when a data type is used but undeclared)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const map = read('docs/store/privacy-data-map.md').toLowerCase();
const plist = read('ios/App/App/Info.plist');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const xcprivacy = read('ios/App/App/PrivacyInfo.xcprivacy');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}
const source = walk('src').map(read).join('\n');

const errors = [];
const warnings = [];
const must = (cond, msg) => { if (!cond) errors.push(msg); };

// 1) Permissions → rows that must exist in the map.
const rules = [
  { used: /NSLocation\w*UsageDescription|ACCESS_FINE_LOCATION/.test(plist + manifest), row: 'precise location', xc: 'PreciseLocation' },
  { used: /NSCameraUsageDescription|NSPhotoLibraryUsageDescription|android\.permission\.CAMERA/.test(plist + manifest), row: 'photos', xc: 'PhotosorVideos' },
  { used: /NSMicrophoneUsageDescription|RECORD_AUDIO/.test(plist + manifest), row: 'voice notes', xc: 'AudioData' },
  { used: /@capacitor-firebase\/messaging/.test(source), row: 'push token', xc: 'DeviceID' },
  { used: /@sentry\/capacitor/.test(source), row: 'crash logs', xc: 'CrashData' },
];
for (const r of rules) {
  if (!r.used) continue;
  must(map.includes(r.row), `privacy-data-map.md has no "${r.row}" row, but the app uses it`);
  must(xcprivacy.includes(r.xc), `PrivacyInfo.xcprivacy does not declare ${r.xc}`);
}

// 2) Sensors that are not their own privacy row — confirm they are covered by another one.
if (/NSBluetoothAlwaysUsageDescription|BLUETOOTH_CONNECT/.test(plist + manifest))
  warnings.push('Bluetooth is used: confirm instrument readings only land in "Job notes, form entries" and are not collected separately.');
if (/NFCReaderUsageDescription/.test(plist))
  warnings.push('NFC is used: confirm tag serials are only stored as job/equipment records.');
if (/NSFaceIDUsageDescription/.test(plist))
  warnings.push('Face ID is used: biometrics never leave the device (OS-level check only) — nothing to declare, but keep it that way.');

// 3) Every native SDK imported by the code must be classified, so new SDKs get a privacy review.
const KNOWN = new Set([
  '@capacitor/core', '@capacitor/app', '@capacitor/network', '@capacitor/haptics', '@capacitor/share',
  '@capacitor/splash-screen', '@capacitor/status-bar', '@capacitor/text-zoom',
  '@capacitor-firebase/messaging', '@capacitor-community/in-app-review', '@capawesome/capacitor-badge',
  '@aparajita/capacitor-biometric-auth', '@aparajita/capacitor-secure-storage', '@sentry/capacitor',
  // Reviewed: covered by the Photos / Precise location / Job notes rows (data stays in the user's own job records).
  '@capacitor/camera', '@capacitor/geolocation', '@capacitor/filesystem', '@capacitor-mlkit/barcode-scanning', '@capacitor-community/bluetooth-le',
  // NOT listed on purpose: @capacitor-community/stripe-terminal — payment data needs an explicit privacy decision.
]);
const imported = new Set([...source.matchAll(/from\s+['"]((?:@capacitor|@capawesome|@aparajita|@capacitor-community|@capacitor-firebase|@sentry)[^'"]*)['"]|import\(\s*['"]((?:@capacitor|@capawesome|@aparajita|@capacitor-community|@capacitor-firebase|@sentry)[^'"]*)['"]\s*\)/g)].map((m) => m[1] ?? m[2]));
for (const name of imported) {
  if (!KNOWN.has(name) && !/^@sentry\/(react|browser)$/.test(name)) warnings.push(`SDK "${name}" is imported but not classified in scripts/check-privacy-map.mjs — review its data collection, then add it to KNOWN.`);
}

for (const e of errors) console.log(`✖ ${e}`);
for (const w of warnings) console.log(`! ${w}`);
console.log(errors.length ? `\n${errors.length} undeclared data type(s).` : `\n✔ Privacy map matches the code (${warnings.length} item(s) to confirm).`);
process.exit(errors.length ? 1 : 0);
